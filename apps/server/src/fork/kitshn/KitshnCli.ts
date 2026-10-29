/**
 * Fork: the only module that knows how T3 reaches kitshn. It runs the machine's kitshn 2 CLI, which
 * forwards each call through the local kitshn daemon. The daemon adds the machine identity and asks
 * T3 who the calling thread is (`/api/thread-identity`) with the thread's MCP credential, so an agent
 * never holds a kitshn token.
 */
import { THREAD_CREDENTIAL_AUTHORIZATION_ENV } from "@t3tools/provider-core/server/forkThreadCredential";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";

/** The documented install path of kitshn 2. It goes before PATH, where KitSHn 1 can come first. */
const KITSHN_2_HOME_PATH = [".local", "bin", "kitshn"] as const;
// A little above the daemon's own 120-second call limit, so its error reaches the agent first.
const RUN_TIMEOUT = "150 seconds";
// KitSHn 1 starts through `uv run`, which can take a while the first time.
const VERSION_TIMEOUT = "30 seconds";
// The daemon itself gives `attester set` 10 seconds.
const ATTESTER_TIMEOUT = "15 seconds";
/** The label prefix of the T3 attester; kitshn reserves it for T3 (K-1755). */
const T3_ATTESTER_PREFIX = "t3.";

/** The answer of `kitshn version --json` of kitshn 2. KitSHn 1 has no such command. */
const Kitshn2Version = Schema.Struct({
  product: Schema.Literal("kitshn"),
  generation: Schema.Literal(2),
  version: Schema.String,
});
const decodeKitshn2Version = Schema.decodeUnknownOption(Schema.fromJsonString(Kitshn2Version));

/** The answer of `kitshn attester set`: the attesters of this machine after the change. */
const Attesters = Schema.Array(
  Schema.Struct({ prefix: Schema.String, address: Schema.String, tokenEnv: Schema.String }),
);
const decodeAttesters = Schema.decodeUnknownOption(Schema.fromJsonString(Attesters));

/** The last stderr line that is not a `waiting:` note of a call that waits for the owner. */
export const lastLine = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "" && !line.startsWith("waiting:"));

export class KitshnCliError extends Schema.TaggedError<KitshnCliError>()("KitshnCliError", {
  reason: Schema.Literals(["not_installed", "not_kitshn_2", "run_failed", "attester_refused"]),
  message: Schema.String,
}) {}

export interface KitshnCliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class KitshnCli extends Context.Service<
  KitshnCli,
  {
    /** Runs `kitshn <args>` of kitshn 2 as the thread that `threadAuthorization` belongs to. */
    readonly run: (
      args: ReadonlyArray<string>,
      threadAuthorization: Redacted.Redacted<string>,
    ) => Effect.Effect<KitshnCliOutput, KitshnCliError>;
    /** Registers `url` as the T3 attester of this machine's daemon, without a credential. */
    readonly setAttester: (url: string) => Effect.Effect<void, KitshnCliError>;
    /**
     * K-602: `kitshn join <code> --server <server>` as the server user, which joins this machine
     * and starts its daemon. Its output, or the reason that it failed.
     */
    readonly join: (input: {
      readonly code: string;
      readonly server: string;
    }) => Effect.Effect<KitshnCliOutput, KitshnCliError>;
    /** The path of the machine's kitshn 2 binary, after its version check. */
    readonly binary: Effect.Effect<string, KitshnCliError>;
  }
>()("t3/fork/kitshn/KitshnCli") {}

const fail = (reason: KitshnCliError["reason"], message: string) =>
  new KitshnCliError({ reason, message });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  /** Per path and mtime, so an update or a new install is checked again. */
  const checked = new Map<string, boolean>();

  /** `~/.local/bin/kitshn`, then each `kitshn` on PATH (POSIX only), which the server reads from the login shell at start. */
  const candidates = Effect.gen(function* () {
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    // A relative entry would make the spawn search PATH again, so the checked file may not run.
    const pathDirectories = (env.PATH ?? "").split(":").filter((entry) => path.isAbsolute(entry));
    return [
      ...new Set([
        path.join(home, ...KITSHN_2_HOME_PATH),
        ...pathDirectories.map((directory) => path.join(directory, "kitshn")),
      ]),
    ];
  });

  const isKitshn2 = Effect.fn("KitshnCli.isKitshn2")(function* (
    binary: string,
    mtime: Option.Option<Date>,
  ) {
    const key = Option.map(mtime, (date) => `${binary}\0${date.getTime()}`);
    const cached = Option.flatMap(key, (value) => Option.fromNullishOr(checked.get(value)));
    if (Option.isSome(cached)) return cached.value;
    const output = yield* runner
      .run({
        command: binary,
        args: ["version", "--json"],
        // The server env can hold the credential of an agent shell that started it; kitshn skips "".
        env: { [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: "" },
        timeout: VERSION_TIMEOUT,
      })
      .pipe(Effect.option);
    const result =
      Option.isSome(output) &&
      output.value.code === 0 &&
      Option.isSome(decodeKitshn2Version(output.value.stdout));
    if (Option.isSome(key)) checked.set(key.value, result);
    return result;
  });

  const binary = Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") {
      return yield* fail("not_installed", "kitshn 2 runs on macOS and Linux, not on Windows.");
    }
    const refused: Array<string> = [];
    for (const candidate of yield* candidates) {
      const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File" || (info.value.mode & 0o111) === 0) {
        continue;
      }
      if (yield* isKitshn2(candidate, info.value.mtime)) return candidate;
      refused.push(candidate);
    }
    return yield* refused.length === 0
      ? fail("not_installed", "This machine has no kitshn 2. Join it to kitshn.")
      : fail(
          "not_kitshn_2",
          `This machine has no kitshn 2. Join it to kitshn. Found, but not kitshn 2: ${refused.join(", ")}.`,
        );
  });

  const run: KitshnCli["Service"]["run"] = Effect.fn("KitshnCli.run")(
    function* (args, threadAuthorization) {
      const command = yield* binary;
      const output = yield* runner
        .run({
          command,
          args,
          env: { [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: Redacted.value(threadAuthorization) },
          timeout: RUN_TIMEOUT,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.mapError((error) =>
            fail("run_failed", `kitshn at ${command} did not run: ${error._tag}.`),
          ),
        );
      if (output.timedOut || output.code === null) {
        return yield* fail(
          "run_failed",
          `kitshn did not finish in ${RUN_TIMEOUT}. The kitshn daemon gives each call 120 seconds.`,
        );
      }
      return { exitCode: Number(output.code), stdout: output.stdout, stderr: output.stderr };
    },
  );

  const join: KitshnCli["Service"]["join"] = Effect.fn("KitshnCli.join")(function* (input) {
    const command = yield* binary;
    const output = yield* runner
      .run({
        command,
        args: ["join", input.code, "--server", input.server],
        env: { [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: "" },
        timeout: RUN_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError((error) =>
          fail("run_failed", `kitshn at ${command} did not run: ${error._tag}.`),
        ),
      );
    if (output.timedOut || output.code === null) {
      return yield* fail("run_failed", `kitshn join did not finish in ${RUN_TIMEOUT}.`);
    }
    return { exitCode: Number(output.code), stdout: output.stdout, stderr: output.stderr };
  });

  const setAttester: KitshnCli["Service"]["setAttester"] = Effect.fn("KitshnCli.setAttester")(
    function* (url) {
      const command = yield* binary;
      const output = yield* runner
        .run({
          command,
          args: [
            "attester",
            "set",
            "--prefix",
            T3_ATTESTER_PREFIX,
            "--url",
            url,
            "--token-env",
            THREAD_CREDENTIAL_AUTHORIZATION_ENV,
          ],
          env: { [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: "" },
          timeout: ATTESTER_TIMEOUT,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.mapError((error) =>
            fail("run_failed", `kitshn at ${command} did not run: ${error._tag}.`),
          ),
        );
      if (output.timedOut || output.code === null) {
        return yield* fail(
          "run_failed",
          `kitshn attester set did not finish in ${ATTESTER_TIMEOUT}.`,
        );
      }
      if (output.code !== 0) {
        return yield* fail(
          "attester_refused",
          lastLine(output.stderr) ?? `kitshn attester set exited ${output.code}.`,
        );
      }
      const attesters = decodeAttesters(output.stdout);
      const listed =
        Option.isSome(attesters) &&
        attesters.value.some(
          (attester) =>
            attester.prefix === T3_ATTESTER_PREFIX &&
            attester.address === url &&
            attester.tokenEnv === THREAD_CREDENTIAL_AUTHORIZATION_ENV,
        );
      if (!listed) {
        return yield* fail(
          "attester_refused",
          `kitshn attester set did not list the ${T3_ATTESTER_PREFIX} attester at ${url}.`,
        );
      }
    },
  );

  return KitshnCli.of({ run, join, setAttester, binary });
});

export const layer = Layer.effect(KitshnCli, make);
