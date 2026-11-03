import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, TERMINAL_UPDATE_HOLD_MAX_HOURS, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";
import {
  countRunningAgentTurns,
  countRunningTerminalPrograms,
  type IdleInstallArm,
  idleInstallWorkTitle,
  nextAutomaticArm,
} from "../desktopUpdateIdleInstall.logic";
import { installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface IdleInstallState {
  readonly promptOpen: boolean;
  /**
   * The wait to install as soon as no agent or terminal program runs, or null. The terminal hold
   * counts from its `at` (epoch ms). Client only: a window reload drops it.
   */
  readonly arm: IdleInstallArm | null;
}

const idleInstallAtom = Atom.make<IdleInstallState>({ promptOpen: false, arm: null }).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:update-idle-install"),
);

// An update restarts the server of the primary environment, so only its agents count.
const runningAgentCountAtom = Atom.make((get) =>
  countRunningAgentTurns(
    get(environmentThreadShells.threadShellsAtom),
    get(primaryEnvironmentIdAtom),
  ),
).pipe(Atom.withLabel("desktop:update-running-agent-count"));

const runningTerminalProgramCountAtom = Atom.make((get) =>
  countRunningTerminalPrograms(
    get(environmentThreadShells.threadShellsAtom),
    get(primaryEnvironmentIdAtom),
  ),
).pipe(Atom.withLabel("desktop:update-running-terminal-program-count"));

// The server holds the install for terminal thread programs, with the rules of a headless server
// update: at most TERMINAL_UPDATE_HOLD_MAX_HOURS, then a notice in each held terminal.
const terminalHold = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "desktop:update-terminal-hold",
  tag: WS_METHODS.forkUpdatesTerminalHold,
  idleTtlMs: 0,
});

function setIdleInstallState(next: Partial<IdleInstallState>): void {
  appAtomRegistry.update(idleInstallAtom, (current) => ({ ...current, ...next }));
}

export function useIdleInstallArmed(): boolean {
  return useAtomValue(idleInstallAtom).arm !== null;
}

/**
 * Call before an update install starts. While agents or terminal programs run, it opens the
 * "Install when idle" prompt and returns true; the caller then stops.
 */
export function openIdleInstallPromptIfWorkRuns(): boolean {
  if (
    appAtomRegistry.get(runningAgentCountAtom) === 0 &&
    appAtomRegistry.get(runningTerminalProgramCountAtom) === 0
  ) {
    return false;
  }
  setIdleInstallState({ promptOpen: true });
  return true;
}

/** Desktop only. Hosts the prompt and runs an armed install when the work finishes. */
export function DesktopUpdateIdleInstall() {
  const { promptOpen, arm } = useAtomValue(idleInstallAtom);
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const armed = arm !== null;
  return (
    <>
      {environmentId === null ? null : <AutomaticInstall environmentId={environmentId} />}
      {arm === null ? null : <ArmedInstallWatcher armedAt={arm.at} />}
      <AlertDialog
        open={promptOpen}
        onOpenChange={(open) => {
          if (!open) setIdleInstallState({ promptOpen: false });
        }}
      >
        <AlertDialogPopup>
          <IdleInstallPromptContent armed={armed} />
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * Fork update policy: with `forkUpdateMode` "automatic" on this app's server, a downloaded update
 * waits for idle as after "Install when idle". "Stop waiting" holds it until the next download.
 * A switch to "manual" cancels that wait.
 */
function AutomaticInstall({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const automatic = useEnvironmentSettings(
    environmentId,
    (settings) => settings.forkUpdateMode === "automatic",
  );
  const state = useDesktopUpdateState();
  const downloaded = state ? resolveDesktopUpdateButtonAction(state) === "install" : false;
  const version = downloaded ? (state?.downloadedVersion ?? null) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the desktop updater outside React finishes a download.
  useEffect(() => {
    const current = appAtomRegistry.get(idleInstallAtom).arm;
    const next = nextAutomaticArm(current, automatic, version !== null, Date.now());
    if (next !== current) setIdleInstallState({ arm: next });
  }, [automatic, version]);
  return null;
}

function ArmedInstallWatcher({ armedAt }: { readonly armedAt: number }) {
  const count = useAtomValue(runningAgentCountAtom);
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const state = useDesktopUpdateState();
  // Asked only while no agent runs, so the notice comes just before the install. The hold counts
  // from `armedAt` across agent turns. A failed subscription keeps waiting: "Install now" remains.
  const hold = useEnvironmentQuery(
    count > 0 || environmentId === null
      ? null
      : terminalHold({ environmentId, input: { heldSince: armedAt } }),
  );
  const ready = hold.data?.ready === true;

  useEffect(() => {
    // The registry check keeps a repeated effect run from installing twice.
    if (count > 0 || !ready || appAtomRegistry.get(idleInstallAtom).arm === null) return;
    setIdleInstallState({ promptOpen: false, arm: null });
    const bridge = window.desktopBridge;
    if (!bridge || !state || resolveDesktopUpdateButtonAction(state) !== "install") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Update not installed",
          description: "The work finished, but the update is no longer ready to install.",
        }),
      );
      return;
    }
    void installLocalUpdate(bridge);
  }, [count, ready, state]);

  return null;
}

function IdleInstallPromptContent({ armed }: { readonly armed: boolean }) {
  const agents = useAtomValue(runningAgentCountAtom);
  const terminalPrograms = useAtomValue(runningTerminalProgramCountAtom);

  const installNow = () => {
    setIdleInstallState({ promptOpen: false, arm: null });
    const bridge = window.desktopBridge;
    if (bridge) void installLocalUpdate(bridge);
  };

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{idleInstallWorkTitle(agents, terminalPrograms)}</AlertDialogTitle>
        <AlertDialogDescription>
          {armed
            ? "The update installs when they finish."
            : "Installing the update restarts the server and interrupts them."}
          {terminalPrograms > 0
            ? ` A terminal program holds the update at most ${TERMINAL_UPDATE_HOLD_MAX_HOURS} hours, then its terminal gets a notice and the program ends.`
            : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>
          {armed ? "Keep waiting" : "Cancel"}
        </AlertDialogClose>
        {armed ? (
          <Button
            variant="outline"
            onClick={() => setIdleInstallState({ promptOpen: false, arm: null })}
          >
            Stop waiting
          </Button>
        ) : null}
        <Button variant="destructive-outline" onClick={installNow}>
          Install now
        </Button>
        {armed ? null : (
          <Button
            onClick={() =>
              setIdleInstallState({ promptOpen: false, arm: { at: Date.now(), by: "user" } })
            }
          >
            Install when idle
          </Button>
        )}
      </AlertDialogFooter>
    </>
  );
}
