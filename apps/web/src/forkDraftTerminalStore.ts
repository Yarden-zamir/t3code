import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

/** The shell of the server that the terminal manager picks when a draft names none. */
const DEFAULT_DRAFT_SHELL = null;

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
  /**
   * The drafts that become a terminal thread at once, like the enlarge button. Not persisted:
   * after a reload such a draft waits for its first command.
   */
  readonly opensAsThreadDraftIds: ReadonlySet<string>;
  readonly enterTerminalMode: (draftId: string, environmentId: string) => void;
  readonly setShell: (draftId: string, environmentId: string, shell: string) => void;
  readonly leaveTerminalMode: (draftId: string) => void;
  readonly requestOpensAsThread: (draftId: string) => void;
}

const useForkDraftTerminalStore = create<ForkDraftTerminalState>()(
  persist(
    (set) => ({
      shellByDraftId: {},
      lastShellByEnvironmentId: {},
      opensAsThreadDraftIds: new Set(),
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
          const opensAsThreadDraftIds = new Set(state.opensAsThreadDraftIds);
          opensAsThreadDraftIds.delete(draftId);
          return { shellByDraftId, opensAsThreadDraftIds };
        }),
      requestOpensAsThread: (draftId) =>
        set((state) => {
          if (!(draftId in state.shellByDraftId)) {
            throw new Error(`Draft ${draftId} is not in Terminal mode.`);
          }
          return { opensAsThreadDraftIds: new Set(state.opensAsThreadDraftIds).add(draftId) };
        }),
    }),
    {
      name: "t3code:fork:draft-terminals:v1",
      storage: createJSONStorage(() =>
        // Per tab: two tabs write their whole state, so a shared store would drop the other
        // tab's drafts. A reload of the tab keeps its drafts in Terminal mode.
        resolveStorage(typeof window !== "undefined" ? window.sessionStorage : undefined),
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

/** Makes a draft in Terminal mode a terminal thread at once (`ForkDraftTerminalComposer`). */
export function requestDraftOpensAsThread(draftId: string) {
  useForkDraftTerminalStore.getState().requestOpensAsThread(draftId);
}

export function useDraftOpensAsThread(draftId: string): boolean {
  return useForkDraftTerminalStore((state) => state.opensAsThreadDraftIds.has(draftId));
}

export function isDraftInTerminalMode(draftId: string): boolean {
  return draftId in useForkDraftTerminalStore.getState().shellByDraftId;
}
