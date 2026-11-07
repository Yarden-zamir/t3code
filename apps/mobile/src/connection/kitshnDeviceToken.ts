/**
 * Fork: the kitshn device token of this phone (K-1601), saved as the Cloudflare Access headers of
 * each machine origin and of kitshn. Only a device invite and the app token repair write it.
 */
import {
  type CloudflareAccessServiceToken,
  RequestHeaderStore,
  withCloudflareAccessServiceToken,
} from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

export const saveDeviceToken = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:save-kitshn-device-token",
  concurrency: {
    mode: "serial",
    key: (input: { readonly origin: string }) => input.origin,
  },
  execute: (input: { readonly origin: string; readonly token: CloudflareAccessServiceToken }) =>
    RequestHeaderStore.pipe(
      Effect.flatMap((store) =>
        store
          .get(input.origin)
          .pipe(
            Effect.flatMap((current) =>
              store.set(input.origin, withCloudflareAccessServiceToken(current, input.token)),
            ),
          ),
      ),
    ),
});
