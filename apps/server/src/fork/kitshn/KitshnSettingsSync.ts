/**
 * Fork: the T3 settings from kitshn (K-709). The `t3.settings` desired state holds a shared part
 * and a part for each machine, each `{ server, client }`. This server applies the shared part,
 * then its own part over it, to its server settings, themes and keybindings. The clients read the
 * client values from `clientSettings`.
 */
import type { DesiredParts } from "@kitshn/local";
import {
  KEYBINDINGS_SETTING_KEY,
  type MachineMapClientState,
  type MachineMapShareSettingsInput,
  type MachineMapShareSettingsResult,
  isMachineLocalSetting,
  ScopedSettingValues,
  ServerSettings as ServerSettingsSchema,
  ServerSettingsPatch,
  type SettingValues,
  withoutMachineLocalSettings,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
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
import * as KitshnConnection from "./KitshnConnection.ts";
import * as KitshnGrants from "./KitshnGrants.ts";
import * as KitshnProvider from "./KitshnProvider.ts";

const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const CLIENT_STATE_REFRESH = Duration.seconds(30);
// K-709: the daemon waits up to 60 seconds for kitshn, then the `desired` event echoes the rev.
const STORE_WAIT = Duration.seconds(65);
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

/** MM-411: the shared part with the saved values of `input.server` and the `input.client` values. */
export const sharedPartAfterShare = (
  shared: ScopedSettingValues,
  savedServer: SettingValues,
  input: MachineMapShareSettingsInput,
): ScopedSettingValues => {
  const server = { ...shared.server };
  for (const key of input.server) {
    if (!isMachineLocalSetting("server", key) && Object.hasOwn(savedServer, key)) {
      server[key] = savedServer[key];
    }
  }
  return {
    server,
    client: { ...shared.client, ...withoutMachineLocalSettings("client", input.client) },
  };
};

/** Why one setting could not be set in `t3.settings`. */
export class KitshnSettingRefused extends Schema.TaggedError<KitshnSettingRefused>()(
  "KitshnSettingRefused",
  { message: Schema.String },
) {}

export interface SettingChange {
  readonly part: "machine" | "shared";
  readonly scope: "server" | "client";
  readonly key: string;
  /** Undefined clears the key. */
  readonly value: unknown;
}

/**
 * K-709: sets one part of `t3.settings` and waits until kitshn stored it: the next `desired` event
 * of the kind echoes the `rev` of this set.
 */
const storeSettingsPart = (
  kitshn: KitshnConnection.KitshnConnection["Service"],
  rev: string,
  part: "machine" | "shared",
  value: unknown,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* kitshn.subscribe;
      yield* kitshn.request({
        type: "desired-set",
        provider: KitshnProvider.PROVIDER_NAME,
        kind: KitshnProvider.SETTINGS_KIND,
        part,
        value,
        rev,
      });
      const echoed = yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (event) =>
            event.type === "desired" &&
            event.kind === KitshnProvider.SETTINGS_KIND &&
            event.rev === rev,
        }),
        Effect.timeoutOption(STORE_WAIT),
      );
      if (Option.isNone(echoed)) {
        return yield* new KitshnConnection.KitshnRequestError({
          message:
            "kitshn took the setting but did not confirm that it stored it. Check it again later.",
        });
      }
    }),
  );

/** K-709: the rule and the write of `KitshnSettingsSync.setOne`, on this provider connection. */
export const makeSetOne = (
  provider: Pick<KitshnProvider.KitshnProvider["Service"], "state">,
  kitshn: KitshnConnection.KitshnConnection["Service"],
  newRev: Effect.Effect<string>,
) =>
  Effect.fn("KitshnSettingsSync.setOne")(function* (change: SettingChange, by: "owner" | "agent") {
    if (isMachineLocalSetting(change.scope, change.key)) {
      return yield* new KitshnSettingRefused({
        message: `${change.key} belongs to one machine and is not set through kitshn.`,
      });
    }
    if (change.part === "shared" && by === "agent") {
      return yield* new KitshnSettingRefused({
        message:
          "Agents do not change the shared settings of every machine. Set part machine for this machine, or ask the owner to change the shared value in T3 Settings with All environments.",
      });
    }
    const current = yield* provider.state.pipe(Stream.runHead);
    const before: ScopedSettingValues = Option.getOrElse(
      Option.flatMap(current, (state) => decodePart(state.settings?.[change.part] ?? null)),
      () => ({ server: {}, client: {} }),
    );
    const { [change.key]: _old, ...rest } = before[change.scope];
    const next: ScopedSettingValues = {
      ...before,
      [change.scope]: change.value === undefined ? rest : { ...rest, [change.key]: change.value },
    };
    yield* storeSettingsPart(kitshn, yield* newRev, change.part, next).pipe(
      Effect.mapError((error) => new KitshnSettingRefused({ message: error.message })),
    );
  });

export class KitshnSettingsSync extends Context.Service<
  KitshnSettingsSync,
  {
    /** Applies the settings of kitshn for the life of the server. Never fails. */
    readonly run: Effect.Effect<void>;
    /** What a client needs of the kitshn connection, then each change (`machineMap.subscribe`). */
    readonly clientState: Stream.Stream<MachineMapClientState>;
    /**
     * MM-411 on kitshn: puts the saved values of these server keys and these client values into
     * the shared part of `t3.settings`. False when this server is not a kitshn provider.
     */
    readonly share: (
      input: MachineMapShareSettingsInput,
    ) => Effect.Effect<MachineMapShareSettingsResult>;
    /**
     * K-709: sets or clears one key of one part. The shared part reaches every machine, also
     * machines whose grants this server cannot see, so an agent never sets it; the owner does.
     * Known limit: an agent shell can still send `desired-set` to the daemon socket itself; only
     * kitshn can close that path (a shared part that only the owner sets).
     */
    readonly setOne: (
      change: SettingChange,
      by: "owner" | "agent",
    ) => Effect.Effect<void, KitshnSettingRefused>;
  }
>()("t3/fork/kitshn/KitshnSettingsSync") {}

const make = Effect.gen(function* () {
  const provider = yield* KitshnProvider.KitshnProvider;
  const kitshn = yield* KitshnConnection.KitshnConnection;
  const grants = yield* KitshnGrants.KitshnGrants;
  const crypto = yield* Crypto.Crypto;
  // K-709: a set's mark only needs to differ from the other sets of this server.
  const newRev = crypto.randomUUIDv4().pipe(Effect.orDie);
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

  // The machine and the link proxy change without an event of their own, so a tick reads them
  // again; the dedupe below sends only a real change.
  const clientState: KitshnSettingsSync["Service"]["clientState"] = Stream.zipLatestAll(
    provider.state,
    provider.connection,
    Stream.tick(CLIENT_STATE_REFRESH),
  ).pipe(
    Stream.mapEffect(([state, connection]) =>
      Effect.all([grants.active, grants.machine, provider.linkSocket]).pipe(
        Effect.map(([joined, machine, linkSocket]): MachineMapClientState => ({
          joined,
          machine,
          settings: effectiveSettings(state.settings),
          connection: {
            status: connection.status,
            detail: connection.detail,
            restartedAt: connection.status === "registered" ? connection.restartedAt : null,
            reachedMachines: new Set(state.reach.map((card) => card.machineId)).size,
            linkProxy: linkSocket !== null,
            syncedAt: state.syncedAt,
            paused: state.paused,
            problems: state.problems,
          },
        })),
      ),
    ),
    Stream.changesWith((left, right) => stableStringify(left) === stableStringify(right)),
  );

  const share: KitshnSettingsSync["Service"]["share"] = Effect.fn("KitshnSettingsSync.share")(
    function* (input) {
      if (!(yield* grants.active)) return { shared: false };
      const current = yield* reportedServerSettings(yield* settings.getSettings);
      const state = yield* provider.state.pipe(Stream.runHead);
      const shared = Option.getOrElse(
        Option.flatMap(state, (value) => decodePart(value.settings?.shared ?? null)),
        () => ({ server: {}, client: {} }),
      );
      return yield* storeSettingsPart(
        kitshn,
        yield* newRev,
        "shared",
        sharedPartAfterShare(shared, current, input),
      ).pipe(
        Effect.as({ shared: true }),
        Effect.catch((error) =>
          Effect.logWarning("kitshn settings: could not share the settings.", {
            cause: error.message,
          }).pipe(Effect.as({ shared: false })),
        ),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.catch((cause) =>
      Effect.logWarning("kitshn settings: could not read the settings to share.", {
        cause: String(cause),
      }).pipe(Effect.as({ shared: false })),
    ),
  );

  const setOne = makeSetOne(provider, kitshn, newRev);

  return KitshnSettingsSync.of({ run, clientState, share, setOne });
});

export const layer = Layer.effect(KitshnSettingsSync, make);
