import { EnvironmentThemeFile } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

const SHARED_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "Shared Light",
  appearance: "light",
  colors: { canvas: "#eff1f5", accent: "#1e66f5" },
};

const withEnvironmentThemes = <A, E>(
  seeds: Readonly<Record<string, string>>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentTheme.EnvironmentThemeService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-environment-theme-" });
    const themesDir = path.join(baseDir, "userdata", "themes");
    yield* fs.makeDirectory(themesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(seeds)) {
      yield* fs.writeFileString(path.join(themesDir, filename), contents);
    }

    return yield* body.pipe(
      Effect.provide(
        EnvironmentTheme.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

it.layer(NodeServices.layer)("environment theme", (it) => {
  it.effect("attaches a theme's own css file and no other", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "nightfall.css": "body { color: red; }",
        "shared-light.json": encodeThemeFile(SHARED_THEME),
        "orphan.css": "body { color: blue; }",
      },
      Effect.gen(function* () {
        const themes = yield* currentThemes;
        assert.deepEqual(
          themes.map((theme) => [theme.id, theme.css]),
          [
            ["nightfall", "body { color: red; }"],
            ["shared-light", undefined],
          ],
        );
      }),
    ),
  );

  it.effect("keeps the style fields a theme file carries", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile({
          ...NIGHTFALL_THEME,
          radius: "0",
          borderWidth: "2px",
          shadow: "4px 4px 0 0 #000",
          fonts: { sans: "Bricolage Grotesque" },
          canvasPattern: "dots",
        }),
      },
      Effect.gen(function* () {
        const [theme] = yield* currentThemes;
        assert.equal(theme?.radius, "0");
        assert.equal(theme?.borderWidth, "2px");
        assert.equal(theme?.canvasPattern, "dots");
        assert.deepEqual(theme?.fonts, { sans: "Bricolage Grotesque" });
      }),
    ),
  );
});
