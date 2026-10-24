import { type ServerProvider, TERMINAL_THREAD_INSTANCE_ID } from "@t3tools/contracts";

const withoutTerminalCache = new WeakMap<ReadonlyArray<ServerProvider>, ServerProvider[]>();

/**
 * Fork: the providers of an agent model picker. The `terminal` provider lists shells as its
 * models, which only a draft in Terminal mode and scheduled tasks offer. Cached per list, so
 * memos that depend on the result stay stable.
 */
export function withoutTerminalProvider(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider[] {
  let filtered = withoutTerminalCache.get(providers);
  if (filtered === undefined) {
    filtered = providers.filter((provider) => provider.instanceId !== TERMINAL_THREAD_INSTANCE_ID);
    withoutTerminalCache.set(providers, filtered);
  }
  return filtered;
}
