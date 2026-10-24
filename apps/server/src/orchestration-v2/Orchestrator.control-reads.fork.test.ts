import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TERMINAL_THREAD_MODEL_SELECTION,
  THREAD_KIND_CHANGE_MESSAGE,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread kind checks"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-kind" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("keeps a thread on its side of the terminal line", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const create = (threadId: ThreadId, selection: typeof modelSelection) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:thread-kind"),
        title: "Kind",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const refusal = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    const agentThread = ThreadId.make("thread:agent-kind");
    const terminalThread = ThreadId.make("thread:terminal-kind");
    yield* create(agentThread, modelSelection);
    yield* create(terminalThread, TERMINAL_THREAD_MODEL_SELECTION);

    const attempts = [
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("agent-to-terminal"),
        threadId: agentThread,
        modelSelection: TERMINAL_THREAD_MODEL_SELECTION,
      }),
      orchestrator.dispatch({
        type: "provider.switch",
        commandId: CommandId.make("terminal-to-agent"),
        threadId: terminalThread,
        modelSelection,
      }),
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("message-to-terminal"),
        threadId: agentThread,
        messageId: MessageId.make("message-to-terminal"),
        text: "ls",
        attachments: [],
        modelSelection: TERMINAL_THREAD_MODEL_SELECTION,
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      }),
    ];
    for (const attempt of attempts) {
      const error = refusal(yield* Effect.exit(attempt));
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
      assert.equal(error.cause, THREAD_KIND_CHANGE_MESSAGE);
    }
  }).pipe(Effect.provide(layerTest)),
);
