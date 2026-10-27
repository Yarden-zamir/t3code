import { createSingletonHost } from "../lib/singletonHost";

/**
 * Fork: true in the first mounted root. The outbox and attachment uploads are module services
 * (`App.tsx`). The relay sign-in is a provider, so the Android assistant panel mounts it only
 * while it is the host.
 */
export const useIsAppServicesHost = createSingletonHost("app-services-host");

/** Registers the app root as a host, so the panel leaves the relay sign-in to it. */
export function AppServicesHost() {
  useIsAppServicesHost();
  return null;
}
