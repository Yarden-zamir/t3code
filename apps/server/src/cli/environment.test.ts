// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { descriptorOf, servePeer } from "../peer/PeerLinks.testkit.ts";
import { MANUAL_LINK_REFUSAL } from "../fork/machineMap/machineAccess.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

/** The batch reports printed so far; the logger writes to the same console. */
const reports = TestConsole.logLines.pipe(
  Effect.map((lines) =>
    lines.filter((line): line is string => typeof line === "string" && line.includes(" linked.")),
  ),
);

/** A machine of the fleet, on a socket of its own. */
const serveMachine = (descriptor: ExecutionEnvironmentDescriptor) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      servePeer(descriptor, Layer.empty).pipe(Effect.provideContext(server)),
    ),
  );

// Fork (MM-1921): links come from kitshn, so a file of environments links none of them.
it.effect("refuses each line of a file of environments without sending or printing its code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-environment-cli-" });
      const { settingsPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(NodePath.dirname(settingsPath), { recursive: true });
      yield* fs.writeFileString(settingsPath, JSON.stringify({ linkedEnvironmentsEnabled: true }));

      const one = yield* serveMachine(descriptorOf("environment-vm-1", "VM 1"));
      const two = yield* serveMachine(descriptorOf("environment-vm-2", "VM 2"));
      const code = yield* one.auth
        .issuePairingCredential({ access: "auto", purpose: "peer-link" })
        .pipe(Effect.map((pairing) => pairing.credential));

      const file = NodePath.join(baseDir, "fleet.txt");
      yield* fs.writeFileString(file, `# fleet\n${one.url} ${code}\n\n${two.url} not-a-code\n`);
      const failed = yield* runCli([
        "environment",
        "link",
        "--from",
        file,
        "--access",
        "auto",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      expect(failed).toMatchObject({ _tag: "EnvironmentLinkBatchError", failed: 2, total: 2 });
      const report = (yield* reports).at(-1) ?? "";
      expect(report).toContain(`${one.url}: `);
      expect(report).toContain(MANUAL_LINK_REFUSAL);
      expect(report).toContain("0 of 2 linked.");
      expect(report).not.toContain(code);
      expect(report).not.toContain("not-a-code");
      expect(yield* one.linkedSessions).toEqual([]);
      expect(yield* two.linkedSessions).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer))),
);
