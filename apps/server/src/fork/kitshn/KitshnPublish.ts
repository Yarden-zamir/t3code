/**
 * Fork: agents publish files and folders to kitshn (K-1116, K-1123) and rename their addresses
 * (K-1120, K-1124). Each call runs as the calling thread through the machine's kitshn daemon.
 */
import { type ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as KitshnCli from "./KitshnCli.ts";

/** A CLI value. A leading "-" would read as a flag of the kitshn CLI. */
const CliValue = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => !value.startsWith("-") || "Must not start with '-'."),
);

export const KitshnPublishInput = Schema.Struct({
  path: CliValue,
  name: Schema.optional(CliValue),
  address: Schema.optional(CliValue).annotate({ description: "Default: a random name." }),
  zone: Schema.optional(CliValue).annotate({ description: "Folder sites only." }),
  circle: Schema.optional(CliValue).annotate({ description: "An agent circle id or name." }),
  public: Schema.optional(Schema.Boolean).annotate({ description: "Also to Everyone." }),
});
export type KitshnPublishInput = typeof KitshnPublishInput.Type;

export const KitshnAddressInput = Schema.Struct({
  card: CliValue,
  name: CliValue,
});
export type KitshnAddressInput = typeof KitshnAddressInput.Type;

/** The `--json` answers of `kitshn publish` and `kitshn address`. */
const KitshnCardKind = Schema.Literals(["page", "file", "folder"]);
export const KitshnPublishResult = Schema.Struct({
  address: TrimmedNonEmptyString,
  card: TrimmedNonEmptyString,
  kind: KitshnCardKind,
  updated: Schema.Boolean,
  revision: Schema.optional(Schema.NullOr(Schema.Int)),
});
export const KitshnAddressResult = Schema.Struct({
  address: TrimmedNonEmptyString,
  card: TrimmedNonEmptyString,
  kind: KitshnCardKind,
  revision: Schema.optional(Schema.NullOr(Schema.Int)),
});
const KitshnCliRefusal = Schema.Struct({ error: Schema.String });

export class KitshnPublishError extends Schema.TaggedError<KitshnPublishError>()(
  "KitshnPublishError",
  {
    reason: Schema.Literals([
      "outside_workspace",
      "not_found",
      "refused",
      "cli_failed",
      "unexpected_output",
    ]),
    message: Schema.String,
  },
) {}

const decodeRefusal = Schema.decodeEffect(Schema.fromJsonString(KitshnCliRefusal));
const decodePublishAnswer = Schema.decodeEffect(Schema.fromJsonString(KitshnPublishResult));
const decodeAddressAnswer = Schema.decodeEffect(Schema.fromJsonString(KitshnAddressResult));

export class KitshnPublish extends Context.Service<
  KitshnPublish,
  {
    readonly publish: (
      threadId: ThreadId,
      threadAuthorization: Redacted.Redacted<string>,
      input: KitshnPublishInput,
    ) => Effect.Effect<typeof KitshnPublishResult.Type, KitshnPublishError>;
    readonly address: (
      threadAuthorization: Redacted.Redacted<string>,
      input: KitshnAddressInput,
    ) => Effect.Effect<typeof KitshnAddressResult.Type, KitshnPublishError>;
  }
>()("t3/fork/kitshn/KitshnPublish") {}

/** The last line that is not a `waiting:` progress note. */
const lastLine = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "" && !line.startsWith("waiting:"));

const fail = (reason: KitshnPublishError["reason"], message: string) =>
  new KitshnPublishError({ reason, message });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const cli = yield* KitshnCli.KitshnCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Runs the CLI with `--json` and decodes its one JSON answer. */
  const runJson = Effect.fn("KitshnPublish.runJson")(
    function* <A>(
      threadAuthorization: Redacted.Redacted<string>,
      args: ReadonlyArray<string>,
      decodeAnswer: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
    ) {
      const output = yield* cli
        .run([...args, "--json"], threadAuthorization)
        .pipe(Effect.mapError((error) => fail("cli_failed", error.message)));
      const unexpected = () =>
        fail(
          "unexpected_output",
          `The kitshn CLI exited ${output.exitCode} with output that is not its --json answer: ${JSON.stringify(output.stdout.slice(0, 500))}. kitshn may already have made the change. Check the card before a retry.`,
        );
      if (output.exitCode === 1 || output.exitCode === 2) {
        // A failure before the CLI reads --json prints one line on stderr instead.
        const line = lastLine(output.stderr);
        const refusal = yield* decodeRefusal(output.stdout).pipe(Effect.option);
        if (Option.isSome(refusal)) return yield* fail("refused", refusal.value.error);
        if (output.stdout.trim() === "" && line !== undefined) return yield* fail("refused", line);
        return yield* unexpected();
      }
      if (output.exitCode !== 0) return yield* unexpected();
      return yield* decodeAnswer(output.stdout).pipe(Effect.mapError(unexpected));
    },
    Effect.tapError((error) =>
      error.reason === "unexpected_output"
        ? Effect.logError("kitshn CLI output did not decode")
        : Effect.void,
    ),
  );

  const workspaceRoot = Effect.fn("KitshnPublish.workspaceRoot")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) {
      return yield* fail("not_found", `Thread '${threadId}' has no workspace.`);
    }
    if (shell.worktreePath !== null) return shell.worktreePath;
    const project = yield* projects
      .getById(shell.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) {
      return yield* fail("not_found", `Thread '${threadId}' has no workspace.`);
    }
    return project.value.workspaceRoot;
  });

  /**
   * Publishing makes data public, so only a file or folder inside the thread's workspace goes out,
   * after links resolve. Dot paths stay out too, as the CLI skips them inside a folder (.git, .env).
   */
  const publishablePath = Effect.fn("KitshnPublish.publishablePath")(function* (
    threadId: ThreadId,
    requested: string,
  ) {
    const root = yield* workspaceRoot(threadId);
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError(() => fail("not_found", `The workspace ${root} does not exist.`)));
    const realTarget = yield* fileSystem
      .realPath(path.resolve(root, requested))
      .pipe(Effect.mapError(() => fail("not_found", `${requested} does not exist.`)));
    const relative = path.relative(realRoot, realTarget);
    const segments = relative === "" ? [] : relative.split(path.sep);
    if (path.isAbsolute(relative) || segments.some((segment) => segment.startsWith("."))) {
      return yield* fail(
        "outside_workspace",
        `${requested} is outside the workspace ${realRoot} or under a dot folder. kitshn_publish sends only files and folders inside the workspace.`,
      );
    }
    return realTarget;
  });

  const publish: KitshnPublish["Service"]["publish"] = Effect.fn("KitshnPublish.publish")(
    function* (threadId, threadAuthorization, input) {
      const target = yield* publishablePath(threadId, input.path);
      const option = (flag: string, value: string | undefined) =>
        value === undefined ? [] : [flag, value];
      return yield* runJson(
        threadAuthorization,
        [
          "publish",
          target,
          ...option("--name", input.name),
          ...option("--address", input.address),
          ...option("--zone", input.zone),
          ...option("--circle", input.circle),
          ...(input.public === true ? ["--public"] : []),
        ],
        decodePublishAnswer,
      );
    },
  );

  const address: KitshnPublish["Service"]["address"] = Effect.fn("KitshnPublish.address")(
    function* (threadAuthorization, input) {
      return yield* runJson(
        threadAuthorization,
        ["address", input.card, input.name],
        decodeAddressAnswer,
      );
    },
  );

  return KitshnPublish.of({ publish, address });
});

export const layer = Layer.effect(KitshnPublish, make);
