import type { ClientSettings, ProjectScript } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import { createGlobalShortcutRegistry } from "./globalShortcutRegistry.ts";

/**
 * Fork: `appToggleShortcuts`. Global shortcuts that show the app when it is in the background
 * and hide it when it is in front, like a Raycast hotkey. Both directions skip window
 * animations: macOS hides and unhides the whole app, which it does not animate.
 */
export class DesktopAppToggle extends Context.Service<
  DesktopAppToggle,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly configureScripts: (
      scripts: readonly ProjectScript[],
    ) => Effect.Effect<readonly string[]>;
  }
>()("@t3tools/desktop/window/DesktopAppToggle") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const runPromise = Effect.runPromiseWith(
    yield* Effect.context<ElectronWindow.ElectronWindow | DesktopWindow.DesktopWindow>(),
  );
  let toggleKeys: readonly string[] = [];
  let scripts: readonly ProjectScript[] = [];

  const toggle = Effect.gen(function* () {
    const window = Option.getOrNull(yield* electronWindow.currentMainOrFirst);
    if (window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
      if (environment.platform === "darwin") {
        Electron.app.hide();
      } else {
        window.hide();
      }
      return;
    }
    yield* desktopWindow.revealOrCreateMain.pipe(Effect.ignore);
  });
  const reconcile = createGlobalShortcutRegistry(
    Electron.globalShortcut,
    (action) => {
      void runPromise(
        action === "toggle"
          ? toggle
          : desktopWindow.dispatchMenuAction(action, { reveal: true }).pipe(Effect.ignore),
      ).catch(() => undefined);
    },
    environment.platform,
  );
  const refresh = () =>
    reconcile([
      ...toggleKeys.map((accelerator) => ({ accelerator, action: "toggle" })),
      ...scripts.flatMap((script) =>
        script.globalShortcut
          ? [{ accelerator: script.globalShortcut, action: `global-script:${script.id}` }]
          : [],
      ),
    ]);

  const configure = Effect.fn("desktop.appToggle.configure")(function* (settings: ClientSettings) {
    toggleKeys = [...new Set(settings.appToggleShortcuts)];
    for (const accelerator of refresh()) {
      yield* Effect.logWarning("Global shortcut could not be registered.").pipe(
        Effect.annotateLogs({ accelerator }),
      );
    }
  });

  return DesktopAppToggle.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) => (Option.isSome(stored) ? configure(stored.value) : Effect.void)),
      Effect.ignore,
    ),
    configure,
    configureScripts: Effect.fn("desktop.appToggle.configureScripts")((next) =>
      Effect.sync(() => {
        scripts = next;
        return refresh();
      }),
    ),
  });
});

export const layer = Layer.effect(DesktopAppToggle, make);
