/**
 * Fork: the `terminal` provider adapter. A turn types the message into the main terminal of the
 * thread (`term-1`), the same terminal that the thread view shows. See `protocol.ts` for what the
 * run answers. A message that arrives during a run is typed into the program that runs (a steer).
 * The adapter has no model, no tools and no approvals.
 */
import {
  DEFAULT_TERMINAL_ID,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { makeShellMarkParser } from "../shellMarks.ts";
import {
  formatCompletedRun,
  formatTimedOutRun,
  INCOMPLETE_COMMAND_MESSAGE,
  makeCommandCapture,
  pastedCommand,
  SHELL_ENDED_MESSAGE,
  SHELL_READY_TIMEOUT_MS,
  TERMINAL_RUN_TIMEOUT_MS,
  TYPED_INTO_PROGRAM_MESSAGE,
  TYPED_WITHOUT_RESULT_MESSAGE,
} from "./protocol.ts";
import { TerminalPort } from "./port.ts";

export const TERMINAL_DRIVER = ProviderDriverKind.make("terminal");

export const TerminalProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
  runtimePolicy: {
    enforcement: "client-boundary",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface TerminalAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly port: TerminalPort["Service"];
  /** Fails with a message when the server setting `terminalThreads` is off. */
  readonly ensureEnabled: Effect.Effect<void, string>;
  readonly workspaceRootOf: (
    projectId: ProviderAdapter.ProviderAdapterV2TurnInput["appThread"]["projectId"],
  ) => Effect.Effect<string | null>;
}

function makeProviderThread(input: {
  readonly options: TerminalAdapterOptions;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const nativeThreadId = String(input.appThreadId);
  return {
    id: input.options.idAllocator.derive.providerThread({
      driver: TERMINAL_DRIVER,
      providerInstanceId: input.options.instanceId,
      nativeThreadId,
    }),
    driver: TERMINAL_DRIVER,
    providerInstanceId: input.options.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: TERMINAL_DRIVER, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: null,
    nativeMetadata: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

type RunAnswer =
  | { readonly type: "answered"; readonly text: string }
  | { readonly type: "failed"; readonly message: string };
const answered = (text: string): RunAnswer => ({ type: "answered", text });
const failed = (message: string): RunAnswer => ({ type: "failed", message });

const unsupported = (detail: string) =>
  Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({ driver: TERMINAL_DRIVER, detail }),
  );

export function makeTerminalAdapter(options: TerminalAdapterOptions) {
  const { idAllocator, port } = options;
  const terminalId = DEFAULT_TERMINAL_ID;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: TERMINAL_DRIVER,
    getCapabilities: () => Effect.succeed(TerminalProviderCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        yield* options.ensureEnabled.pipe(
          Effect.mapError(
            (detail) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: TERMINAL_DRIVER,
                providerSessionId: input.providerSessionId,
                cause: detail,
              }),
          ),
        );
        const scope = yield* Effect.scope;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        yield* Effect.addFinalizer(() => Queue.end(events));
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        // The turn that runs now. A second turn cannot start before this one ends, because the
        // run queue serializes the runs of a thread.
        const activeTurn = yield* Ref.make<{
          readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
          readonly interrupted: Deferred.Deferred<void>;
          /** True once the message was typed, so a steer goes after it; false if it never was. */
          readonly typed: Deferred.Deferred<boolean>;
        } | null>(null);
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: TERMINAL_DRIVER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? ".",
          model: null,
          capabilities: TerminalProviderCapabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        // A failure fails the run, so a caller such as a schedule sees it.
        const runMessage = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          typed: Deferred.Deferred<boolean>,
        ): Effect.Effect<RunAnswer> =>
          Effect.gen(function* () {
            // The message runs as a command of the user, so it needs the mode that asks for
            // nothing. A caller in a narrower mode falls back to approval-required here.
            if (turn.runtimePolicy.runtimeMode !== "full-access") {
              return failed(
                "A terminal thread runs commands without approval. Use full access mode.",
              );
            }
            const ids = { threadId: String(turn.threadId), terminalId };
            const launch = terminalThreadLaunch({
              workspaceRoot:
                (yield* options.workspaceRootOf(turn.appThread.projectId)) ??
                turn.runtimePolicy.cwd ??
                ".",
              worktreePath: turn.appThread.worktreePath,
            });
            // `terminal.open` restarts a terminal whose cwd or env differ, so a running terminal
            // is never opened again.
            if (!(yield* port.isRunning(ids))) {
              yield* port.open({
                ...ids,
                cwd: launch.cwd,
                worktreePath: launch.worktreePath,
                env: { ...launch.env },
              });
            }
            const state = yield* waitForShellState(ids);
            if (state === undefined || state === "running") {
              yield* port.write({ ...ids, data: `${turn.message.text}\r` });
              yield* Deferred.succeed(typed, true);
              return answered(
                state === undefined ? TYPED_WITHOUT_RESULT_MESSAGE : TYPED_INTO_PROGRAM_MESSAGE,
              );
            }

            const capture = makeCommandCapture();
            const parser = makeShellMarkParser();
            const finished = yield* Deferred.make<void>();
            // The prompt after the Ctrl+C that cancels an unfinished command.
            const cancelled = yield* Deferred.make<void>();
            const shellEnded = yield* Ref.make(false);
            // Subscribe before writing, so no mark passes the listener.
            const unsubscribe = yield* port.subscribe(ids, (event) => {
              if (event.type === "ended") {
                return Ref.set(shellEnded, true).pipe(
                  Effect.andThen(Deferred.succeed(finished, undefined)),
                  Effect.andThen(Deferred.succeed(cancelled, undefined)),
                  Effect.asVoid,
                );
              }
              const items = parser.push(event.data);
              if (capture.incomplete() && items.some((item) => item.type === "prompt")) {
                return Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid);
              }
              return capture.push(items)
                ? Deferred.succeed(finished, undefined).pipe(Effect.asVoid)
                : Effect.void;
            });
            return yield* Effect.gen(function* () {
              yield* port.write({ ...ids, data: pastedCommand(turn.message.text) });
              yield* Deferred.succeed(typed, true);
              const outcome = yield* Deferred.await(finished).pipe(
                Effect.timeoutOption(TERMINAL_RUN_TIMEOUT_MS),
              );
              if (yield* Ref.get(shellEnded)) return answered(SHELL_ENDED_MESSAGE);
              if (capture.incomplete()) {
                yield* port.write({ ...ids, data: "\u0003" });
                // The next message waits for the prompt, so the end mark of the Ctrl+C is not
                // taken for its own.
                yield* Deferred.await(cancelled).pipe(Effect.timeoutOption(SHELL_READY_TIMEOUT_MS));
                return failed(INCOMPLETE_COMMAND_MESSAGE);
              }
              return answered(
                Option.isSome(outcome)
                  ? formatCompletedRun(capture.result())
                  : formatTimedOutRun(capture.result()),
              );
            }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
          }).pipe(
            Effect.catch((error: { readonly message: string }) =>
              Effect.succeed(failed(`The terminal could not run the message. ${error.message}`)),
            ),
            // A steer never waits for a message that was not typed, and is not typed either.
            Effect.ensuring(Deferred.succeed(typed, false)),
          );

        // A shell with integration reports `starting` until its first prompt, after its startup
        // files ran. A shell without integration has no state, so the message goes at once.
        const waitForShellState = (ids: { threadId: string; terminalId: string }) =>
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            const parser = makeShellMarkParser();
            const unsubscribe = yield* port.subscribe(ids, (event) =>
              event.type === "output" &&
              parser.push(event.data).some((item) => item.type === "prompt")
                ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                : Effect.void,
            );
            return yield* Effect.gen(function* () {
              const known = yield* port.shellState(ids);
              if (known !== "starting") return known;
              yield* Deferred.await(ready).pipe(Effect.timeoutOption(SHELL_READY_TIMEOUT_MS));
              const after = yield* port.shellState(ids);
              return after === "starting" ? undefined : after;
            }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
          });

        const runTurn = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          providerTurnId: OrchestrationV2ProviderTurn["id"],
          startedAt: DateTime.Utc,
          interrupted: Deferred.Deferred<void>,
          typed: Deferred.Deferred<boolean>,
        ) =>
          Effect.gen(function* () {
            const providerTurn = (
              status: OrchestrationV2ProviderTurn["status"],
              completedAt: DateTime.Utc | null,
            ): OrchestrationV2ProviderTurn => ({
              id: providerTurnId,
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver: TERMINAL_DRIVER,
                nativeId: String(providerTurnId),
                strength: "weak",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt,
              completedAt,
            });
            yield* emit({
              type: "provider_turn.updated",
              driver: TERMINAL_DRIVER,
              threadId: turn.threadId,
              providerTurn: providerTurn("running", null),
            });
            const answer = yield* Effect.raceFirst(
              runMessage(turn, typed),
              Deferred.await(interrupted).pipe(Effect.as(null)),
            );
            // A steer from now on would type at the prompt, outside of this run.
            yield* Ref.set(activeTurn, null);
            const status =
              answer === null
                ? ("interrupted" as const)
                : answer.type === "failed"
                  ? ("failed" as const)
                  : ("completed" as const);
            const completedAt = yield* DateTime.now;
            if (answer?.type === "answered") {
              const nativeItemId = `${providerTurnId}:answer`;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                driver: TERMINAL_DRIVER,
                nativeItemId,
              });
              const messageId = idAllocator.derive.messageFromProviderItem({
                driver: TERMINAL_DRIVER,
                nativeItemId,
              });
              const nativeItemRef = {
                driver: TERMINAL_DRIVER,
                nativeId: nativeItemId,
                strength: "weak" as const,
              };
              yield* emit({
                type: "node.updated",
                driver: TERMINAL_DRIVER,
                node: {
                  id: nodeId,
                  threadId: turn.threadId,
                  runId: turn.runId,
                  parentNodeId: turn.rootNodeId,
                  rootNodeId: turn.rootNodeId,
                  kind: "assistant_message",
                  status: "completed",
                  countsForRun: false,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef,
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt,
                  completedAt,
                },
              });
              const message: OrchestrationV2ConversationMessage = {
                createdBy: "agent",
                creationSource: "provider",
                id: messageId,
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId,
                role: "assistant",
                text: answer.text,
                attachments: [],
                streaming: false,
                createdAt: startedAt,
                updatedAt: completedAt,
              };
              yield* emit({ type: "message.updated", driver: TERMINAL_DRIVER, message });
              yield* emit({
                type: "turn_item.updated",
                driver: TERMINAL_DRIVER,
                turnItem: {
                  id: idAllocator.derive.turnItemFromProviderItem({
                    driver: TERMINAL_DRIVER,
                    nativeItemId,
                  }),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef,
                  parentItemId: null,
                  ordinal: turn.providerTurnOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt,
                  completedAt,
                  updatedAt: completedAt,
                  type: "assistant_message",
                  messageId,
                  text: answer.text,
                  streaming: false,
                },
              });
            }
            yield* emit({
              type: "provider_turn.updated",
              driver: TERMINAL_DRIVER,
              threadId: turn.threadId,
              providerTurn: providerTurn(status, completedAt),
            });
            yield* emit({
              type: "provider_thread.updated",
              driver: TERMINAL_DRIVER,
              providerThread: {
                ...turn.providerThread,
                providerSessionId: input.providerSessionId,
                status: "active",
                lastRunOrdinal: turn.runOrdinal,
                firstRunOrdinal: turn.providerThread.firstRunOrdinal ?? turn.runOrdinal,
                updatedAt: completedAt,
              },
            });
            yield* emit(
              answer?.type === "failed"
                ? {
                    type: "turn.terminal",
                    driver: TERMINAL_DRIVER,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    runOrdinal: turn.runOrdinal,
                    failureItemOrdinal: turn.providerTurnOrdinal * 100 + 2,
                    status: "failed",
                    failure: {
                      class: "provider_error",
                      message: answer.message,
                      code: null,
                      retryable: false,
                    },
                    threadDisposition: "reusable",
                  }
                : {
                    type: "turn.terminal",
                    driver: TERMINAL_DRIVER,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    runOrdinal: turn.runOrdinal,
                    status: answer === null ? "interrupted" : "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
            );
          });

        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            yield* options.ensureEnabled;
            const startedAt = yield* DateTime.now;
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: TERMINAL_DRIVER,
              nativeTurnId: `${turn.runId}:${turn.attemptId}`,
            });
            const interrupted = yield* Deferred.make<void>();
            const typed = yield* Deferred.make<boolean>();
            yield* Ref.set(activeTurn, { providerTurnId, interrupted, typed });
            // The turn ends through the event stream, so `startTurn` returns at once.
            yield* runTurn(turn, providerTurnId, startedAt, interrupted, typed).pipe(
              Effect.forkIn(scope),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: TERMINAL_DRIVER,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  runId: turn.runId,
                  cause,
                }),
            ),
          );

        return {
          instanceId: options.instanceId,
          driver: TERMINAL_DRIVER,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            DateTime.now.pipe(
              Effect.map((createdAt) =>
                makeProviderThread({
                  options,
                  appThreadId: threadInput.threadId,
                  providerSessionId: input.providerSessionId,
                  now: createdAt,
                }),
              ),
            ),
          resumeThread: (threadInput) =>
            DateTime.now.pipe(
              Effect.map((updatedAt) => ({
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt,
              })),
            ),
          startTurn,
          // A message that arrives while a command runs is input for that command: the run
          // queue would hold it until the command ends. It is typed raw, like a message to a
          // program that the user started.
          steerTurn: (turnInput) =>
            Effect.gen(function* () {
              const active = yield* Ref.get(activeTurn);
              if (active === null || active.providerTurnId !== turnInput.providerTurnId) {
                return yield* unsupported("The command ended before the message was typed.");
              }
              const typedFirst = yield* Deferred.await(active.typed);
              if (
                !typedFirst ||
                (yield* Deferred.isDone(active.interrupted)) ||
                (yield* Ref.get(activeTurn)) !== active
              ) {
                return yield* unsupported("The command ended before the message was typed.");
              }
              yield* port.write({
                threadId: String(turnInput.threadId),
                terminalId,
                data: `${turnInput.message.text}\r`,
              });
            }).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: TERMINAL_DRIVER,
                    detail: error instanceof Error ? error.message : String(error),
                  }),
                ),
              ),
            ),
          interruptTurn: (interruptInput) =>
            Effect.gen(function* () {
              const active = yield* Ref.get(activeTurn);
              if (active === null || active.providerTurnId !== interruptInput.providerTurnId)
                return;
              // Ctrl+C reaches the program that runs in the terminal.
              yield* port
                .write({
                  threadId: String(interruptInput.providerThread.appThreadId),
                  terminalId,
                  data: "\u0003",
                })
                .pipe(Effect.ignore);
              yield* Deferred.succeed(active.interrupted, undefined);
            }),
          respondToRuntimeRequest: () => unsupported("A terminal thread has no runtime requests."),
          readThreadSnapshot: () => unsupported("A terminal thread has no provider snapshot."),
          rollbackThread: () => unsupported("A terminal thread cannot roll back."),
          forkThread: () => unsupported("A terminal thread cannot fork."),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
}
