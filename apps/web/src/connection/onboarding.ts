import {
  type CloudflareAccessServiceToken,
  ConnectionOnboarding,
  RequestHeaderStore,
  withCloudflareAccessServiceToken,
} from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});

export const readRequestHeaders = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:read-request-headers",
  execute: (origin: string) =>
    RequestHeaderStore.pipe(Effect.flatMap((store) => store.get(origin))),
});

/**
 * Fork: the only writer of saved request headers. A kitshn device invite saves the Cloudflare Access
 * token of this device for one origin (K-1601), and null takes it away. Other headers stay.
 */
export const saveDeviceToken = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:save-kitshn-device-token",
  concurrency: {
    mode: "serial",
    key: (input: { readonly origin: string }) => input.origin,
  },
  execute: (input: {
    readonly origin: string;
    readonly token: CloudflareAccessServiceToken | null;
  }) =>
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
