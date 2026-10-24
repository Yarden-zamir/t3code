import type { MouseEvent as ReactMouseEvent } from "react";
import { SquareTerminalIcon } from "lucide-react";

import { useTerminalThreadEnvironmentIds } from "../../hooks/useForkTerminalThreads";
import { ShortcutHint } from "../focusLevels/ShortcutHint";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

/**
 * Fork: the sidebar button next to "New thread" that starts a terminal thread the way that
 * "New thread" starts a chat thread. Shown while a connected server has `terminalThreads` on.
 */
export function ForkNewTerminalThreadButton(props: {
  readonly shortcutCommand: "chat.newTerminal" | "chat.newTerminalLocal";
  readonly showNewThreadInProjectHint: boolean;
  readonly disabled: boolean;
  readonly onClick: (event: ReactMouseEvent) => void;
}) {
  const environmentIds = useTerminalThreadEnvironmentIds();
  if (environmentIds.size === 0) return null;
  const label = (
    <>
      New terminal thread
      <ShortcutHint command={props.shortcutCommand} />
    </>
  );
  return (
    <SidebarHeaderIconButton
      label="New terminal thread"
      tooltip={
        props.showNewThreadInProjectHint ? (
          <span className="flex flex-col gap-0.5">
            <span>{label}</span>
            <span className="text-muted-foreground">
              New terminal thread in current project: Shift+click
              <ShortcutHint command="chat.newTerminalLocal" />
            </span>
          </span>
        ) : (
          label
        )
      }
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <SquareTerminalIcon aria-hidden className="size-4" />
    </SidebarHeaderIconButton>
  );
}
