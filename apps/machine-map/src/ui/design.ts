/**
 * Redesign comparison: `?design=current|wires|board|focus` picks how the Map view shows arrows.
 * Every design reads the same store and derive helpers; only the presentation differs. Remove the
 * designs that lose, and this switch with them, once the owner picks one.
 */
export const DESIGNS = ["current", "wires", "board", "focus"] as const;
export type Design = (typeof DESIGNS)[number];

export const DESIGN_LABEL: Record<Design, string> = {
  current: "Current",
  wires: "Wires",
  board: "Board",
  focus: "Focus",
};

export function pageDesign(): Design {
  const value = new URLSearchParams(location.search).get("design");
  return DESIGNS.find((design) => design === value) ?? "current";
}

/** The same page with another design. Other query values, such as `fixture`, stay. */
export function designHref(design: Design): string {
  const url = new URL(location.href);
  url.searchParams.set("design", design);
  return `${url.pathname}${url.search}${url.hash}`;
}
