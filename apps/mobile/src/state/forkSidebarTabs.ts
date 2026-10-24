/**
 * Fork: the sidebar tabs on mobile. The tabs are the server setting `sidebarTabs`, and the
 * machine map syncs them, like on web (useSidebarTabs.ts). The app shows them while a connected
 * server has `mobileSidebarTabs` on.
 */
import {
  createSidebarTab,
  pruneSidebarTabAssignments,
} from "@t3tools/client-runtime/state/sidebarTabs";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  WS_METHODS,
  type EnvironmentId,
  type SidebarTabs,
} from "@t3tools/contracts";
import type { NavigationProp } from "@react-navigation/native";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { readEnvironmentScope } from "./session";
import { environmentThreadShells } from "./threads";

let previousTabs: SidebarTabs | null = null;

/**
 * The tabs while a connected server has `mobileSidebarTabs` on, else null. They come from the
 * first such server with a tab, else the first such server. The previous value stays while the
 * tabs are equal, so a config snapshot that does not change them renders nothing.
 */
export const sidebarTabsAtom = Atom.make((get): SidebarTabs | null => {
  const enabled = [...get(environmentServerConfigsAtom).values()].filter(
    (config) => config.settings.mobileSidebarTabs,
  );
  const next = (enabled.find((config) => config.settings.sidebarTabs.tabs.length > 0) ?? enabled[0])
    ?.settings.sidebarTabs;
  if (next === undefined) return null;
  if (previousTabs !== null && Equal.equals(previousTabs, next)) return previousTabs;
  previousTabs = next;
  return next;
}).pipe(Atom.withLabel("mobile:fork-sidebar-tabs"));

/** The tab that the tab editor shows, or `default` for the first tab. */
export const editedSidebarTabIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:fork-sidebar-tab-edited"),
);

const shareMachineMapSettings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:machine-map:share-settings",
  tag: WS_METHODS.machineMapShareSettings,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

// Each write replaces the tabs whole. Two quick edits chain through this value, so the second
// does not undo the first before the server echoes it.
let pendingTabs: SidebarTabs | null = null;

/**
 * Saves a change of the tabs on each connected server with `mobileSidebarTabs` on, then
 * shares it through the machine map, so the other machines get it too. A server without the
 * settings write permission keeps its tabs.
 */
export function editSidebarTabs(change: (current: SidebarTabs) => SidebarTabs): void {
  const saved = appAtomRegistry.get(sidebarTabsAtom);
  const targets: EnvironmentId[] = [];
  for (const [environmentId, config] of appAtomRegistry.get(environmentServerConfigsAtom)) {
    if (
      config.settings.mobileSidebarTabs &&
      readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ) {
      targets.push(environmentId);
    }
  }
  if (saved === null || targets.length === 0) {
    Dialog.alert("Tabs not saved", "No connected environment lets this phone change settings.");
    return;
  }
  const current = pendingTabs ?? saved;
  const liveThreads = appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter((thread) => thread.archivedAt === null);
  const next = pruneSidebarTabAssignments(change(current), liveThreads);
  if (Equal.equals(next, current)) return;
  pendingTabs = next;
  void Promise.all(
    targets.map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateSettings,
        { environmentId, input: { patch: { sidebarTabs: next } } },
        { label: "sidebar tabs update", reportFailure: false },
      ).then((result) => ({ environmentId, result })),
    ),
  ).then((writes) => {
    if (pendingTabs === next) pendingTabs = null;
    const shared = writes.find((write) => write.result._tag === "Success");
    if (shared !== undefined) {
      void runAtomCommand(
        appAtomRegistry,
        shareMachineMapSettings,
        { environmentId: shared.environmentId, input: { server: ["sidebarTabs"], client: {} } },
        { reportFailure: false },
      );
    }
    const failed = writes.find(
      (write) => write.result._tag === "Failure" && !isAtomCommandInterrupted(write.result),
    );
    if (failed === undefined || failed.result._tag !== "Failure") return;
    const error = squashAtomCommandFailure(failed.result);
    Dialog.alert(
      "Tabs not saved",
      error instanceof Error ? error.message : "Try reconnecting and saving again.",
    );
  });
}

/** Makes a tab and returns its id. The caller moves threads into it or opens its editor. */
export function createMobileSidebarTab(
  change: (settings: SidebarTabs, id: string) => SidebarTabs = (settings) => settings,
): string {
  const id = uuidv4();
  editSidebarTabs((current) => change(createSidebarTab(current, id), id));
  return id;
}

/** Opens the editor of a tab, or of the first tab for `default`. */
export function openSidebarTabEditor(
  navigation: Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate">,
  tabId: string,
): void {
  appAtomRegistry.set(editedSidebarTabIdAtom, tabId);
  navigation.navigate("SettingsSheet", {
    screen: "SettingsContent",
    params: { screen: "SettingsSidebarTab" },
  });
}
