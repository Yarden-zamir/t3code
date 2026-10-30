import { selectCacheWarmupThreads } from "@t3tools/client-runtime/fork/cacheWarmup";
import { syncTimings } from "@t3tools/client-runtime/fork/syncTimings";
import { threadSyncActivity } from "@t3tools/client-runtime/fork/threadSyncActivity";
import { COMPACT_THREAD_CACHE_SCHEMA_VERSION } from "@t3tools/client-runtime/platform";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { AppState } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { MobileDatabase } from "../persistence/mobile-database";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentShell } from "./shell";
import { environmentThreads } from "./threads";

// A thread that does not reach "live" in this time leaves the rest of the warm-up waiting.
const CACHE_WARMUP_THREAD_TIMEOUT_MS = 20_000;

type WarmupOutcome = "success" | "failure" | "interrupted";

/**
 * Loads the newest threads of each environment into the message cache after its thread list
 * is live. It mounts the same thread state atom that an opened thread mounts, one thread and
 * one environment at a time, after no thread synchronizes, and stops in the background. The
 * server setting `mobileWarmRecentChats` of each environment turns it off.
 */
export function installCacheWarmup(): () => void {
  let foreground = AppState.currentState === "active";
  let generation = 0;
  let running = false;
  const queue: Array<EnvironmentId> = [];
  const shellStatus = new Map<EnvironmentId, { status: string; unsubscribe: () => void }>();
  let cancelThread: (() => void) | undefined;

  const warmThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    new Promise<WarmupOutcome>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (outcome: WarmupOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelThread = undefined;
        unsubscribe?.();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("interrupted"), CACHE_WARMUP_THREAD_TIMEOUT_MS);
      cancelThread = () => finish("interrupted");
      unsubscribe = appAtomRegistry.subscribe(
        environmentThreads.stateAtom(environmentId, threadId),
        (result) => {
          const state = AsyncResult.getOrElse(result, () => EMPTY_ENVIRONMENT_THREAD_STATE);
          if (state.status === "live" || state.status === "deleted") finish("success");
          else if (Option.isSome(state.error)) finish("failure");
        },
        { immediate: true },
      );
      if (settled) unsubscribe();
    });

  const warmEnvironment = async (environmentId: EnvironmentId, started: number) => {
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
    if (config?.settings.mobileWarmRecentChats !== true) return;
    const shell = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
    const threads = Option.match(shell.snapshot, {
      onNone: () => [],
      onSome: (snapshot) => snapshot.threads,
    });
    const savedAt = await runtime
      .runPromise(
        MobileDatabase.pipe(
          Effect.flatMap((database) =>
            database.listCacheSavedAt(environmentId, "thread", COMPACT_THREAD_CACHE_SCHEMA_VERSION),
          ),
        ),
      )
      .catch(() => new Map<string, number>());
    const threadIds = selectCacheWarmupThreads(threads, savedAt);
    syncTimings.mark(environmentId, "cacheWarmupStarted");
    for (const threadId of threadIds) {
      await threadSyncActivity.whenNoThreadSynchronizes();
      if (generation !== started) return;
      const end = syncTimings.startStep(environmentId, "CacheWarmup.thread");
      end(await warmThread(environmentId, threadId));
      if (generation !== started) return;
    }
    syncTimings.mark(environmentId, "cacheWarmupDone");
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      const started = generation;
      for (;;) {
        if (!foreground || generation !== started) return;
        const environmentId = queue.shift();
        if (environmentId === undefined) return;
        await warmEnvironment(environmentId, started);
      }
    } finally {
      running = false;
      // An environment that went live while a cancelled run ended still waits in the queue.
      if (foreground && queue.length > 0) void drain();
    }
  };

  const followEnvironments = () => {
    const enabled = new Set(
      enabledEnvironmentIds(appAtomRegistry.get(environmentCatalog.catalogValueAtom)),
    );
    for (const [environmentId, entry] of shellStatus) {
      if (enabled.has(environmentId)) continue;
      entry.unsubscribe();
      shellStatus.delete(environmentId);
    }
    for (const environmentId of enabled) {
      if (shellStatus.has(environmentId)) continue;
      const entry = { status: "empty", unsubscribe: () => {} };
      shellStatus.set(environmentId, entry);
      entry.unsubscribe = appAtomRegistry.subscribe(
        environmentShell.statusAtom(environmentId),
        (status) => {
          const becameLive = status === "live" && entry.status !== "live";
          entry.status = status;
          if (!becameLive || !foreground || queue.includes(environmentId)) return;
          queue.push(environmentId);
          void drain();
        },
        { immediate: true },
      );
    }
  };

  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    followEnvironments,
    { immediate: true },
  );
  const appState = AppState.addEventListener("change", (state) => {
    foreground = state === "active";
    if (foreground) return;
    generation += 1;
    queue.length = 0;
    cancelThread?.();
  });

  return () => {
    generation += 1;
    queue.length = 0;
    cancelThread?.();
    appState.remove();
    unsubscribeCatalog();
    for (const entry of shellStatus.values()) entry.unsubscribe();
    shellStatus.clear();
  };
}
