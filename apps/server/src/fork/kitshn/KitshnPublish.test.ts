import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  SecretRef,
  SecretRequestError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as KitshnCli from "./KitshnCli.ts";
import * as KitshnPublish from "./KitshnPublish.ts";

const threadId = ThreadId.make("thread-kitshn");
const projectId = ProjectId.make("project-kitshn");
const KEY = { server: "https://kit.example.com", clientId: "id-1", clientSecret: "secret-1" };

/** A workspace with a page, a dot folder, and an outside file with a link to it. */
const setup = (
  options: { cli?: KitshnCli.KitshnCliOutput; key?: boolean; delegated?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "kitshn-" }));
    const workspace = path.join(base, "workspace");
    yield* fs.makeDirectory(path.join(workspace, "site"), { recursive: true });
    yield* fs.makeDirectory(path.join(workspace, ".git"));
    yield* fs.writeFileString(path.join(workspace, "site", "index.html"), "<h1>hi</h1>");
    yield* fs.writeFileString(path.join(workspace, ".git", "config"), "token");
    yield* fs.writeFileString(path.join(base, "outside.txt"), "private");
    yield* fs.symlink(path.join(base, "outside.txt"), path.join(workspace, "link.txt"));

    const runs: Array<{ args: ReadonlyArray<string>; key: KitshnCli.KitshnAgentKey }> = [];
    const stored = new Map<string, Uint8Array>();
    if (options.key !== false)
      stored.set("kitshn-agent-key", new TextEncoder().encode(JSON.stringify(KEY)));
    const answers = new Map([
      [SecretRef.make("secret-ref:server"), " https://kit.example.org/ "],
      [SecretRef.make("secret-ref:bad-server"), "http://kit.example.org"],
      [SecretRef.make("secret-ref:id"), "id-2"],
      [SecretRef.make("secret-ref:secret"), "secret-2"],
    ]);
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        KitshnCli.KitshnCli,
        KitshnCli.KitshnCli.of({
          run: (args, key) =>
            Effect.sync(() => {
              runs.push({ args, key });
              return options.cli ?? { exitCode: 0, stdout: "" };
            }),
        }),
      ),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
      Layer.mock(SecretRequests.SecretRequests)({
        consumeAll: (input) => {
          const values = input.refs.map((ref) => answers.get(ref));
          if (input.projectId !== projectId || values.some((value) => value === undefined)) {
            return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
          }
          for (const ref of input.refs) answers.delete(ref);
          return Effect.succeed(values as Array<string>);
        },
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            worktreePath: workspace,
            deletedAt: null,
            lineage: {
              parentThreadId: options.delegated === true ? ThreadId.make("thread-parent") : null,
            },
          } as unknown as OrchestrationV2ThreadShell),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
    );
    const kitshn = yield* KitshnPublish.KitshnPublish.pipe(
      Effect.provide(KitshnPublish.layer.pipe(Layer.provide(dependencies))),
    );
    return { kitshn, runs, stored, workspace, base };
  });

const reasonOf = <A>(effect: Effect.Effect<A, KitshnPublish.KitshnPublishError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ({ reason: error.reason, message: error.message })),
  );

it.layer(NodeServices.layer)("KitshnPublish", (it) => {
  it.effect("publish passes the real workspace path and decodes the --json answer", () =>
    Effect.gen(function* () {
      const answer = {
        address: "pages.example.com/calm-otter-42",
        card: "c1",
        kind: "page",
        updated: false,
        revision: null,
      };
      const { kitshn, runs, workspace } = yield* setup({
        cli: { exitCode: 0, stdout: `${JSON.stringify({ ...answer, extra: 1 })}\n` },
      });
      const result = yield* kitshn.publish(threadId, {
        path: "site",
        address: "calm-otter-42",
        circle: "Agents",
        public: true,
      });
      expect(result).toEqual(answer);
      expect(runs).toEqual([
        {
          args: [
            "publish",
            `${workspace}/site`,
            "--address",
            "calm-otter-42",
            "--circle",
            "Agents",
            "--public",
            "--json",
          ],
          key: KEY,
        },
      ]);
    }),
  );

  it.effect("address decodes the --json answer", () =>
    Effect.gen(function* () {
      const { kitshn, runs } = yield* setup({
        cli: {
          exitCode: 0,
          stdout:
            '{"address":"pages.example.com/new","card":"c1","kind":"file","updated":true,"revision":4}',
        },
      });
      expect(yield* kitshn.address({ card: "c1", name: "new" })).toEqual({
        address: "pages.example.com/new",
        card: "c1",
        kind: "file",
        revision: 4,
      });
      expect(runs[0]?.args).toEqual(["address", "c1", "new", "--json"]);
    }),
  );

  it.effect.each([
    {
      name: "a kitshn refusal returns its text as is",
      cli: { exitCode: 1, stdout: '{"error":"This address is taken."}' },
      expected: { reason: "refused", message: "This address is taken." },
    },
    {
      name: "human text is unexpected",
      cli: { exitCode: 0, stdout: "kitshn: published a.html at https://pages.example.com/a" },
      expected: {
        reason: "unexpected_output",
        message: expect.stringContaining("kitshn may already have made the change"),
      },
    },
    {
      name: "extra output after the JSON is unexpected",
      cli: {
        exitCode: 0,
        stdout: '{"address":"a","card":"c","kind":"page","updated":true}\nkitshn: note',
      },
      expected: { reason: "unexpected_output" },
    },
    {
      name: "a wrong shape is unexpected",
      cli: { exitCode: 0, stdout: '{"address":"a","card":"c","kind":"site","updated":true}' },
      expected: { reason: "unexpected_output" },
    },
    {
      name: "an empty address is unexpected",
      cli: { exitCode: 0, stdout: '{"address":"","card":"c","kind":"page","updated":false}' },
      expected: { reason: "unexpected_output" },
    },
    {
      name: "a crash without JSON is unexpected",
      cli: { exitCode: 1, stdout: "" },
      expected: { reason: "unexpected_output" },
    },
  ])("$name", ({ cli, expected }) =>
    Effect.gen(function* () {
      const { kitshn } = yield* setup({ cli });
      expect(yield* reasonOf(kitshn.publish(threadId, { path: "site/index.html" }))).toMatchObject(
        expected,
      );
    }),
  );

  it.effect("without a key the tools refuse and run nothing", () =>
    Effect.gen(function* () {
      const { kitshn, runs } = yield* setup({ key: false });
      expect((yield* reasonOf(kitshn.address({ card: "c1", name: "new" }))).reason).toBe("no_key");
      expect(runs).toEqual([]);
    }),
  );

  it.effect("publish refuses paths outside the workspace or under a dot folder", () =>
    Effect.gen(function* () {
      const { kitshn, runs, base } = yield* setup();
      for (const path of [
        "../outside.txt",
        `${base}/outside.txt`,
        "link.txt",
        ".git/config",
        ".git",
      ]) {
        expect((yield* reasonOf(kitshn.publish(threadId, { path }))).reason).toBe(
          "outside_workspace",
        );
      }
      expect(runs).toEqual([]);
    }),
  );

  it.effect("set spends the three refs and status never shows the key; clear removes it", () =>
    Effect.gen(function* () {
      const { kitshn, stored } = yield* setup({ key: false });
      const set = kitshn.setKey({
        threadId,
        serverRef: SecretRef.make("secret-ref:server"),
        clientIdRef: SecretRef.make("secret-ref:id"),
        clientSecretRef: SecretRef.make("secret-ref:secret"),
      });
      expect(yield* set).toEqual({ set: true, server: "https://kit.example.org" });
      expect(JSON.parse(new TextDecoder().decode(stored.get("kitshn-agent-key")))).toEqual({
        server: "https://kit.example.org",
        clientId: "id-2",
        clientSecret: "secret-2",
      });
      expect((yield* reasonOf(set)).reason).toBe("invalid_key");
      expect(yield* kitshn.keyStatus).toEqual({ set: true, server: "https://kit.example.org" });
      expect(yield* kitshn.clearKey(threadId)).toEqual({ set: false, server: null });
      expect(yield* kitshn.keyStatus).toEqual({ set: false, server: null });
    }),
  );

  it.effect("set refuses a server answer that is not https", () =>
    Effect.gen(function* () {
      const { kitshn, stored } = yield* setup({ key: false });
      const set = kitshn.setKey({
        threadId,
        serverRef: SecretRef.make("secret-ref:bad-server"),
        clientIdRef: SecretRef.make("secret-ref:id"),
        clientSecretRef: SecretRef.make("secret-ref:secret"),
      });
      expect((yield* reasonOf(set)).reason).toBe("invalid_key");
      expect(stored.has("kitshn-agent-key")).toBe(false);
    }),
  );

  it.effect("a delegated thread reads the key status but cannot set or clear the key", () =>
    Effect.gen(function* () {
      const { kitshn, stored } = yield* setup({ delegated: true });
      const set = kitshn.setKey({
        threadId,
        serverRef: SecretRef.make("secret-ref:server"),
        clientIdRef: SecretRef.make("secret-ref:id"),
        clientSecretRef: SecretRef.make("secret-ref:secret"),
      });
      expect((yield* reasonOf(set)).reason).toBe("not_top_level");
      expect((yield* reasonOf(kitshn.clearKey(threadId))).reason).toBe("not_top_level");
      expect(yield* kitshn.keyStatus).toEqual({ set: true, server: KEY.server });
      expect(stored.has("kitshn-agent-key")).toBe(true);
    }),
  );
});
