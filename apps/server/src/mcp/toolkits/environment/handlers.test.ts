import { expect, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off -- The key-file path is tested with a real private file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  SecretRef,
  ThreadId,
  UsageLimitSourceId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it.effect("adds a local hub from a secretRef without returning the key", () =>
  Effect.gen(function* () {
    const added = yield* Ref.make<Array<{ url: string; managementKey: string }>>([]);
    const consumed = yield* Ref.make(0);
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({}),
      Layer.mock(SecretRequests.SecretRequests)({
        consume: () => Ref.update(consumed, (n) => n + 1).pipe(Effect.as("private-test-key")),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        add: (input) =>
          Ref.update(added, (current) => [...current, input]).pipe(
            Effect.as({ id: UsageLimitSourceId.make("local-hub") }),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const ref = SecretRef.make("secret-ref:test");
      const rejected = yield* toolkit
        .handle("t3_usage_source_add", { url: "https://external.example", secretRef: ref })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(consumed)).toBe(0);
      const result = yield* toolkit
        .handle("t3_usage_source_add", { url: "http://127.0.0.1:8317", secretRef: ref })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(result.at(-1)?.result).toEqual({ id: "local-hub" });
      expect(JSON.stringify(result)).not.toContain("private-test-key");
      expect(yield* Ref.get(added)).toEqual([
        { url: "http://127.0.0.1:8317", managementKey: "private-test-key" },
      ]);
      expect(yield* Ref.get(consumed)).toBe(1);
      if (HostProcess.Platform.defaultValue() !== "win32") {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hub-test-"))),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const path = NodePath.join(directory, "key");
        yield* Effect.promise(() => NodeFSP.writeFile(path, "file-test-key", { mode: 0o600 }));
        const fromFile = yield* toolkit
          .handle("t3_usage_source_add", { url: "http://127.0.0.1:8318", keyFile: path })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(fromFile.at(-1)?.result).toEqual({ id: "local-hub" });
        expect(JSON.stringify(fromFile)).not.toContain("file-test-key");
        expect((yield* Ref.get(added)).at(-1)).toEqual({
          url: "http://127.0.0.1:8318",
          managementKey: "file-test-key",
        });
        const linkedScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "peer:preferences",
          thread: undefined,
          client: { sessionId: "peer", label: "Peer", access: "full-access", linked: true },
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const linkedFile = yield* toolkit
          .handle("t3_usage_source_add", { url: "http://127.0.0.1:8318", keyFile: path })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, linkedScope),
          );
        expect(linkedFile.at(-1)?.result).toEqual({ id: "local-hub" });
        const linkedRef = yield* toolkit
          .handle("t3_usage_source_add", { url: "http://127.0.0.1:8318", secretRef: ref })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, linkedScope),
          );
        expect(linkedRef.at(-1)?.result).toMatchObject({ code: "invalid_request" });
        const readOnly = yield* toolkit
          .handle("t3_usage_source_add", { url: "http://127.0.0.1:8318", keyFile: path })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...linkedScope,
              client: { ...linkedScope.client!, access: "read-only" },
            }),
          );
        expect(readOnly.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
