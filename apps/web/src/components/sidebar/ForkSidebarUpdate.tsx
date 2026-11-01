/**
 * Fork parts of the sidebar update button (`SidebarUpdatePill.tsx`): the fork changelog in the
 * update popover, the idle install prompt and the newer-update check before install.
 */
import type { ClientSettings, DesktopUpdateState } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "../../hooks/useSettings";
import { ForkUpdateChanges } from "../forkChangelog/ForkUpdateChanges";
import { Button } from "../ui/button";

export {
  openIdleInstallPromptIfWorkRuns,
  useIdleInstallArmed,
} from "../desktop/DesktopUpdateIdleInstall";
export { prepareNewestUpdateInstall } from "../desktop/DesktopUpdateNewerCheck";

const selectForkChangelogEnabled = (settings: ClientSettings) => settings.forkChangelogEnabled;

/** With the changelog on, the popover opens even when no update is available. */
export function useForkChangelog() {
  const enabled = useClientSettings(selectForkChangelogEnabled);
  return { enabled };
}
type ForkChangelog = ReturnType<typeof useForkChangelog>;

/** The popover body while the fork changelog is on: the release changes and "Open changelog". */
export function ForkUpdatePopoverChanges(props: {
  readonly changelog: ForkChangelog;
  readonly popover: { readonly close: () => void };
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
}) {
  const navigate = useNavigate();
  return (
    <>
      <ForkUpdateChanges state={props.state} tooltip={props.tooltip} />
      <div className="mt-2 px-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            props.popover.close();
            void navigate({ to: "/settings/machines", search: { tab: "changelog" } });
          }}
        >
          Open changelog
        </Button>
      </div>
    </>
  );
}
