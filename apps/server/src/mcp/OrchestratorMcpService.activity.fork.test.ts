import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentInstanceId = ProviderInstanceId.make("codex");

it("scheduleTask from a client without a thread uses the project model from project settings", async () => {
  const selection = { instanceId: parentInstanceId, model: "gpt-5.4" };
  const saved: Array<ScheduledTaskUpsertInput> = [];
  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProjectService.ProjectService)({
          // The aggregate field is empty, as on a server that folded project settings.
          getById: () =>
            Effect.succeedSome({ id: projectId, defaultModelSelection: null } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          upsert: (input) =>
            Effect.sync(() => saved.push(input)).pipe(
              Effect.andThen(Effect.fail(new ScheduledTaskError({ message: "stop after save" }))),
            ),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        ServerSettings.layerTest({
          projectSettingsOverrides: { [projectId]: { defaultModelSelection: selection } },
        }),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    yield* service
      .scheduleTask(
        {
          environmentId,
          requestNamespace: "client:session-1",
          thread: undefined,
          client: { sessionId: "session-1", label: "t3 tool cli", access: "full-access" },
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        },
        { projectId, prompt: "repair the fork", schedule: { type: "webhook" } },
      )
      .pipe(Effect.flip);
    expect(saved.map((input) => input.modelSelection)).toEqual([selection]);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
