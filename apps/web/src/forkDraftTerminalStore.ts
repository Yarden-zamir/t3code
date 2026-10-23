import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

/** The shell of the server that the terminal manager picks when a draft names none. */
export const DEFAULT_DRAFT_SHELL = null;

/**
 * Fork: the drafts in Terminal mode (`ForkDraftTerminalComposer`). Such a draft shows a live
 * shell in place of the prompt, under the thread id that the draft reserves, until its first
 * command makes it a terminal thread. A draft that is not in the map is in Agent mode.
 */
interface ForkDraftTerminalState {
  /** Draft id to the shell slug of its terminal, or null for the default shell. */
  readonly shellByDraftId: Readonly<Record<string, string | null>>;
  /** The shell that the user picked last per environment, the default of the next draft. */
  readonly lastShellByEnvironmentId: Readonly<Record<string, string>>;
  readonly enterTerminalMode: (draftId: string, environmentId: string) => void;
  readonly setShell: (draftId: string, environmentId: string, shell: string) => void;
  readonly leaveTerminalMode: (draftId: string) => void;
}

export const useForkDraftTerminalStore = create<ForkDraftTerminalState>()(
  persist(
    (set) => ({
      shellByDraftId: {},
      lastShellByEnvironmentId: {},
      enterTerminalMode: (draftId, environmentId) =>
        set((state) => {
          if (draftId in state.shellByDraftId) return state;
          // Drafts that other paths removed (sent, discarded) leave nothing behind.
          const drafts = useComposerDraftStore.getState().draftThreadsByThreadKey;
          const live = Object.entries(state.shellByDraftId).filter(([id]) => id in drafts);
          return {
            shellByDraftId: {
              ...Object.fromEntries(live),
              [draftId]: state.lastShellByEnvironmentId[environmentId] ?? DEFAULT_DRAFT_SHELL,
            },
          };
        }),
      setShell: (draftId, environmentId, shell) =>
        set((state) => ({
          shellByDraftId: { ...state.shellByDraftId, [draftId]: shell },
          lastShellByEnvironmentId: { ...state.lastShellByEnvironmentId, [environmentId]: shell },
        })),
      leaveTerminalMode: (draftId) =>
        set((state) => {
          if (!(draftId in state.shellByDraftId)) return state;
          const { [draftId]: _left, ...shellByDraftId } = state.shellByDraftId;
          return { shellByDraftId };
        }),
    }),
    {
      name: "t3code:fork:draft-terminals:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ shellByDraftId, lastShellByEnvironmentId }) => ({
        shellByDraftId,
        lastShellByEnvironmentId,
      }),
    },
  ),
);

/** The shell of a draft in Terminal mode, or undefined for a draft in Agent mode. */
export function useDraftTerminalShell(draftId: string | null): string | null | undefined {
  return useForkDraftTerminalStore((state) =>
    draftId !== null && draftId in state.shellByDraftId ? state.shellByDraftId[draftId] : undefined,
  );
}

/** Puts a draft in Terminal mode, or back in Agent mode. */
export function setDraftTerminalMode(draftId: string, environmentId: string, terminal: boolean) {
  const store = useForkDraftTerminalStore.getState();
  if (terminal) store.enterTerminalMode(draftId, environmentId);
  else store.leaveTerminalMode(draftId);
}

export function setDraftTerminalShell(draftId: string, environmentId: string, shell: string) {
  useForkDraftTerminalStore.getState().setShell(draftId, environmentId, shell);
}

export function isDraftInTerminalMode(draftId: string): boolean {
  return draftId in useForkDraftTerminalStore.getState().shellByDraftId;
}
