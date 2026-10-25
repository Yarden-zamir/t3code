import type { ClientSettings } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { registerFocusLevelCommands } from "../focusLevels/useFocusLevelShortcuts";
import { Input } from "../ui/input";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  applySettingsFind,
  clearSettingsFind,
  isSettingsFindPage,
  matchedSettingsElements,
  settingsFindMatch,
} from "./settingsFind";

const selectSettingsFind = (settings: ClientSettings) => settings.settingsFind;

/** The scroll container of the open Settings page (`SettingsPageContainer`). */
function settingsPageRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-settings-page-scroll]");
}

/**
 * Fork: the find box of the Settings header. `settings.find` opens it while `settingsFind` is
 * on; the rows of the open page that do not match hide. The layout mounts one per page, so
 * another page closes it. On a list page, such as Archive, the key stays with the settings
 * search.
 */
export function ForkSettingsFind() {
  const enabled = useClientSettings(selectSettingsFind);
  const pathname = useLocation({ select: (location) => location.pathname });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = enabled && open;

  useEffect(() => {
    if (!enabled || !isSettingsFindPage(pathname)) return;
    return registerFocusLevelCommands({
      "settings.find": () => {
        const input = inputRef.current;
        if (input === null) {
          setOpen(true);
        } else {
          input.focus();
          input.select();
        }
        return true;
      },
    });
  }, [enabled, pathname]);

  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!shown || trimmedQuery === "") return;
    const match = settingsFindMatch(trimmedQuery, pathname);
    // The page re-renders rows as data arrives, and a scope change replaces the page element.
    // Apply again after each change of the page tree, at most once per frame. Limit: it watches
    // the whole document; revisit if the box slows other updates.
    let frame: number | null = null;
    const apply = () => {
      frame = null;
      const root = settingsPageRoot();
      if (root !== null) applySettingsFind(root, match);
    };
    apply();
    const observer = new MutationObserver(() => {
      if (frame === null) frame = requestAnimationFrame(apply);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      const root = settingsPageRoot();
      if (root !== null) clearSettingsFind(root);
    };
  }, [shown, trimmedQuery, pathname]);

  if (!shown) return null;
  // Limit: counts the search items of the page, also rows that the selected scope hides.
  const empty = trimmedQuery !== "" && settingsFindMatch(trimmedQuery, pathname).matched.size === 0;
  const jumpToFirstMatch = () => {
    const root = settingsPageRoot();
    if (root === null || trimmedQuery === "") return;
    const [first] = matchedSettingsElements(root, settingsFindMatch(trimmedQuery, pathname));
    if (first === undefined) return;
    scrollToSettingsTarget(first.id);
    // The jump focuses the row for its highlight; typing goes on in the box.
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    // Grows into the free space, so a header button after it stays at the end.
    <div className="flex flex-1 items-center justify-end gap-2">
      {empty ? (
        <span className="text-xs text-muted-foreground">No settings on this page match</span>
      ) : null}
      <div className="w-56">
        <Input
          ref={inputRef}
          size="sm"
          autoFocus
          value={query}
          placeholder="Find on this page"
          aria-label="Find on this settings page"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            // Stopped here, so the Settings modal's document listener does not close on it.
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setQuery("");
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            jumpToFirstMatch();
          }}
        />
      </div>
    </div>
  );
}
