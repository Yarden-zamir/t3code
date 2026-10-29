/**
 * Fork: the tunnel of a machine map portal join: host and Access values in
 * `machine-map-tunnel.json`, token in the secret store. Known limit: it serves the host until the
 * handover to kitshn (K-1623). Remove this file once every host moved to kitshn.
 */
import * as RelayClient from "@t3tools/shared/relayClient";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as KitshnProvider from "./kitshn/KitshnProvider.ts";

const TOKEN_SECRET_NAME = "machine-map-tunnel-token";
/** Written once the host moved to kitshn; the portal tunnel never starts again after it. */
const RETIRED_FILE = "machine-map-tunnel-retired";
/**
 * K-1623: kitshn moves the host's DNS record a minute after it made its application and ingress,
 * so the portal tunnel keeps serving this long after kitshn names its application.
 */
const RETIRE_AFTER = Duration.minutes(10);
/** A pause after each exit, so a broken token or download does not spin. */
const RESTART_DELAY = Duration.seconds(10);

const PortalTunnel = Schema.Struct({
  hostname: Schema.String,
  access: Schema.Struct({ teamDomain: Schema.String, aud: Schema.String }),
});
const decodePortalTunnel = Schema.decodeUnknownEffect(fromLenientJson(PortalTunnel));

/** The saved portal tunnel, or undefined. A file that does not decode logs and counts as none. */
export const readPortalTunnel = Effect.fn("portalTunnelFile.read")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(stateDir, "machine-map-tunnel.json");
  if (!(yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) {
    return undefined;
  }
  return yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodePortalTunnel),
    Effect.map((tunnel) => ({ origin: `https://${tunnel.hostname}`, access: tunnel.access })),
    Effect.catch((cause) =>
      Effect.logWarning("The portal tunnel file is unreadable, so the server ignores it.", {
        path: filePath,
        cause: String(cause),
      }).pipe(Effect.as(undefined)),
    ),
  );
});

/** Completes once `withKitshn` stayed true for `RETIRE_AFTER`; a false resets the wait. */
export const awaitHandover = (withKitshn: Stream.Stream<boolean>) =>
  withKitshn.pipe(
    Stream.changes,
    Stream.switchMap((handedOver) =>
      handedOver ? Stream.fromEffect(Effect.sleep(RETIRE_AFTER)) : Stream.empty,
    ),
    Stream.runHead,
    Effect.asVoid,
  );

/**
 * Runs the portal tunnel's `cloudflared` while the config took its tunnel from the file (MM-1309),
 * until the host moved to kitshn. Then it stops it for good and leaves the file as it is.
 */
export const layerPortalTunnel = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const relayClient = yield* RelayClient.RelayClient;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const provider = yield* KitshnProvider.KitshnProvider;
    const tunnel = yield* readPortalTunnel(config.stateDir);
    // A tunnel from the environment or the desktop settings has its own `cloudflared` (MM-1310).
    if (tunnel === undefined || config.tunnelPairingUrl !== tunnel.origin) return;
    const retiredPath = path.join(config.stateDir, RETIRED_FILE);
    if (yield* fileSystem.exists(retiredPath).pipe(Effect.orElseSucceed(() => false))) return;

    const runOnce = Effect.scoped(
      Effect.gen(function* () {
        const token = Option.getOrNull(yield* secrets.get(TOKEN_SECRET_NAME));
        if (token === null) {
          return yield* Effect.logWarning("The portal tunnel has no token, so it does not run.");
        }
        // The pinned release of the upstream relay client, with its sha256 checked.
        const binary = (yield* relayClient.install).executablePath;
        // The token goes in the environment, so it does not show in the process list.
        const child = yield* spawner.spawn(
          ChildProcess.make(
            binary,
            [
              "tunnel",
              "--no-autoupdate",
              "--loglevel",
              "warn",
              "--logfile",
              path.join(config.logsDir, "cloudflared.log"),
              "run",
            ],
            {
              env: { TUNNEL_TOKEN: new TextDecoder().decode(token) },
              extendEnv: true,
              detached: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          ),
        );
        yield* Effect.logInfo("cloudflared started for the portal tunnel.", { pid: child.pid });
        const exitCode = yield* child.exitCode;
        yield* Effect.logWarning("cloudflared exited. It starts again.", {
          exitCode: Number(exitCode),
        });
      }),
    );
    const runner = yield* runOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cloudflared could not run. It tries again.", { cause: String(cause) }),
      ),
      Effect.andThen(Effect.sleep(RESTART_DELAY)),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* awaitHandover(provider.hostWithKitshn).pipe(
      Effect.andThen(fileSystem.writeFileString(retiredPath, "The host moved to kitshn.\n")),
      Effect.andThen(Fiber.interrupt(runner)),
      Effect.andThen(Effect.logInfo("The host moved to kitshn, so the portal tunnel stopped.")),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not retire the portal tunnel.", { cause: String(cause) }),
      ),
      Effect.forkScoped,
    );
  }),
);
