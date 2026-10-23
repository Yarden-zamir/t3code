import { useEffect, type RefObject } from "react";

import { isEditableFocused } from "../lib/editableFocus";

const SURFACE_WAIT_MS = 2_000;
const SURFACE_POLL_MS = 50;
const OPEN_LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Fork: gives keyboard focus to the terminal inside `containerRef` once, as soon as its surface
 * exists (the surface loads after mount). It takes focus from the button that opened the terminal
 * (a sidebar button, or the trigger that a closing palette focuses again), but not from a text
 * field, a dialog or a menu that the user moved to in the meantime.
 */
export function useGrabTerminalFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const deadline = Date.now() + SURFACE_WAIT_MS;
    const timer = window.setInterval(() => {
      const input = containerRef.current?.querySelector("textarea");
      if (!input) {
        if (Date.now() >= deadline) window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      const active = document.activeElement;
      const userMovedOn =
        active !== input &&
        (isEditableFocused(active) || active?.closest(OPEN_LAYER_SELECTOR) != null);
      if (!userMovedOn) input.focus();
    }, SURFACE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [containerRef]);
}
