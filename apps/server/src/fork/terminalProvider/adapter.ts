/**
 * Fork: the `terminal` provider adapter. A turn types the message into the main terminal of the
 * thread (`term-1`), the same terminal that the thread view shows. See `protocol.ts` for what the
 * run answers. The adapter has no model, no tools, no approvals and no steering.
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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  resolveCompletionShell,
  wrapCommandForCompletion,
} from "../../project/ProjectSetupScriptRunner.ts";
import {
  completionSentinel,
  formatCompletedRun,
  formatTimedOutRun,
  makeCompletionCollector,
  TERMINAL_RUN_TIMEOUT_MS,
  TYPED_INTO_PROGRAM_MESSAGE,
} from "./protocol.ts";
import { TerminalPort } from "./port.ts";

export const TERMINAL_DRIVER = ProviderDriverKind.make("terminal");

const AFTER_MARKER_WINDOW_MS = 5_000;
const IDLE_CHECK_INTERVAL_MS = 150;
const IDLE_CHECK_ATTEMPTS = 20;

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
    supportsActiveSteering: false,
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
  readonly shell: ReturnType<typeof resolveCompletionShell>;
  readonly newToken: Effect.Effect<string>;
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
        } | null>(null);
        // When the last run ended at its marker. The manager learns that the command ended up to
        // one poll later, so a run that follows at once waits for the flag to clear.
        const lastMarkerAtMs = yield* Ref.make(0);
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

        // The text of the answer. A failure of the terminal is an answer too: the run completes,
        // and the message says what went wrong.
        const runMessage = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            const threadId = String(turn.threadId);
            const workspaceRoot = yield* options.workspaceRootOf(turn.appThread.projectId);
            const launch = terminalThreadLaunch({
              workspaceRoot: workspaceRoot ?? turn.runtimePolicy.cwd ?? ".",
              worktreePath: turn.appThread.worktreePath,
            });
            // `terminal.open` restarts a terminal whose cwd or env differ, so a running terminal
            // is never opened again.
            if (!(yield* port.isRunning({ threadId, terminalId }))) {
              yield* port.open({
                threadId,
                terminalId,
                cwd: launch.cwd,
                worktreePath: launch.worktreePath,
                env: { ...launch.env },
              });
            }
            const text = turn.message.text;
            const sinceMarkerMs =
              (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastMarkerAtMs));
            if (sinceMarkerMs < AFTER_MARKER_WINDOW_MS) {
              for (let attempt = 0; attempt < IDLE_CHECK_ATTEMPTS; attempt += 1) {
                if (!(yield* port.hasRunningProgram({ threadId, terminalId }))) break;
                yield* Effect.sleep(IDLE_CHECK_INTERVAL_MS);
              }
            }
            if (yield* port.hasRunningProgram({ threadId, terminalId })) {
              yield* port.write({ threadId, terminalId, data: `${text}\r` });
              return TYPED_INTO_PROGRAM_MESSAGE;
            }
            const sentinel = completionSentinel(yield* options.newToken);
            const wrapped = wrapCommandForCompletion(text, options.shell, sentinel);
            const collector = makeCompletionCollector({
              sentinel,
              echoedWrapperLines: wrapped.split("\r").filter((line) => line.length > 0),
            });
            const finished = yield* Deferred.make<void>();
            // Subscribe before writing, so the marker cannot pass the listener.
            const unsubscribe = yield* port.subscribe({ threadId, terminalId }, (event) =>
              event.type === "ended" || collector.push(event.data)
                ? Deferred.succeed(finished, undefined).pipe(Effect.asVoid)
                : Effect.void,
            );
            return yield* Effect.gen(function* () {
              yield* port.write({ threadId, terminalId, data: `${wrapped}\r` });
              const outcome = yield* Deferred.await(finished).pipe(
                Effect.timeoutOption(TERMINAL_RUN_TIMEOUT_MS),
              );
              const result = collector.result();
              if (result.exitCode !== null) {
                yield* Ref.set(lastMarkerAtMs, yield* Clock.currentTimeMillis);
              }
              return Option.isSome(outcome)
                ? formatCompletedRun(result)
                : formatTimedOutRun(result);
            }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
          }).pipe(
            Effect.catch((error: { readonly message: string }) =>
              Effect.succeed(`The terminal could not run the message. ${error.message}`),
            ),
          );

        const runTurn = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          providerTurnId: OrchestrationV2ProviderTurn["id"],
          startedAt: DateTime.Utc,
          interrupted: Deferred.Deferred<void>,
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
              runMessage(turn).pipe(Effect.map((text) => ({ text }) as const)),
              Deferred.await(interrupted).pipe(Effect.as(null)),
            );
            const status = answer === null ? ("interrupted" as const) : ("completed" as const);
            const completedAt = yield* DateTime.now;
            if (answer !== null) {
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
            yield* emit({
              type: "turn.terminal",
              driver: TERMINAL_DRIVER,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              runOrdinal: turn.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Ref.set(activeTurn, null);
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
            yield* Ref.set(activeTurn, { providerTurnId, interrupted });
            // The turn ends through the event stream, so `startTurn` returns at once.
            yield* runTurn(turn, providerTurnId, startedAt, interrupted).pipe(Effect.forkIn(scope));
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
          steerTurn: (turnInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver: TERMINAL_DRIVER,
                providerThreadId: turnInput.providerThread.id,
              }),
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
              // The shell prompt returns, and the manager learns it up to one poll later.
              yield* Ref.set(lastMarkerAtMs, yield* Clock.currentTimeMillis);
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
