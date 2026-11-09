import { XIcon } from "lucide-react";

import { AppIcon } from "../AppIcon";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ShortcutHint,
  ShortcutTrigger,
  TooltipBody,
  type TooltipContent,
} from "../focusLevels/ShortcutHint";
import type { KeybindingCommand } from "@t3tools/contracts";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  /** Fork: the Filter menu, which also sets the project scope. */
  projectScope: ReactNode;
  /** Fork: the new terminal thread button, rendered before the new thread button. */
  terminalThreadButton?: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadCommand: KeybindingCommand;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  terminalThreadButton,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadCommand,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;

  return (
    <div className="flex items-center gap-1">
      {/* Fork: the search key works while the sidebar has focus, so the hint reads that context. */}
      <Tooltip>
        <ShortcutTrigger
          command="sidebar.search"
          context={{ sidebarFocus: true }}
          render={
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70" />
          }
        >
          <AppIcon slot="sidebar.search" className="text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search"
            aria-label="Search threads"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className="min-w-0 flex-1"
          />
          {isSearching ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    className="shrink-0"
                    aria-label="Clear thread search"
                    onClick={() => {
                      onClearSearch();
                      searchInputRef.current?.focus();
                    }}
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup>Clear search</TooltipPopup>
            </Tooltip>
          ) : null}
        </ShortcutTrigger>
        <TooltipPopup side="bottom">
          Search threads
          <ShortcutHint command="sidebar.search" context={{ sidebarFocus: true }} />
        </TooltipPopup>
      </Tooltip>
      <div className="flex shrink-0 items-center">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
              <AppIcon slot="sidebar.add-project" />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        {terminalThreadButton}
        <SidebarHeaderIconButton
          label="New thread"
          command={newThreadCommand}
          tooltip={{
            label: "New thread",
            rows: showNewThreadInProjectHint
              ? [{ command: "chat.newLocal", name: "New thread in current project (Shift+click)" }]
              : [],
          }}
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <AppIcon slot="sidebar.new-thread" />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = { label },
  command = null,
  shortcutContext,
  className,
  children,
  ...rest
}: {
  label: string;
  /** Fork: typed, so a second action in the tooltip is a row that runs it, never text. */
  tooltip?: TooltipContent;
  /** The keybinding command that the button runs; its key shows after the tooltip label. */
  command?: KeybindingCommand | null;
  /** Fork: the context that the key of `command` needs, such as `sidebarFocus`. */
  shortcutContext?: ComponentProps<typeof ShortcutTrigger>["context"];
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <ShortcutTrigger
        command={command}
        {...(shortcutContext === undefined ? {} : { context: shortcutContext })}
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </ShortcutTrigger>
      <TooltipPopup side="top">
        <TooltipBody content={tooltip} command={command} context={shortcutContext} />
      </TooltipPopup>
    </Tooltip>
  );
}
