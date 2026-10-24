import type { TerminalSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { TerminalPort, TerminalPortError } from "./port.ts";

const keyOf = (terminal: { readonly threadId: string; readonly terminalId: string }) =>
  `${terminal.threadId}\u0000${terminal.terminalId}`;

/** Fork: the terminal manager behind `TerminalPort`. */
export const layer = Layer.effect(
  TerminalPort,
  Effect.gen(function* () {
    const manager = yield* TerminalManager.TerminalManager;
    const projects = yield* ProjectStoreV2;
    const summaries = yield* Ref.make<ReadonlyMap<string, TerminalSummary>>(new Map());
    // The metadata stream starts with a snapshot of every terminal, then sends each change.
    const unsubscribe = yield* manager.subscribeMetadata((event) =>
      Ref.update(summaries, (current) => {
        const next = new Map(current);
        if (event.type === "snapshot") {
          next.clear();
          for (const terminal of event.terminals) next.set(keyOf(terminal), terminal);
        } else if (event.type === "upsert") {
          next.set(keyOf(event.terminal), event.terminal);
        } else {
          next.delete(keyOf(event));
        }
        return next;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const summaryOf = (input: { threadId: string; terminalId: string }) =>
      Ref.get(summaries).pipe(Effect.map((current) => current.get(keyOf(input))));

    return TerminalPort.of({
      workspaceRootOf: (projectId) =>
        projects.get(projectId).pipe(
          Effect.map((project) => (Option.isSome(project) ? project.value.workspaceRoot : null)),
          Effect.orElseSucceed(() => null),
        ),
      isRunning: (input) =>
        summaryOf(input).pipe(
          Effect.map((summary) => summary?.status === "running" || summary?.status === "starting"),
        ),
      shellState: (input) =>
        summaryOf(input).pipe(
          Effect.map((summary) => (summary?.status === "running" ? summary.shell : undefined)),
        ),
      // A shell that cannot start leaves the session in `error` and does not fail the open, so
      // the open listens for the reason that the manager publishes.
      open: Effect.fn("TerminalPort.open")(
        function* (input) {
          let reason: string | null = null;
          const stop = yield* manager.subscribe((event) =>
            Effect.sync(() => {
              if (
                event.type === "error" &&
                event.threadId === input.threadId &&
                event.terminalId === input.terminalId
              )
                reason = event.message;
            }),
          );
          const snapshot = yield* manager.open(input).pipe(Effect.ensuring(Effect.sync(stop)));
          if (snapshot.status === "error") {
            return yield* Effect.fail(reason ?? "The shell did not start.");
          }
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((cause) => new TerminalPortError({ operation: "open", cause })),
          ),
      ),
      write: (input) =>
        manager
          .write(input)
          .pipe(Effect.mapError((cause) => new TerminalPortError({ operation: "write", cause }))),
      subscribe: (input, listener) =>
        manager.subscribe((event) => {
          if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
            return Effect.void;
          }
          if (event.type === "output") return listener({ type: "output", data: event.data });
          // A restart or a new start replaces the shell that the run waits on.
          if (
            event.type === "exited" ||
            event.type === "closed" ||
            event.type === "started" ||
            event.type === "restarted" ||
            event.type === "error"
          )
            return listener({ type: "ended" });
          return Effect.void;
        }),
    });
  }),
);
