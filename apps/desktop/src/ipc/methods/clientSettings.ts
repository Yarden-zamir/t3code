import { ClientSettingsSchema, ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as DesktopAppToggle from "../../window/DesktopAppToggle.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const configureGlobalScriptShortcuts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONFIGURE_GLOBAL_SCRIPT_SHORTCUTS_CHANNEL,
  payload: Schema.Array(ProjectScript),
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.globalScriptShortcuts.configure")(function* (scripts, event) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const main = yield* electronWindow.main;
    if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id) {
      return scripts.flatMap((script) => (script.globalShortcut ? [script.globalShortcut] : []));
    }
    const appToggle = yield* DesktopAppToggle.DesktopAppToggle;
    return yield* appToggle.configureScripts(scripts);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    const appToggle = yield* DesktopAppToggle.DesktopAppToggle;
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    yield* appToggle.configure(settings);
  }),
});
