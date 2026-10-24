import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectScript } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { runAppOverlayScript } from "./AppOverlay";
import { usePinnedScriptsTargetStore } from "./PinnedScripts";
import { stackedThreadToast, toastManager } from "./ui/toast";

const NO_SCRIPTS: readonly ProjectScript[] = [];

/** The desktop host owns the keys; the renderer uses the same runner as the title-bar pins. */
export function GlobalScriptShortcuts() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const target = usePinnedScriptsTargetStore((state) => state.target);
  const environmentId = target?.environmentId ?? primaryEnvironmentId;
  if (!window.desktopBridge?.configureGlobalScriptShortcuts || environmentId === null) return null;
  return <EnvironmentGlobalScriptShortcuts environmentId={environmentId} />;
}

function EnvironmentGlobalScriptShortcuts({ environmentId }: { environmentId: EnvironmentId }) {
  const scripts = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.globalScripts ?? NO_SCRIPTS,
  );
  const target = usePinnedScriptsTargetStore((state) => state.target);

  useEffect(() => {
    let current = true;
    void window.desktopBridge
      ?.configureGlobalScriptShortcuts?.(scripts)
      .then((failed) => {
        if (!current || failed.length === 0) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Global shortcut unavailable",
            description: `Could not register ${failed.join(", ")}. Choose a key not used by an app toggle, another script, or another app.`,
          }),
        );
      })
      .catch(() => {
        if (!current) return;
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Could not register global shortcuts" }),
        );
      });
    return () => {
      current = false;
    };
  }, [scripts]);

  useEffect(
    () => () => {
      void window.desktopBridge?.configureGlobalScriptShortcuts?.([]).catch(() => undefined);
    },
    [],
  );

  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (!action.startsWith("global-script:")) return;
        const script = scripts.find(
          (candidate) => candidate.id === action.slice("global-script:".length),
        );
        if (!script?.globalShortcut) return;
        if (target?.environmentId === environmentId && target.runScript) {
          target.runScript(script);
          return;
        }
        const overlay = runAppOverlayScript(environmentId, script, undefined);
        if (overlay !== null) {
          void overlay;
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Open a thread to run ${script.name}`,
            description:
              "Global shortcuts use the open thread's terminal, like pinned scripts. This connection must allow terminal commands.",
          }),
        );
      }),
    [environmentId, scripts, target],
  );
  return null;
}
