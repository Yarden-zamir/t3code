import { useEffect, type RefObject } from "react";

const GRAB_MS = 2_000;
const GRAB_INTERVAL_MS = 50;

/**
 * Fork: gives keyboard focus to the terminal inside `containerRef` once its surface exists. It
 * takes focus only while nothing else holds it, or while focus is already inside the container,
 * so an open menu, a dialog or the sidebar keeps it. The surface can appear late, so the grab
 * repeats for a short time.
 */
export function useGrabTerminalFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const deadline = Date.now() + GRAB_MS;
    const grab = () => {
      const container = containerRef.current;
      const input = container?.querySelector("textarea");
      const active = document.activeElement;
      const free =
        active === null || active === document.body || container?.contains(active) === true;
      if (input && active !== input && free) input.focus();
      if (Date.now() >= deadline) window.clearInterval(timer);
    };
    const timer = window.setInterval(grab, GRAB_INTERVAL_MS);
    grab();
    return () => window.clearInterval(timer);
  }, [containerRef]);
}
