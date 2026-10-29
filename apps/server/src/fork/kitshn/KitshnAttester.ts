/**
 * Fork: on each start, the server registers itself as the T3 attester of the machine's kitshn daemon
 * (kitshn K-1751), so the daemon can ask `/api/thread-identity` which thread calls a kitshn tool.
 * Best effort: a failure only logs, and the server runs on.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "../../config.ts";
import { loopbackUrlHostForAddress } from "../../startupAccess.ts";
import * as KitshnCli from "./KitshnCli.ts";

export class KitshnAttester extends Context.Service<
  KitshnAttester,
  {
    /** Registers the server that listens on `address`. It never fails. */
    readonly register: (address: NetAddress.InetAddress) => Effect.Effect<void>;
  }
>()("t3/fork/kitshn/KitshnAttester") {}

/**
 * Why this server does not speak for the machine to its kitshn daemon, or none. A dev server or
 * a server of another T3 home would take the `t3` entries from the installed app, which owns the
 * agents. The attester and the kitshn provider share this gate.
 */
export const kitshnOwnerRefusal = Effect.fn("KitshnAttester.kitshnOwnerRefusal")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  if ((yield* HostProcess.Platform) === "win32") return Option.some("Windows has no kitshn 2");
  if (config.devUrl !== undefined) return Option.some("a dev server does not register");
  // ServerConfig does not record whether --base-dir, T3CODE_HOME or a worktree `.t3` chose the
  // folder, so compare paths.
  const defaultHome = path.join(yield* HostProcess.HomeDirectory, ".t3");
  return path.resolve(config.baseDir) === defaultHome
    ? Option.none()
    : Option.some(
        `the T3 home ${config.baseDir} is not the default ${defaultHome}, so it does not register`,
      );
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const cli = yield* KitshnCli.KitshnCli;
  const path = yield* Path.Path;

  const register: KitshnAttester["Service"]["register"] = Effect.fn("KitshnAttester.register")(
    function* (address) {
      const refusal = yield* kitshnOwnerRefusal().pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(Path.Path, path),
      );
      if (Option.isSome(refusal)) {
        return yield* Effect.logDebug(`kitshn attester: ${refusal.value}`);
      }
      // The daemon accepts only a loopback attester.
      if (!NetAddress.isLoopback(address.address) && !NetAddress.isUnspecified(address.address)) {
        return yield* Effect.logInfo(
          "kitshn attester: the server does not listen on loopback, so it does not register",
        );
      }
      const url = `http://${loopbackUrlHostForAddress(address)}:${address.port}/api/thread-identity`;
      yield* cli.setAttester(url).pipe(
        Effect.tap(() => Effect.logInfo("kitshn attester registered", { url })),
        Effect.catch((error) =>
          error.reason === "not_installed" || error.reason === "not_kitshn_2"
            ? Effect.logInfo(`kitshn attester: ${error.message}`)
            : Effect.logWarning(`kitshn attester not registered: ${error.message}`),
        ),
      );
    },
  );

  return KitshnAttester.of({ register });
});

export const layer = Layer.effect(KitshnAttester, make);
