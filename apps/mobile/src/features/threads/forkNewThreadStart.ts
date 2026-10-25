import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MobileNewThreadProject } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { newThreadStartChoice } from "./forkNewThreadStartChoice";

/**
 * Fork: `mobileNewThreadProject` from the first server that changed it from `picker`. The machine
 * map syncs it to every server, so they normally agree. Null before any server config arrives.
 */
const liveNewThreadProjectAtom = Atom.make((get): MobileNewThreadProject | null => {
  const configs = [...get(environmentServerConfigsAtom).values()];
  if (configs.length === 0) return null;
  for (const config of configs) {
    if (config.settings.mobileNewThreadProject !== "picker") {
      return config.settings.mobileNewThreadProject;
    }
  }
  return "picker";
}).pipe(Atom.withLabel("mobile:fork-new-thread-project"));

/** The live value, else the value that the phone saw last, so a cold start does not wait. */
function useNewThreadProjectMode(): MobileNewThreadProject {
  const live = useAtomValue(liveNewThreadProjectAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences)
    ? preferences.value.newThreadProjectMode
    : undefined;
  useEffect(() => {
    if (live !== null && AsyncResult.isSuccess(preferences) && live !== stored) {
      savePreferences({ newThreadProjectMode: live });
    }
  }, [live, preferences, savePreferences, stored]);
  return live ?? stored ?? "picker";
}

/**
 * Fork: opens the `mobileNewThreadProject` draft once, when the project picker opens first for a
 * new thread; Back shows the picker. A project in the local list opens before the first paint, also
 * offline. Only the first thread without a project waits for the server to make that project.
 * A connected environment wins over an offline one (`newThreadStartChoice`).
 */
export function useForkNewThreadStart(input: {
  /** False when a share, a prompt link or the draft opened the picker: those keep the picker. */
  readonly enabled: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly canStartScratch: boolean;
  readonly startScratch: () => Promise<void>;
  readonly selectProject: (project: EnvironmentProject) => Promise<void>;
}): void {
  const mode = useNewThreadProjectMode();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const last = AsyncResult.isSuccess(preferences) ? preferences.value.lastNewThreadProject : null;
  const rememberedScratch = AsyncResult.isSuccess(preferences)
    ? preferences.value.scratchProject
    : undefined;
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connected = useMemo(
    () =>
      new Set(
        connectedEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId),
      ),
    [connectedEnvironments],
  );
  const ranRef = useRef(false);
  const { enabled, projects, canStartScratch, startScratch, selectProject } = input;

  // A layout effect, so a known project opens before the picker paints.
  useLayoutEffect(() => {
    if (ranRef.current || !enabled || mode === "picker") return;
    // Wait until the preferences load; a missing last project keeps the picker.
    if (!AsyncResult.isSuccess(preferences)) return;
    const choice = newThreadStartChoice({
      scratch: mode === "none" || last?.scratch === true,
      last,
      rememberedScratch,
      projects,
      isScratch: (candidate) =>
        isScratchProject(
          candidate,
          serverConfigs.get(candidate.environmentId)?.scratchWorkspaceRoot,
        ),
      connected,
      canStartScratch,
    });
    if (choice.kind === "wait") return;
    ranRef.current = true;
    if (choice.kind === "project") void selectProject(choice.project);
    // Starting without a project needs a connected environment, which `canStartScratch` checks.
    if (choice.kind === "start-scratch") void startScratch();
  }, [
    canStartScratch,
    connected,
    enabled,
    last,
    mode,
    preferences,
    projects,
    rememberedScratch,
    selectProject,
    serverConfigs,
    startScratch,
  ]);
}

/**
 * Fork: saves the project of a new thread while `mobileNewThreadProject` is `last`, and the
 * project of every thread without a project, so the next one opens without the server.
 */
export function useRememberNewThreadProject(): (
  project: EnvironmentProject,
  scratch: boolean,
) => void {
  const mode = useNewThreadProjectMode();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (project, scratch) => {
      if (scratch) {
        savePreferences({
          scratchProject: { environmentId: project.environmentId, projectId: project.id },
        });
      }
      if (mode !== "last") return;
      savePreferences({
        lastNewThreadProject: {
          environmentId: project.environmentId,
          projectId: project.id,
          scratch,
        },
      });
    },
    [mode, savePreferences],
  );
}
