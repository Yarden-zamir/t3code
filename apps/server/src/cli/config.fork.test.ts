import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  resolveCloudflareAccess,
  resolveServerConfig,
  resolveTrustedBrowserOrigins,
} from "./config.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const minimalWebFlags = (baseDir: string) => ({
  mode: Option.some("web" as const),
  port: Option.some(3773),
  host: Option.none<string>(),
  baseDir: Option.some(baseDir),
  cwd: Option.none<string>(),
  devUrl: Option.none<URL>(),
  noBrowser: Option.none<boolean>(),
  bootstrapFd: Option.none<number>(),
  autoBootstrapProjectFromCwd: Option.none<boolean>(),
  logWebSocketEvents: Option.none<boolean>(),
  tailscaleServeEnabled: Option.none<boolean>(),
  tailscaleServePort: Option.none<number>(),
});

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  // MM-1310: an existing machine keeps its own tunnel and Access login after a join.
  it.effect(
    "uses the joined machine map tunnel only while the map is on and without an explicit tunnel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-joined-tunnel-" });
        yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "machine-map-tunnel.json"),
          yield* encodeUnknownJson({
            hostname: "t3-oracle.example.com",
            access: { teamDomain: "team.cloudflareaccess.com", aud: "aud", subjects: ["a@b.c"] },
          }),
        );
        const resolve = (env: Record<string, string>) =>
          resolveServerConfig(minimalWebFlags(baseDir), Option.none()).pipe(
            Effect.provide(
              Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
            ),
          );

        // MM-1301: the joined tunnel applies only while the machine map is on.
        expect((yield* resolve({})).tunnelPairingUrl).toBeUndefined();
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "settings.json"),
          yield* encodeUnknownJson({ machineMap: { enabled: true } }),
        );

        const joined = yield* resolve({});
        expect(joined.tunnelPairingUrl).toBe("https://t3-oracle.example.com");
        expect(joined.cloudflareAccess?.subjects).toEqual(["a@b.c"]);

        const explicit = yield* resolve({
          T3CODE_TUNNEL_PAIRING_URL: "https://t3-own.example.com",
        });
        expect(explicit.tunnelPairingUrl).toBe("https://t3-own.example.com");
        expect(explicit.cloudflareAccess).toBeUndefined();
      }),
  );
});

it.effect("accepts trusted browser origins as comma or newline separated https origins", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* resolveTrustedBrowserOrigins(undefined), []);
    assert.deepEqual(
      yield* resolveTrustedBrowserOrigins(
        " https://t3-mac.example.com/,\nhttps://t3-vps.example.com ",
      ),
      ["https://t3-mac.example.com", "https://t3-vps.example.com"],
    );
  }),
);

it.effect("rejects a trusted browser origin that is not a bare https origin", () =>
  Effect.gen(function* () {
    for (const raw of [
      "http://t3.example.com",
      "https://t3.example.com/path",
      "t3.example.com",
      "https://t3.example.com, *",
    ]) {
      const error = yield* Effect.flip(resolveTrustedBrowserOrigins(raw));
      assert.include(String(error.cause), "T3CODE_TRUSTED_BROWSER_ORIGINS");
    }
  }),
);

it.effect("turns Cloudflare Access login on only when all three values are set", () =>
  Effect.gen(function* () {
    const none = { teamDomain: undefined, aud: undefined, subjects: undefined };
    assert.strictEqual(yield* resolveCloudflareAccess(none), undefined);
    assert.deepEqual(
      yield* resolveCloudflareAccess({
        teamDomain: "team.cloudflareaccess.com",
        aud: "aud-tag",
        subjects: "dev@example.com,\n abc.access ",
      }),
      {
        teamDomain: "team.cloudflareaccess.com",
        aud: "aud-tag",
        subjects: ["dev@example.com", "abc.access"],
      },
    );
    for (const partial of [
      { ...none, teamDomain: "team.cloudflareaccess.com" },
      { ...none, teamDomain: "team.cloudflareaccess.com", aud: "aud-tag" },
      { ...none, aud: "aud-tag", subjects: "dev@example.com" },
      { teamDomain: "https://team.cloudflareaccess.com", aud: "aud-tag", subjects: "a@b.c" },
    ]) {
      const error = yield* Effect.flip(resolveCloudflareAccess(partial));
      assert.include(String(error.cause), "T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    }
  }),
);
