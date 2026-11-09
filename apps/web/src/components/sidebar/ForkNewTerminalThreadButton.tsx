import type { MouseEvent as ReactMouseEvent } from "react";
import { SquareTerminalIcon } from "lucide-react";

import { useTerminalThreadEnvironmentIds } from "../../hooks/useForkTerminalThreads";
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
  return (
    <SidebarHeaderIconButton
      label="New terminal thread"
      command={props.shortcutCommand}
      tooltip={{
        label: "New terminal thread",
        rows: props.showNewThreadInProjectHint
          ? [
              {
                command: "chat.newTerminalLocal",
                name: "New terminal thread in current project (Shift+click)",
              },
            ]
          : [],
        menu: [{ settings: "terminal-threads" }],
      }}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <SquareTerminalIcon aria-hidden className="size-4" />
    </SidebarHeaderIconButton>
  );
}
