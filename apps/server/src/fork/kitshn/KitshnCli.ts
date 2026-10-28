/**
 * Fork: the only module that knows how T3 reaches kitshn. It runs the kitshn CLI `kitshn.mjs` from a
 * pinned release with the agent key in its environment. kitshn section 17 (K-1732) replaces the agent
 * key with the local daemon (`kitshn agent …`): then only this module changes.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";

// Limit: a new kitshn CLI needs a manual bump of this tag and its hash. The CLI also owns the
// kitshn routes (`/agent/...`), so the K-718 move to `/agent/key/<path>` is a pin bump too.
// Revisit when kitshn publishes a stable release channel or T3 moves to the kitshn daemon.
export const KITSHN_CLI_PIN = {
  tag: "edge-edb49410904c",
  sha256: "ea55b48c88fe3e0e4d7b4e526738323610b67f9a0c2334f449cef70f8256c1f9",
} as const;

const MIN_NODE_MAJOR = 24;
const DOWNLOAD_TIMEOUT = "2 minutes";
// A folder site uploads many files; kitshn caps one file at 100 MB (K-1116).
const RUN_TIMEOUT = "10 minutes";

/** The agent key: a Cloudflare Access service token for the `/agent` routes of `server` (K-718). */
export const KitshnAgentKey = Schema.Struct({
  server: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.String,
});
export type KitshnAgentKey = typeof KitshnAgentKey.Type;

export class KitshnCliError extends Schema.TaggedError<KitshnCliError>()("KitshnCliError", {
  reason: Schema.Literals(["node_too_old", "download_failed", "checksum_mismatch", "run_failed"]),
  message: Schema.String,
}) {}

export interface KitshnCliOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

export class KitshnCli extends Context.Service<
  KitshnCli,
  {
    /** Runs `kitshn <args>` and returns its exit code and stdout. */
    readonly run: (
      args: ReadonlyArray<string>,
      key: KitshnAgentKey,
    ) => Effect.Effect<KitshnCliOutput, KitshnCliError>;
  }
>()("t3/fork/kitshn/KitshnCli") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const runner = yield* ProcessRunner.ProcessRunner;

  const cliPath = path.join(config.stateDir, "kitshn-cli", `kitshn-${KITSHN_CLI_PIN.tag}.mjs`);
  const url = `https://github.com/Yarden-zamir/kitshn/releases/download/${KITSHN_CLI_PIN.tag}/kitshn.mjs`;

  const fail = (reason: KitshnCliError["reason"], message: string) =>
    new KitshnCliError({ reason, message });

  const verified = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(
      Effect.orDie,
      Effect.flatMap((digest) =>
        Hex.encode(digest) === KITSHN_CLI_PIN.sha256
          ? Effect.void
          : Effect.fail(
              fail(
                "checksum_mismatch",
                `The kitshn CLI at ${cliPath} does not match the pinned SHA-256 of ${KITSHN_CLI_PIN.tag}. T3 does not run it. Delete the file to download it again.`,
              ),
            ),
      ),
    );

  const download = Effect.gen(function* () {
    const response = yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((ok) => ok.arrayBuffer),
      Effect.timeout(DOWNLOAD_TIMEOUT),
      Effect.mapError(() =>
        fail("download_failed", `Could not download the kitshn CLI from ${url}.`),
      ),
    );
    const bytes = new Uint8Array(response);
    yield* verified(bytes);
    const partial = `${cliPath}.partial`;
    yield* fileSystem.makeDirectory(path.dirname(cliPath), { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(partial, bytes)),
      Effect.andThen(fileSystem.rename(partial, cliPath)),
      Effect.mapError(() =>
        fail("download_failed", `Could not save the kitshn CLI to ${cliPath}.`),
      ),
    );
  });

  // Checked before every run, so a changed file never runs.
  const ensureCli = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(cliPath).pipe(Effect.orDie))) yield* download;
    yield* verified(yield* fileSystem.readFile(cliPath).pipe(Effect.orDie));
  });

  const run: KitshnCli["Service"]["run"] = Effect.fn("KitshnCli.run")(function* (args, key) {
    const major = Number(process.versions.node.split(".")[0]);
    if (!(major >= MIN_NODE_MAJOR)) {
      return yield* fail(
        "node_too_old",
        `The kitshn CLI needs Node ${MIN_NODE_MAJOR} or newer. This T3 server runs on Node ${process.versions.node}.`,
      );
    }
    yield* ensureCli;
    const output = yield* runner
      .run({
        // The Node that runs this server. In the desktop app that is Electron, run as Node.
        command: process.execPath,
        args: [cliPath, ...args],
        cwd: config.stateDir,
        env: {
          KITSHN_SERVER: key.server,
          CF_ACCESS_CLIENT_ID: key.clientId,
          CF_ACCESS_CLIENT_SECRET: key.clientSecret,
          ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
        },
        timeout: RUN_TIMEOUT,
      })
      .pipe(
        Effect.mapError((error) =>
          fail("run_failed", `The kitshn CLI did not run: ${error._tag}.`),
        ),
      );
    if (output.timedOut || output.code === null) {
      return yield* fail("run_failed", "The kitshn CLI did not finish in time.");
    }
    return { exitCode: Number(output.code), stdout: output.stdout };
  });

  return KitshnCli.of({ run });
});

export const layer = Layer.effect(KitshnCli, make);
