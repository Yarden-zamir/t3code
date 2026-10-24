import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const decodeFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-sidebar-tabs-test-" })),
    ),
  );

it.layer(NodeServices.layer)("sidebar tab settings", (it) => {
  it.effect("moves the old group keys of settings.json to the tab keys once", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        `{
          "mobileSidebarGroups": true,
          "enableAgentBrowserAccess": false,
          "sidebarGroups": {
            "groups": [
              { "id": "all", "name": "All", "rules": [{ "field": "group", "operator": "is_not", "values": [] }] }
            ],
            "assignments": { "environment:thread-1": "default" },
            "defaultTab": { "show": "ungrouped" }
          }
        }`,
      );

      const settings = yield* service.getSettings;
      assert.isTrue(settings.mobileSidebarTabs);
      assert.isFalse(settings.enableAgentBrowserAccess);
      assert.deepEqual(settings.sidebarTabs, {
        tabs: [
          { id: "all", name: "All", rules: [{ field: "tab", operator: "is_not", values: [] }] },
        ],
        assignments: { "environment:thread-1": "default" },
        defaultTab: { show: "untabbed" },
      });

      const file = yield* decodeFile(yield* fs.readFileString(config.settingsPath));
      assert.isFalse(Object.hasOwn(file, "sidebarGroups"));
      assert.isFalse(Object.hasOwn(file, "mobileSidebarGroups"));
      assert.deepEqual(file.sidebarTabs, settings.sidebarTabs);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
