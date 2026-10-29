/**
 * Fork: the tunnel host and Access values that a machine map portal join left in
 * `<stateDir>/machine-map-tunnel.json`. The config reads them when no env or bootstrap value
 * sets them. Known limit: kitshn sends the Access values of a host only after its handover
 * (K-1623). Remove this file once every host has its access info from kitshn.
 */
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
