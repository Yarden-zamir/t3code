import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import * as KitshnCli from "./KitshnCli.ts";

// kitshn may add fields; a source run prints version "dev".
const KITSHN_2 = '{"product":"kitshn","generation":2,"version":"dev","added":true}';
const AUTHORIZATION = Redacted.make("Bearer thread-token");

/**
 * Fake `kitshn` files: each answers `version --json` with its own text, and the fake runner records
 * every call. `home` gets `~/.local/bin/kitshn` when given; `path` lists the PATH folders in order.
 */
const setup = (binaries: {
  home?: string;
  path: ReadonlyArray<string>;
  /** PATH folders to give as paths relative to the cwd. */
  relative?: ReadonlyArray<string>;
  /** A Windows host: `kitshn.exe` files without an execute bit, and PATH split by `;`. */
  windows?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "kitshn-cli-" });
    const versions = new Map<string, string>();
    const install = Effect.fn(function* (directory: string, version: string) {
      yield* fs.makeDirectory(directory, { recursive: true });
      const file = path.join(directory, binaries.windows === true ? "kitshn.exe" : "kitshn");
      yield* fs.writeFileString(file, "#!/bin/sh\n");
      yield* fs.chmod(file, binaries.windows === true ? 0o644 : 0o755);
      versions.set(file, version);
      return file;
    });
    const home = path.join(base, "home");
    const homeBinary =
      binaries.home === undefined
        ? undefined
        : yield* install(path.join(home, ".local", "bin"), binaries.home);
    const pathBinaries = yield* Effect.forEach(binaries.path, (version, index) =>
      install(path.join(base, `bin${index}`), version),
    );
    const relativeBinaries = yield* Effect.forEach(binaries.relative ?? [], (version, index) =>
      install(path.join(base, `relative${index}`), version),
    );
    const runs: Array<ProcessRunner.ProcessRunInput> = [];
    const cli = yield* KitshnCli.KitshnCli.pipe(
      Effect.provide(
        KitshnCli.layer.pipe(
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: (input) =>
                Effect.sync(() => {
                  runs.push(input);
                  const version = input.args[0] === "version";
                  const answer = {
                    stdout: version ? (versions.get(input.command) ?? "") : '{"card":"c1"}',
                    stderr: version ? "" : "waiting: proposal p1 asks its approver circle.\n",
                    code: version && versions.get(input.command) === "" ? 2 : 0,
                  };
                  return {
                    stdout: answer.stdout,
                    stderr: answer.stderr,
                    code: ChildProcessSpawner.ExitCode(answer.code),
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  };
                }),
            }),
          ),
        ),
      ),
    );
    const host = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Platform, binaries.windows === true ? "win32" : "darwin"),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {
          PATH: [
            ...relativeBinaries.map((file) => path.relative(process.cwd(), path.dirname(file))),
            ...pathBinaries.map((file) => path.dirname(file)),
          ].join(binaries.windows === true ? ";" : ":"),
          LOCALAPPDATA: path.join(base, "local"),
        }),
      );
    const run = host(cli.run(["address", "c1", "new", "--json"], AUTHORIZATION));
    return { run, runs, homeBinary, pathBinaries };
  });

it.layer(NodeServices.layer)("KitshnCli", (it) => {
  it.effect("runs the first kitshn 2 on PATH with only the thread credential added", () =>
    Effect.gen(function* () {
      // KitSHn 1 has no `version --json`, so it exits non-zero; it comes first on PATH.
      const { run, runs, pathBinaries } = yield* setup({ path: ["", KITSHN_2] });
      const output = yield* run;
      expect(output).toEqual({
        exitCode: 0,
        stdout: '{"card":"c1"}',
        stderr: "waiting: proposal p1 asks its approver circle.\n",
      });
      yield* run;
      // The version check runs once per binary and mtime.
      expect(runs.map((input) => [input.command, input.args[0]])).toEqual([
        [pathBinaries[0], "version"],
        [pathBinaries[1], "version"],
        [pathBinaries[1], "address"],
        [pathBinaries[1], "address"],
      ]);
      // The runner merges `env` over the server env, so a credential there never reaches the probe
      // and the real run gets exactly this thread's value.
      expect(runs[0]?.env).toEqual({ T3_ACP_MCP_AUTHORIZATION: "", KITSHN_ATTEST: "" });
      // K-1752: the daemon asks this T3 to attest the thread token.
      expect(runs[2]?.env).toEqual({
        T3_ACP_MCP_AUTHORIZATION: "",
        KITSHN_ATTEST: "t3:thread-token",
      });
    }),
  );

  it.effect("finds kitshn.exe on a Windows PATH, which has no execute bit", () =>
    Effect.gen(function* () {
      const { run, runs, pathBinaries } = yield* setup({ path: [KITSHN_2], windows: true });
      yield* run;
      expect(runs.map((input) => input.command)).toEqual([pathBinaries[0], pathBinaries[0]]);
    }),
  );

  it.effect("prefers ~/.local/bin/kitshn over PATH", () =>
    Effect.gen(function* () {
      const { run, runs, homeBinary } = yield* setup({ home: KITSHN_2, path: [KITSHN_2] });
      yield* run;
      expect(runs.map((input) => input.command)).toEqual([homeBinary, homeBinary]);
    }),
  );

  it.effect.each([
    { name: "KitSHn 1", version: "" },
    {
      name: "another generation",
      version: '{"product":"kitshn","generation":1,"version":"0.10.0"}',
    },
    { name: "extra output", version: `${KITSHN_2}\nnote` },
  ])("refuses $name and never runs it", ({ version }) =>
    Effect.gen(function* () {
      const { run, runs, pathBinaries } = yield* setup({ path: [version] });
      const error = yield* Effect.flip(run);
      expect(error.reason).toBe("not_kitshn_2");
      expect(error.message).toContain(pathBinaries[0]);
      expect(runs.map((input) => input.args[0])).toEqual(["version"]);
    }),
  );

  it.effect("names the missing install when no kitshn exists on an absolute PATH entry", () =>
    Effect.gen(function* () {
      const { run, runs } = yield* setup({ path: [], relative: [KITSHN_2] });
      expect(yield* Effect.flip(run)).toMatchObject({
        reason: "not_installed",
        message: "This machine has no kitshn 2. Join it to kitshn.",
      });
      expect(runs).toEqual([]);
    }),
  );
});
