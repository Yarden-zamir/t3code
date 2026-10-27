import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { type EnvironmentId, isTerminalThread, type ScopedProjectRef } from "@t3tools/contracts";
import { SquareTerminalIcon } from "lucide-react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  useTerminalThreadEnvironmentIds,
  useTerminalThreadsEnabled,
} from "../hooks/useForkTerminalThreads";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  ADDON_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteProject,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  enumerateCommandPaletteItems,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import {
  buildNewThreadInProjectItems,
  type CommandPaletteProjectLocation,
} from "./CommandPaletteProjectItems";

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

/**
 * Fork: the command palette items that start a terminal thread (`forkTerminalThreads.ts`). The
 * project list shows only projects on a server with `terminalThreads` on, and has no "No project"
 * entry.
 */
/** The palette resolves this group's projects while it renders, like upstream's chat one. */
export const FORK_TERMINAL_NEW_THREAD_IN_GROUP = "terminal-projects";

/** "New terminal thread in": with no items, the view a palette intent opens to. */
export function forkTerminalNewThreadInView(
  items: CommandPaletteView["groups"][number]["items"] = [],
): CommandPaletteView {
  return {
    addonIcon: <SquareTerminalIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: FORK_TERMINAL_NEW_THREAD_IN_GROUP, label: "Projects", items }],
  };
}

export function useForkTerminalThreadPaletteItems(input: {
  readonly pickerProjects: ReadonlyArray<CommandPaletteProject>;
  readonly projectGroupByTargetKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, CommandPaletteProjectLocation>;
  readonly contextualProjectRef: ScopedProjectRef | null;
  readonly scratchWorkspaceRootFor: (environmentId: EnvironmentId | null) => string | null;
}) {
  const { contextualProjectRef, projectGroupByTargetKey } = input;
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    handleNewTerminalThread,
  } = useHandleNewThread();
  const terminalThreadEnvironmentIds = useTerminalThreadEnvironmentIds();
  const terminalThreadsEnabled = useTerminalThreadsEnabled(
    contextualProjectRef?.environmentId ?? null,
  );

  const projectItems = enumerateCommandPaletteItems(
    buildNewThreadInProjectItems({
      projects: input.pickerProjects.filter(
        (project) =>
          !isScratchProject(project, input.scratchWorkspaceRootFor(project.environmentId)) &&
          terminalThreadEnvironmentIds.has(project.environmentId),
      ),
      projectGroupByTargetKey,
      locationByEnvironmentId: input.locationByEnvironmentId,
      runProject: async (project) => {
        const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
        const contextualRefBelongsToGroup =
          contextualProjectRef !== null &&
          group?.memberProjectRefs.some(
            (projectRef) =>
              projectRef.environmentId === contextualProjectRef.environmentId &&
              projectRef.projectId === contextualProjectRef.projectId,
          );
        // The picker never reads `currentProjectTerminalOpensThread`: its terminal stays a draft
        // until the first command.
        await handleNewTerminalThread(
          contextualRefBelongsToGroup
            ? contextualProjectRef
            : scopeProjectRef(project.environmentId, project.id),
        );
      },
    }),
  );

  const newThreadInView = forkTerminalNewThreadInView(projectItems);

  const actionItems = (activeProjectTitle: string | null): PaletteItem[] => [
    ...(terminalThreadsEnabled && activeProjectTitle
      ? [
          {
            kind: "action" as const,
            value: "action:new-terminal-thread",
            searchTerms: ["new terminal thread", "terminal", "shell"],
            title: (
              <>
                New terminal thread in <span className="font-semibold">{activeProjectTitle}</span>
              </>
            ),
            icon: <SquareTerminalIcon className={ITEM_ICON_CLASS} />,
            shortcutCommand: "chat.newTerminalLocal" as const,
            run: async () => {
              await startNewThreadFromContext(
                {
                  activeDraftThread,
                  activeThread: activeThread ?? undefined,
                  defaultProjectRef,
                  handleNewThread,
                  handleNewTerminalThread,
                },
                "terminal",
              );
            },
          },
        ]
      : []),
    ...(projectItems.length > 0
      ? [
          {
            kind: "submenu" as const,
            value: "action:new-terminal-thread-in",
            searchTerms: ["new terminal thread", "terminal", "project", "pick", "choose", "select"],
            title: "New terminal thread in...",
            shortcutCommand: "chat.newTerminal" as const,
            icon: <SquareTerminalIcon className={ITEM_ICON_CLASS} />,
            addonIcon: newThreadInView.addonIcon,
            groups: newThreadInView.groups,
          },
        ]
      : []),
  ];

  return { actionItems, newThreadInView, projectItemCount: projectItems.length };
}

/** Upstream palette items that need a chat: messages to find, a composer, an agent session. */
const CHAT_ONLY_ITEM_VALUES: ReadonlySet<string> = new Set([
  "find-current-thread",
  "action:copy-prompt-link",
  "action:restart-agent-session",
]);

/** Fork: a terminal thread has no messages, composer or agent session (`forkTerminalThreads.ts`). */
export function forkHideChatOnlyItems<Item extends { readonly value: string }>(
  items: ReadonlyArray<Item>,
  activeThread: { readonly providerInstanceId: string } | null | undefined,
): ReadonlyArray<Item> {
  if (!activeThread || !isTerminalThread(activeThread)) return items;
  return items.filter((item) => !CHAT_ONLY_ITEM_VALUES.has(item.value));
}
