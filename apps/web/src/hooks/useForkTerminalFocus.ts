import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { isEditableFocused } from "../lib/editableFocus";
import { useStableCallback } from "./useStableCallback";

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

const TERMINAL_INPUT_SELECTOR = "[data-terminal-owner] textarea";

/**
 * Focus on the page, or on a header button that opened a layer, types nothing. There the terminal
 * that had focus last gets it back (the main terminal at first). A terminal that went away (a
 * closed drawer terminal) gets nothing, because its owner moves the focus.
 */
function returnFocusToTerminal(
  header: HTMLElement | null,
  lastTerminal: HTMLElement | null,
  focusMainTerminal: () => void,
) {
  const active = document.activeElement;
  const onPage = active === null || active === document.body;
  const onHeaderButton =
    active !== null &&
    header?.contains(active) === true &&
    active.closest(OPEN_LAYER_SELECTOR) === null &&
    !isEditableFocused(active);
  if (!onPage && !onHeaderButton) return;
  if (lastTerminal === null) focusMainTerminal();
  else if (lastTerminal.isConnected) lastTerminal.focus();
}

/**
 * Fork: gives focus back to the terminal of a terminal thread when the element that had focus goes
 * away: a dialog or a menu closes, the command palette closes, or a control unmounts (Rename,
 * Wake now, a toast button). Focus that the user moved stays: a text field, the sidebar, the right
 * panel, a preview. A menu that never takes focus (the thread menu, native on desktop) calls the
 * returned function when it closes. Limit: Firefox and Safari report no focus loss for a removed
 * element; there the next printable key still goes to the shell (`typeIntoComposer` of the screen).
 */
export function useReturnFocusToTerminal(input: {
  readonly headerRef: RefObject<HTMLElement | null>;
  readonly focusMainTerminal: () => void;
}): () => void {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const lastTerminal = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches(TERMINAL_INPUT_SELECTOR)) {
        lastTerminal.current = event.target;
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      const lost = event.target;
      if (!(lost instanceof Element) || lost.matches(TERMINAL_INPUT_SELECTOR)) return;
      const fromLayer = lost.closest(OPEN_LAYER_SELECTOR) !== null;
      window.clearTimeout(timer);
      // A closing layer gives focus back to its trigger, and a control unmounts, after this event.
      timer = window.setTimeout(() => {
        if (!fromLayer && lost.isConnected) return;
        returnFocusToTerminal(
          latest.current.headerRef.current,
          lastTerminal.current,
          latest.current.focusMainTerminal,
        );
      }, 0);
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);
  return useStableCallback(() =>
    returnFocusToTerminal(
      latest.current.headerRef.current,
      lastTerminal.current,
      latest.current.focusMainTerminal,
    ),
  );
}
