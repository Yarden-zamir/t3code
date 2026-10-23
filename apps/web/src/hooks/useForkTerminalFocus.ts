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
 * field that the user moved to in the meantime. While a dialog or a menu has focus, it waits: the
 * project picker that opened the terminal is often still closing when the surface appears.
 */
export function useGrabTerminalFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const deadline = Date.now() + SURFACE_WAIT_MS;
    const timer = window.setInterval(() => {
      const input = containerRef.current?.querySelector("textarea");
      const active = document.activeElement;
      const inOpenLayer = active?.closest(OPEN_LAYER_SELECTOR) != null;
      if (!input || inOpenLayer) {
        if (Date.now() >= deadline) window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      if (active !== input && isEditableFocused(active)) return;
      input.focus();
    }, SURFACE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [containerRef]);
}
