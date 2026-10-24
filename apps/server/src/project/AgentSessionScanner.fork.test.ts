import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly workspaceRoot: string;
  readonly agentSessionImportWindowDays?: ContractServerSettings["agentSessionImportWindowDays"];
  readonly agentSessionImportMaxMessages?: ContractServerSettings["agentSessionImportMaxMessages"];
}

const runRecentThreads = (input: ScannerTestInput) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const outcomes = yield* scanner.recentThreads(input.workspaceRoot).pipe(Stream.runCollect);
    return Array.from(outcomes).flatMap((outcome) =>
      outcome._tag === "Importable" ? [outcome.thread] : [],
    );
  }).pipe(
    Effect.provide(
      AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: input.claudeHomePath },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: input.codexHomePath },
                },
              },
              ...(input.agentSessionImportWindowDays === undefined
                ? {}
                : { agentSessionImportWindowDays: input.agentSessionImportWindowDays }),
              ...(input.agentSessionImportMaxMessages === undefined
                ? {}
                : { agentSessionImportMaxMessages: input.agentSessionImportMaxMessages }),
            }),
            ServerConfig.layerTest(input.claudeHomePath, { prefix: "t3code-scanner-config-" }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          ),
        ),
      ),
    ),
  );

const makeTempDir = Effect.fn("AgentSessionScanner.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScanner.test.writeTranscript")(function* (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mtimeMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
  yield* fileSystem.writeFileString(input.filePath, input.contents);
  const seconds = input.mtimeMs / 1000;
  yield* fileSystem.utimes(input.filePath, seconds, seconds);
});

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("AgentSessionScanner", (it) => {
  describe("recentThreads", () => {
    it.effect("limits recent sessions by the configured window and message count", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const directory = path.join(codexHomePath, "sessions", "2026", "08", "24");
        const dayMs = 24 * 60 * 60 * 1000;
        const writeSession = (sessionId: string, ageDays: number) =>
          writeTranscript({
            filePath: path.join(directory, `rollout-${sessionId}.jsonl`),
            contents: [
              encodeTranscriptRecord({
                type: "session_meta",
                payload: { id: sessionId, cwd: workspace },
              }),
              ...["First", "Second", "Third", "Fourth"].map((message) =>
                encodeTranscriptRecord({
                  type: "event_msg",
                  payload: { type: "user_message", message: `${sessionId} ${message}` },
                }),
              ),
            ].join("\n"),
            mtimeMs: nowMs - ageDays * dayMs,
          });
        yield* writeSession("recent", 2);
        yield* writeSession("older", 20);
        yield* writeSession("stale", 40);

        const defaults = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });
        expect(defaults.map((thread) => thread.providerSessionId)).toEqual(["recent", "older"]);
        expect(defaults[0]?.messages).toHaveLength(4);

        const configured = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
          agentSessionImportWindowDays: 10,
          agentSessionImportMaxMessages: 2,
        });
        expect(configured.map((thread) => thread.providerSessionId)).toEqual(["recent"]);
        expect(configured[0]?.messages.map((message) => message.text)).toEqual([
          "recent First",
          "recent Fourth",
        ]);
      }),
    );
  });
});

describe("parseAgentSessionTranscript", () => {
  it("keeps only the first user message when the message limit is one", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        ...["First", "Second", "Third"].map((message) =>
          encodeTranscriptRecord({
            type: "event_msg",
            payload: { type: "user_message", message },
          }),
        ),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      maxMessages: 1,
    });

    expect(thread?.messages.map((message) => message.text)).toEqual(["First"]);
  });
});
