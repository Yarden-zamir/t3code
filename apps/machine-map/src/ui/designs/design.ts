/**
 * The map redesigns, switchable with `?design=<name>` in one build. `current` is the map as it
 * is. The other three share the store, the rules and the derive helpers, and differ in idea:
 * - `ribbon`: the map keeps its cards; every arrow is its own one-way line with a chip on it.
 * - `board`: a from-by-to board of access chips with an inline editor, instead of the graph.
 * - `hub`: one machine at a time, with what it can use on the left and who can use it on the right.
 */
export const DESIGNS = ["current", "ribbon", "board", "hub"] as const;
export type Design = (typeof DESIGNS)[number];

export const DESIGN_LABEL: Record<Design, string> = {
  current: "Current map",
  ribbon: "Ribbon map",
  board: "Access board",
  hub: "Machine hub",
};

const isDesign = (value: string | null): value is Design =>
  DESIGNS.some((design) => design === value);

/** The design of the page. An unknown or missing value is the current map. */
export function readDesign(search: string): Design {
  const value = new URLSearchParams(search).get("design");
  return isDesign(value) ? value : "current";
}

/** True when the page was opened with `?design=`, so the switcher shows. */
export const hasDesignParam = (search: string): boolean =>
  new URLSearchParams(search).has("design");

/** The same page, same hash route, with another design. */
export function designHref(design: Design): string {
  const url = new URL(location.href);
  url.searchParams.set("design", design);
  return `${url.pathname}${url.search}${url.hash}`;
}
