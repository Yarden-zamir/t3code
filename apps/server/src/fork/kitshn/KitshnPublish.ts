/**
 * Fork: agents publish files and folders to kitshn (K-1116, K-1123) and rename their addresses
 * (K-1120, K-1124). The agent key stays in the server secret store; the owner sets it through
 * `request_secret` refs, so its values never reach a thread, a setting or a log.
 */
import { type SecretRef, type ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as KitshnCli from "./KitshnCli.ts";

const KEY_SECRET_NAME = "kitshn-agent-key";

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
  revision: Schema.optional(Schema.Number),
});
export const KitshnAddressResult = Schema.Struct({
  address: TrimmedNonEmptyString,
  card: TrimmedNonEmptyString,
  kind: KitshnCardKind,
  revision: Schema.optional(Schema.Number),
});
const KitshnCliRefusal = Schema.Struct({ error: Schema.String });

export const KitshnKeyStatus = Schema.Struct({
  set: Schema.Boolean,
  server: Schema.NullOr(Schema.String),
});
export type KitshnKeyStatus = typeof KitshnKeyStatus.Type;

export class KitshnPublishError extends Schema.TaggedError<KitshnPublishError>()(
  "KitshnPublishError",
  {
    reason: Schema.Literals([
      "no_key",
      "invalid_key",
      "outside_workspace",
      "not_found",
      "refused",
      "cli_failed",
      "unexpected_output",
      "store_failed",
    ]),
    message: Schema.String,
  },
) {}

const StoredKey = Schema.fromJsonString(KitshnCli.KitshnAgentKey);
const decodeStoredKey = Schema.decodeEffect(StoredKey);
const encodeStoredKey = Schema.encodeEffect(StoredKey);
const decodeRefusal = Schema.decodeEffect(Schema.fromJsonString(KitshnCliRefusal));
const decodePublishAnswer = Schema.decodeEffect(Schema.fromJsonString(KitshnPublishResult));
const decodeAddressAnswer = Schema.decodeEffect(Schema.fromJsonString(KitshnAddressResult));

export class KitshnPublish extends Context.Service<
  KitshnPublish,
  {
    readonly keyStatus: Effect.Effect<KitshnKeyStatus, KitshnPublishError>;
    /** Consumes both refs, so the owner's answers are spent. */
    readonly setKey: (input: {
      readonly threadId: ThreadId;
      readonly server: string;
      readonly clientIdRef: SecretRef;
      readonly clientSecretRef: SecretRef;
    }) => Effect.Effect<KitshnKeyStatus, KitshnPublishError>;
    readonly clearKey: Effect.Effect<KitshnKeyStatus, KitshnPublishError>;
    readonly publish: (
      threadId: ThreadId,
      input: KitshnPublishInput,
    ) => Effect.Effect<typeof KitshnPublishResult.Type, KitshnPublishError>;
    readonly address: (
      input: KitshnAddressInput,
    ) => Effect.Effect<typeof KitshnAddressResult.Type, KitshnPublishError>;
  }
>()("t3/fork/kitshn/KitshnPublish") {}

const fail = (reason: KitshnPublishError["reason"], message: string) =>
  new KitshnPublishError({ reason, message });

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const cli = yield* KitshnCli.KitshnCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const storeFailed = () => fail("store_failed", "Could not read or write the kitshn agent key.");

  const readKey = secrets.get(KEY_SECRET_NAME).pipe(
    Effect.mapError(storeFailed),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<KitshnCli.KitshnAgentKey>()),
        onSome: (bytes) =>
          decodeStoredKey(new TextDecoder().decode(bytes)).pipe(
            Effect.asSome,
            Effect.mapError(storeFailed),
          ),
      }),
    ),
  );

  const statusOf = (key: Option.Option<KitshnCli.KitshnAgentKey>): KitshnKeyStatus => ({
    set: Option.isSome(key),
    server: Option.match(key, { onNone: () => null, onSome: (value) => value.server }),
  });

  const keyStatus = readKey.pipe(Effect.map(statusOf), Effect.withSpan("KitshnPublish.keyStatus"));

  const setKey: KitshnPublish["Service"]["setKey"] = Effect.fn("KitshnPublish.setKey")(
    function* (input) {
      const server = URL.parse(input.server);
      if (server === null || server.protocol !== "https:") {
        return yield* fail(
          "invalid_key",
          "server must be an https URL, such as https://kit.example.com.",
        );
      }
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null)
        return yield* fail("not_found", `Thread '${input.threadId}' was not found.`);
      // A ref works only in the project of the thread that asked for it.
      const consume = (ref: SecretRef) =>
        secretRequests
          .consume({ ref, projectId: shell.projectId })
          .pipe(
            Effect.mapError((error) =>
              fail(
                "invalid_key",
                `A secretRef is not usable (${error.reason}). Ask with request_secret again.`,
              ),
            ),
          );
      const clientId = yield* consume(input.clientIdRef);
      const clientSecret = yield* consume(input.clientSecretRef);
      const key = { server: server.origin, clientId, clientSecret };
      const encoded = yield* encodeStoredKey(key).pipe(Effect.mapError(storeFailed));
      yield* secrets
        .set(KEY_SECRET_NAME, new TextEncoder().encode(encoded))
        .pipe(Effect.mapError(storeFailed));
      return statusOf(Option.some(key));
    },
  );

  const clearKey = secrets
    .remove(KEY_SECRET_NAME)
    .pipe(
      Effect.mapError(storeFailed),
      Effect.as(statusOf(Option.none())),
      Effect.withSpan("KitshnPublish.clearKey"),
    );

  /** Runs the CLI with `--json` and decodes its one JSON answer. */
  const runJson = Effect.fn("KitshnPublish.runJson")(
    function* <A>(
      args: ReadonlyArray<string>,
      decodeAnswer: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
    ) {
      const key = yield* readKey;
      if (Option.isNone(key)) {
        return yield* fail(
          "no_key",
          "No kitshn agent key is set on this T3 server. The owner must add one: kitshn_agent_key with action set.",
        );
      }
      const output = yield* cli
        .run([...args, "--json"], key.value)
        .pipe(Effect.mapError((error) => fail("cli_failed", error.message)));
      const unexpected = () =>
        fail(
          "unexpected_output",
          `The kitshn CLI exited ${output.exitCode} with output that is not its --json answer: ${JSON.stringify(output.stdout.slice(0, 500))}`,
        );
      if (output.exitCode === 1) {
        const refusal = yield* decodeRefusal(output.stdout).pipe(Effect.mapError(unexpected));
        return yield* fail("refused", refusal.error);
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
    function* (threadId, input) {
      const target = yield* publishablePath(threadId, input.path);
      const option = (flag: string, value: string | undefined) =>
        value === undefined ? [] : [flag, value];
      return yield* runJson(
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
    function* (input) {
      return yield* runJson(["address", input.card, input.name], decodeAddressAnswer);
    },
  );

  return KitshnPublish.of({ keyStatus, setKey, clearKey, publish, address });
});

export const layer = Layer.effect(KitshnPublish, make);
