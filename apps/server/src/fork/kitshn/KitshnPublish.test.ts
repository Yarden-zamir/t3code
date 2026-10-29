import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as KitshnCli from "./KitshnCli.ts";
import * as KitshnPublish from "./KitshnPublish.ts";

const threadId = ThreadId.make("thread-kitshn");
const projectId = ProjectId.make("project-kitshn");
const AUTHORIZATION = Redacted.make("Bearer thread-token");

/** A workspace with a page, a dot folder, and an outside file with a link to it. */
const setup = (options: { cli?: Partial<KitshnCli.KitshnCliOutput> } = {}) =>
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

    const runs: Array<{ args: ReadonlyArray<string>; authorization: string }> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(KitshnCli.KitshnCli)({
        run: (args, authorization) =>
          Effect.sync(() => {
            runs.push({ args, authorization: Redacted.value(authorization) });
            return { exitCode: 0, stdout: "", stderr: "", ...options.cli };
          }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            worktreePath: workspace,
            deletedAt: null,
          } as unknown as OrchestrationV2ThreadShell),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
    );
    const kitshn = yield* KitshnPublish.KitshnPublish.pipe(
      Effect.provide(KitshnPublish.layer.pipe(Layer.provide(dependencies))),
    );
    return { kitshn, runs, workspace, base };
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
      const result = yield* kitshn.publish(threadId, AUTHORIZATION, {
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
          authorization: "Bearer thread-token",
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
      expect(yield* kitshn.address(AUTHORIZATION, { card: "c1", name: "new" })).toEqual({
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
      name: "a failed thread check fails closed with the daemon's text",
      cli: { exitCode: 1, stdout: '{"error":"could not check the T3 thread; try again."}' },
      expected: { reason: "refused", message: "could not check the T3 thread; try again." },
    },
    {
      name: "an inactive thread fails closed with the daemon's text",
      cli: {
        exitCode: 1,
        stdout: '{"error":"the T3 thread of this call is not active (archived or deleted)."}',
      },
      expected: {
        reason: "refused",
        message: "the T3 thread of this call is not active (archived or deleted).",
      },
    },
    {
      name: "a waiting note on stderr does not change the decoded refusal",
      cli: {
        exitCode: 1,
        stdout: '{"error":"The owner refused."}',
        stderr: "waiting: proposal p1 asks its approver circle (K-1722).\n",
      },
      expected: { reason: "refused", message: "The owner refused." },
    },
    {
      name: "a one-line failure on stderr, such as no daemon, returns that line",
      cli: {
        exitCode: 1,
        stdout: "",
        stderr: "kitshn: the daemon is not running (no daemon listens on /tmp/k.sock).\n",
      },
      expected: {
        reason: "refused",
        message: "kitshn: the daemon is not running (no daemon listens on /tmp/k.sock).",
      },
    },
    {
      name: "a crash without JSON or a line is unexpected",
      cli: { exitCode: 1, stdout: "" },
      expected: { reason: "unexpected_output" },
    },
  ])("$name", ({ cli, expected }) =>
    Effect.gen(function* () {
      const { kitshn } = yield* setup({ cli });
      expect(
        yield* reasonOf(kitshn.publish(threadId, AUTHORIZATION, { path: "site/index.html" })),
      ).toMatchObject(expected);
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
        expect((yield* reasonOf(kitshn.publish(threadId, AUTHORIZATION, { path }))).reason).toBe(
          "outside_workspace",
        );
      }
      expect(runs).toEqual([]);
    }),
  );
});
