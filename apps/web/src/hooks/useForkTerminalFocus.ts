import { useEffect, type RefObject } from "react";

import { isEditableFocused } from "../lib/editableFocus";

const GRAB_MS = 2_000;
const GRAB_INTERVAL_MS = 50;

/**
 * Fork: gives keyboard focus to the terminal inside `containerRef` once its surface exists, unless
 * the user already focuses another place to type. A command palette that just closed gives focus
 * back to its trigger, so the grab repeats for a short time.
 */
export function useGrabTerminalFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const deadline = Date.now() + GRAB_MS;
    const grab = () => {
      const input = containerRef.current?.querySelector("textarea");
      const active = document.activeElement;
      if (input && active !== input && !isEditableFocused(active)) input.focus();
      if (Date.now() >= deadline) window.clearInterval(timer);
    };
    const timer = window.setInterval(grab, GRAB_INTERVAL_MS);
    grab();
    return () => window.clearInterval(timer);
  }, [containerRef]);
}
