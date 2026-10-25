/**
 * Fork: closes the main shell of a terminal thread draft that its client left before the first
 * command. A screen with no attach stream and no thread for ABANDONED_AFTER closes, unless its
 * shell runs a program, so a short disconnect never ends a program. Limit: that program runs until
 * it ends, and drawer terminals stay. Revisit if such programs pile up or drafts get the drawer.
 */
import { DEFAULT_TERMINAL_ID, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export const CHECK_INTERVAL = Duration.seconds(10);
// The server is the only one that discards a draft terminal: another tab or client can show
// the same draft, so a client that leaves cannot know whether the shell is still in use. A draft
// that runs no program holds at most the output of a short command, so losing it after a
// connection drop of this length costs little.
export const ABANDONED_AFTER = Duration.seconds(30);

export interface AbandonedTerminalDraftDeps {
  /** The terminal thread screens without an attach stream. */
  readonly unattachedScreens: Effect.Effect<
    ReadonlyArray<{ readonly threadId: string; readonly programRuns: boolean }>
  >;
  readonly threadExists: (threadId: string) => Effect.Effect<boolean>;
  readonly close: (threadId: string) => Effect.Effect<void>;
}

/** Runs forever: one check now, then one each CHECK_INTERVAL. */
export const collectAbandonedTerminalDrafts = (deps: AbandonedTerminalDraftDeps) => {
  // The thread id of each abandoned screen, with the time a check first saw it abandoned.
  const abandonedSince = new Map<string, number>();
  const check = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const abandoned = new Set<string>();
    for (const { threadId, programRuns } of yield* deps.unattachedScreens) {
      if (programRuns || (yield* deps.threadExists(threadId))) continue;
      abandoned.add(threadId);
      const since = abandonedSince.get(threadId) ?? now;
      abandonedSince.set(threadId, since);
      if (now - since >= Duration.toMillis(ABANDONED_AFTER)) {
        yield* Effect.logInfo("Closing an abandoned terminal thread draft.", { threadId });
        yield* deps.close(threadId);
      }
    }
    for (const threadId of abandonedSince.keys()) {
      if (!abandoned.has(threadId)) abandonedSince.delete(threadId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Abandoned terminal draft check failed.", { cause }),
    ),
  );
  return check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.asVoid);
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* collectAbandonedTerminalDrafts({
      unattachedScreens: terminals.forkUnattachedThreadScreens,
      // A failed read counts as a thread, so a shell never closes on a doubt.
      threadExists: (threadId) =>
        threads.getThreadShell(ThreadId.make(threadId)).pipe(
          Effect.map((thread) => thread !== null),
          Effect.orElseSucceed(() => true),
        ),
      close: (threadId) =>
        terminals.close({ threadId, terminalId: DEFAULT_TERMINAL_ID, deleteHistory: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close an abandoned terminal thread draft.", {
              threadId,
              error: error.message,
            }),
          ),
        ),
    }).pipe(Effect.forkScoped);
  }),
);
