/**
 * Fork: guest links over the Cloudflare tunnel of `T3CODE_TUNNEL_PAIRING_URL`, for builds without
 * T3 Connect. `GuestShareService.ts` keeps a one-line hook into this file.
 */
import * as Effect from "effect/Effect";

import type { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";

/**
 * The host of new guest links, which a share must still match to work: the T3 Connect host while
 * Connect serves this machine, else the tunnel host, else none.
 */
export const guestShareHostname = Effect.fn("ForkGuestShare.hostname")(function* (
  managedEndpoint: CloudManagedEndpointRuntime["Service"],
) {
  const { tunnelPairingUrl } = yield* ServerConfig.ServerConfig;
  const tunnelHostname = tunnelPairingUrl === undefined ? null : new URL(tunnelPairingUrl).hostname;
  return managedEndpoint.inspectConnector.pipe(
    Effect.map((facts) => facts?.hostname ?? tunnelHostname),
  );
});
