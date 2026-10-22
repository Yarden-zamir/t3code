import { SquareTerminalIcon } from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useTerminalThreadEnvironmentIds } from "../../hooks/useForkTerminalThreads";
import { ShortcutHint } from "../focusLevels/ShortcutHint";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

/**
 * Fork: the sidebar button next to "New thread" that opens the project picker for a terminal
 * thread. Shown while a connected server has `terminalThreads` on.
 */
export function ForkNewTerminalThreadButton() {
  const environmentIds = useTerminalThreadEnvironmentIds();
  if (environmentIds.size === 0) return null;
  return (
    <SidebarHeaderIconButton
      label="New terminal thread"
      tooltip={
        <>
          New terminal thread
          <ShortcutHint command="chat.newTerminal" />
        </>
      }
      onClick={() => openCommandPalette({ open: "new-terminal-thread-in" })}
    >
      <SquareTerminalIcon aria-hidden className="size-4" />
    </SidebarHeaderIconButton>
  );
}
