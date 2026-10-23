import type { ClientSettings } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { registerFocusLevelCommands } from "../focusLevels/useFocusLevelShortcuts";
import { Input } from "../ui/input";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  applySettingsFind,
  clearSettingsFind,
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
 * on; the rows of the open page that do not match hide. Escape or another page closes it.
 */
export function ForkSettingsFind() {
  const enabled = useClientSettings(selectSettingsFind);
  const pathname = useLocation({ select: (location) => location.pathname });
  const [openOn, setOpenOn] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const latestPathname = useRef(pathname);
  useLayoutEffect(() => {
    latestPathname.current = pathname;
  });
  const open = enabled && openOn === pathname;

  useEffect(() => {
    if (!enabled) return;
    return registerFocusLevelCommands({
      "settings.find": () => {
        const input = inputRef.current;
        if (input !== null) {
          input.focus();
          input.select();
        } else {
          setQuery("");
          setOpenOn(latestPathname.current);
        }
        return true;
      },
    });
  }, [enabled]);

  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!open || trimmedQuery === "") return;
    const match = settingsFindMatch(trimmedQuery, pathname);
    // The page re-renders rows as data arrives, and a scope change replaces the page element.
    // Apply again after each change of the page tree, at most once per frame.
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
  }, [open, trimmedQuery, pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpenOn(null);
      setQuery("");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;
  const empty = trimmedQuery !== "" && settingsFindMatch(trimmedQuery, pathname).matched.size === 0;
  const jumpToFirstMatch = () => {
    const root = settingsPageRoot();
    if (root === null || trimmedQuery === "") return;
    const [first] = matchedSettingsElements(root, settingsFindMatch(trimmedQuery, pathname));
    if (first !== undefined) scrollToSettingsTarget(first.id);
  };

  return (
    <div className="ms-auto flex shrink-0 items-center gap-2">
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
            if (event.key === "Enter") {
              event.preventDefault();
              jumpToFirstMatch();
            }
          }}
        />
      </div>
    </div>
  );
}
