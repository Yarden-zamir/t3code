import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeShellIntegration } from "./shellIntegration.ts";

const layer = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcess.Platform, platform),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-shell-integration-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );

it.effect("gives Git Bash on Windows the rcfile, and PowerShell and cmd no hook", () =>
  Effect.gen(function* () {
    const integrate = yield* makeShellIntegration();
    const gitBash = integrate({ shell: "C:\\Program Files\\Git\\bin\\bash.exe" }, {});
    expect(gitBash.type === "hooked" && gitBash.candidate.args?.[0]).toBe("--rcfile");
    expect(integrate({ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }, {}).type).toBe(
      "unsupported",
    );
    expect(integrate({ shell: "C:\\Windows\\System32\\cmd.exe" }, {}).type).toBe("unsupported");
  }).pipe(Effect.provide(layer("win32"))),
);

it.effect(
  "starts shells without the hook, and says why, when the hook files cannot be written",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      // A file where the folder of the hook files must go fails the write, as a full disk would.
      yield* fileSystem.writeFileString((yield* Path.Path).join(stateDir, "shell-integration"), "");

      const integrate = yield* makeShellIntegration();
      const zsh = integrate({ shell: "/bin/zsh" }, {});
      expect(zsh.type).toBe("failed");
      expect(zsh.type === "failed" && zsh.notice).toContain("Shell integration is off");
    }).pipe(Effect.provide(layer("darwin"))),
);
