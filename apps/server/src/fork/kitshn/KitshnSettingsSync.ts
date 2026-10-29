/**
 * Fork: the T3 settings from kitshn (K-709). The `t3.settings` desired state holds a shared part
 * and a part for each machine, each `{ server, client }`. This server applies the shared part,
 * then its own part over it, to its server settings, themes and keybindings. The clients read the
 * client values from `clientSettings`.
 */
import {
  KEYBINDINGS_SETTING_KEY,
  isMachineLocalSetting,
  ScopedSettingValues,
  ServerSettings as ServerSettingsSchema,
  ServerSettingsPatch,
  type SettingValues,
  withoutMachineLocalSettings,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { applyKeybindingSettings, withSyncedKeybindings } from "../machineMap/keybindingSync.ts";
import {
  applyThemeSettings,
  THEME_SETTING_KEYS,
  withSharedThemes,
} from "../machineMap/themeSync.ts";
import type { DesiredParts } from "./kitshnProviderProtocol.ts";
import * as KitshnProvider from "./KitshnProvider.ts";

const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeEffect(ServerSettingsSchema);
const decodePart = Schema.decodeUnknownOption(ScopedSettingValues);

/** K-709: the shared part, then this machine's part over it. A part that does not decode is empty. */
export const effectiveSettings = (parts: DesiredParts | null): ScopedSettingValues => {
  const part = (value: unknown) =>
    Option.getOrElse(decodePart(value), () => ({ server: {}, client: {} }));
  const shared = part(parts?.shared ?? null);
  const machine = part(parts?.machine ?? null);
  return {
    server: { ...shared.server, ...machine.server },
    client: { ...shared.client, ...machine.client },
  };
};

export class KitshnSettingsSync extends Context.Service<
  KitshnSettingsSync,
  {
    /** Applies the settings of kitshn for the life of the server. Never fails. */
    readonly run: Effect.Effect<void>;
    /** The client values of the effective settings, then each change. */
    readonly clientSettings: Stream.Stream<SettingValues>;
  }
>()("t3/fork/kitshn/KitshnSettingsSync") {}

const make = Effect.gen(function* () {
  const provider = yield* KitshnProvider.KitshnProvider;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;

  const reportedServerSettings = Effect.fn("KitshnSettingsSync.reportedServerSettings")(function* (
    current: typeof ServerSettingsSchema.Type,
  ) {
    const encoded = yield* encodeServerSettings(
      ServerSettings.redactServerSettingsForClient(current),
    );
    return yield* withSyncedKeybindings(
      fileSystem,
      config.keybindingsConfigPath,
      withSharedThemes(
        withoutMachineLocalSettings("server", encoded as Record<string, unknown>),
        yield* environmentThemes.current,
      ),
    );
  });

  /** `previous`: the server values that applied before; at start, `values` itself. */
  const applyServerSettings = Effect.fn("KitshnSettingsSync.applyServerSettings")(function* (
    values: SettingValues,
    previous: SettingValues | null,
  ) {
    const current = yield* reportedServerSettings(yield* settings.getSettings);
    const changed: Record<string, unknown> = {};
    const changedThemeSettings: Record<string, unknown> = {};
    const skipped: Array<string> = [];
    for (const [key, value] of Object.entries(values)) {
      if (key === KEYBINDINGS_SETTING_KEY) continue;
      if (THEME_SETTING_KEYS.has(key)) {
        if (stableStringify(current[key]) !== stableStringify(value)) {
          changedThemeSettings[key] = value;
        }
        continue;
      }
      if (isMachineLocalSetting("server", key) || !Object.hasOwn(ServerSettingsPatch.fields, key)) {
        skipped.push(key);
        continue;
      }
      if (stableStringify(current[key]) === stableStringify(value)) continue;
      // One bad value must not block the others.
      const valid = yield* decodePatch({ [key]: value }).pipe(Effect.isSuccess);
      if (valid) changed[key] = value;
      else skipped.push(key);
    }
    if (skipped.length > 0) {
      yield* Effect.logWarning("kitshn settings: skipped settings that do not apply here.", {
        keys: skipped,
      });
    }
    yield* applyKeybindingSettings({
      keybindingsPath: config.keybindingsConfigPath,
      values,
      previous,
      current,
    });
    if (Object.keys(changed).length > 0) {
      yield* settings.updateSettings(yield* decodePatch(changed));
    }
    // After the patch: `t3 theme set` merges into the settings file that the patch wrote.
    yield* applyThemeSettings({
      settingsPath: config.settingsPath,
      themesDir: config.environmentThemesDir,
      changed: changedThemeSettings,
      current,
    });
  });

  // Before kitshn answered, there is no state, so the settings of this server stay as they are.
  const effective = provider.state.pipe(
    Stream.filter((state) => state.settings !== null),
    Stream.map((state) => effectiveSettings(state.settings)),
    Stream.changesWith((left, right) => stableStringify(left) === stableStringify(right)),
  );

  const run: KitshnSettingsSync["Service"]["run"] = Effect.gen(function* () {
    let previous: SettingValues | null = null;
    yield* effective.pipe(
      Stream.runForEach((values) =>
        applyServerSettings(values.server, previous ?? values.server).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              previous = values.server;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("kitshn settings: could not apply the settings.", {
              cause: String(cause),
            }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  return KitshnSettingsSync.of({
    run,
    clientSettings: effective.pipe(Stream.map((values) => values.client)),
  });
});

export const layer = Layer.effect(KitshnSettingsSync, make);
