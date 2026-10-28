import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as KitshnCli from "./KitshnCli.ts";

const KEY = { server: "https://kit.example.com", clientId: "id", clientSecret: "secret" };

const cliWith = (download: string) =>
  KitshnCli.KitshnCli.pipe(
    Effect.provide(
      KitshnCli.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(HttpClientResponse.fromWeb(request, new Response(download))),
              ),
            ),
            Layer.mock(ProcessRunner.ProcessRunner)({}),
          ),
        ),
      ),
    ),
  );

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-cli-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("KitshnCli", (it) => {
  it.effect("refuses a download or a cached file that does not match the pinned hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const cached = path.join(
        stateDir,
        "kitshn-cli",
        `kitshn-${KitshnCli.KITSHN_CLI_PIN.tag}.mjs`,
      );

      const cli = yield* cliWith("console.log('not kitshn')");
      expect((yield* Effect.flip(cli.run(["address", "a", "b"], KEY))).reason).toBe(
        "checksum_mismatch",
      );
      expect(yield* fs.exists(cached)).toBe(false);

      yield* fs.makeDirectory(path.dirname(cached), { recursive: true });
      yield* fs.writeFileString(cached, "console.log('changed')");
      expect((yield* Effect.flip(cli.run(["address", "a", "b"], KEY))).reason).toBe(
        "checksum_mismatch",
      );
    }),
  );
});
