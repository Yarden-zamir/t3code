import { KeybindingsConfig } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as Keybindings from "../keybindings.ts";

const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(KeybindingsConfig),
);

const layerKeybindings = () =>
  Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-sidebar-tab-keys-" })),
    ),
  );

it.layer(NodeServices.layer)("sidebar tab keybindings", (it) => {
  it.effect("renames the old sidebar group commands of keybindings.json at start", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const keybindings = yield* Keybindings.Keybindings;
      yield* fileSystem.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
      yield* fileSystem.writeFileString(
        keybindingsConfigPath,
        `[
          { "key": "mod+1", "command": "sidebar.group.1", "when": "sidebarFocus" },
          { "key": "mod+alt+[", "command": "sidebar.previousGroup" }
        ]`,
      );

      yield* keybindings.syncDefaultKeybindingsOnStartup;

      const rules = yield* decodeKeybindingsConfigJson(
        yield* fileSystem.readFileString(keybindingsConfigPath),
      );
      assert.deepInclude(rules, { key: "mod+1", command: "sidebar.tab.1", when: "sidebarFocus" });
      assert.deepInclude(rules, { key: "mod+alt+[", command: "sidebar.previousTab" });
      const { issues } = yield* keybindings.loadConfigState;
      assert.deepStrictEqual(issues, []);
    }).pipe(Effect.provide(layerKeybindings())),
  );
});
