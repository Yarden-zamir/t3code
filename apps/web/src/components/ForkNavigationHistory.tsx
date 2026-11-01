import type { ClientSettings } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { isElectron } from "../env";
import {
  forgetNavigationHistory,
  navigationAvailability,
  saveNavigationHistory,
  trackNavigationTraverses,
  windowNavigation,
} from "../forkNavigationHistory";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { observeResize } from "../lib/observeResize";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { ShortcutHint, ShortcutTrigger } from "./focusLevels/ShortcutHint";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup } from "./ui/tooltip";

const selectButtons = (settings: ClientSettings) => settings.backForwardButtons;
const selectRemember = (settings: ClientSettings) => settings.rememberBackForwardHistory;

const goBack = () => window.history.back();
const goForward = () => window.history.forward();

function subscribeToCurrentEntry(onChange: () => void): () => void {
  const navigation = windowNavigation();
  if (navigation === undefined) return () => {};
  navigation.addEventListener("currententrychange", onChange);
  return () => navigation.removeEventListener("currententrychange", onChange);
}

const readCanGoBack = () => navigationAvailability(windowNavigation()).canGoBack;
const readCanGoForward = () => navigationAvailability(windowNavigation()).canGoForward;

/** Fork: `backForwardButtons`, back and forward buttons right of the sidebar toggle. */
export function NavigationHistoryButtons({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const enabled = useClientSettings(selectButtons);
  const canGoBack = useSyncExternalStore(subscribeToCurrentEntry, readCanGoBack);
  const canGoForward = useSyncExternalStore(subscribeToCurrentEntry, readCanGoForward);
  const measureRef = (element: HTMLDivElement) => {
    const stop = observeResize(element, () => onWidthChange(element.offsetWidth));
    return () => {
      stop();
      onWidthChange(0);
    };
  };
  if (!enabled) return null;
  return (
    <div
      ref={measureRef}
      className="pointer-events-auto ml-1 flex [-webkit-app-region:no-drag]"
      role="group"
      aria-label="Back and forward"
    >
      <Tooltip>
        <ShortcutTrigger
          command="navigation.back"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={goBack}
              disabled={!canGoBack}
              aria-label="Go back"
            />
          }
        >
          <ArrowLeftIcon />
        </ShortcutTrigger>
        <TooltipPopup side="bottom">
          Go back
          <ShortcutHint command="navigation.back" />
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <ShortcutTrigger
          command="navigation.forward"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={goForward}
              disabled={!canGoForward}
              aria-label="Go forward"
            />
          }
        >
          <ArrowRightIcon />
        </ShortcutTrigger>
        <TooltipPopup side="bottom">
          Go forward
          <ShortcutHint command="navigation.forward" />
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * Fork: `rememberBackForwardHistory`. Back and forward skip threads and drafts that no longer
 * exist. The desktop app also stores its history for the next start; a browser tab keeps its
 * own history over a reload or a browser restart.
 */
export function NavigationHistoryRecorder() {
  const remember = useClientSettings(selectRemember);
  const hydrated = useClientSettingsHydrated();
  useEffect(() => {
    const navigation = windowNavigation();
    if (navigation === undefined || !hydrated) return;
    if (!remember) {
      if (isElectron) forgetNavigationHistory(window.localStorage);
      return;
    }
    const stopTracking = trackNavigationTraverses(navigation);
    if (!isElectron) return stopTracking;
    const save = () => {
      const current = navigation.currentEntry;
      if (current === null) return;
      saveNavigationHistory(
        window.localStorage,
        navigation.entries().map((entry) => entry.url),
        current.index,
      );
    };
    save();
    navigation.addEventListener("currententrychange", save);
    return () => {
      stopTracking();
      navigation.removeEventListener("currententrychange", save);
    };
  }, [hydrated, remember]);
  return null;
}

/** Fork: "Go back" and "Go forward" in the command palette. They work with the buttons hidden. */
export function navigationHistoryPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  return [
    {
      kind: "action",
      value: "action:navigation-back",
      searchTerms: ["back", "go back", "previous view", "history"],
      title: "Go back",
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "navigation.back",
      run: async () => goBack(),
    },
    {
      kind: "action",
      value: "action:navigation-forward",
      searchTerms: ["forward", "go forward", "next view", "history"],
      title: "Go forward",
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "navigation.forward",
      run: async () => goForward(),
    },
  ];
}
