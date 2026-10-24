import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
    expect(gitBash?.candidate.args?.[0]).toBe("--rcfile");
    expect(integrate({ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }, {})).toBeNull();
    expect(integrate({ shell: "C:\\Windows\\System32\\cmd.exe" }, {})).toBeNull();
  }).pipe(Effect.provide(layer("win32"))),
);
