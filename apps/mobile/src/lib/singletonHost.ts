import { useLayoutEffect, useState, useSyncExternalStore } from "react";

/**
 * Fork: the app and the Android assistant panel are separate React roots in one JS runtime.
 * A worker that must run once mounts in each root, and only the first mounted one runs.
 * When it unmounts, the next one takes over.
 */
export function createSingletonHost(label: string): () => boolean {
  const hosts: symbol[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return function useIsSingletonHost(): boolean {
    const [token] = useState(() => Symbol(label));
    useLayoutEffect(() => {
      hosts.push(token);
      notify();
      return () => {
        hosts.splice(hosts.indexOf(token), 1);
        notify();
      };
    }, [token]);
    return useSyncExternalStore(subscribe, () => hosts[0] === token);
  };
}
