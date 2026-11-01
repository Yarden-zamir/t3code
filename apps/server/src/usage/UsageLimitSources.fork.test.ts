import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

it.effect("adds a hub through the settings service without exposing its key in the result", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const settings = yield* ServerSettings.ServerSettingsService;
    const source = {
      url: "http://127.0.0.1:8317",
      label: "Local hub",
      managementKey: "private-test-key",
    };
    const [result, concurrent] = yield* Effect.all([sources.add(source), sources.add(source)], {
      concurrency: "unbounded",
    });
    expect(concurrent.id).toBe(result.id);
    const current = yield* settings.getSettings;
    expect(current.usageLimitSources[result.id]).toEqual({
      kind: "cliproxy",
      label: "Local hub",
      url: "http://127.0.0.1:8317/",
      managementKey: "private-test-key",
      enabled: true,
    });
    expect(JSON.stringify(result)).not.toContain("private-test-key");
    const retry = yield* sources.add({
      ...source,
      url: "http://127.0.0.1:8317/",
      managementKey: "private-test-key\n",
    });
    expect(retry.id).toBe(result.id);
    const conflict = yield* Effect.flip(
      sources.add({ url: "http://127.0.0.1:8317", managementKey: "different-key" }),
    );
    expect(conflict.detail).toContain("already configured");
    expect((yield* settings.getSettings).usageLimitSources[result.id]?.managementKey).toBe(
      "private-test-key",
    );
    const invalid = yield* Effect.flip(
      sources.add({ url: "http://127.0.0.1:8318", managementKey: "two\nlines" }),
    );
    expect(invalid.detail).toContain("invalid");
    expect(Object.keys((yield* settings.getSettings).usageLimitSources)).toHaveLength(1);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest(),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
