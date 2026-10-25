import type { ThemeAppearance, ThemeColors } from "@t3tools/shared/themePalettes";

/**
 * Fork: the mobile theme id of a theme that a server publishes. The prefix keeps it apart from
 * the built-in ids in stored preferences.
 */
export type PublishedMobileThemeId = `published:${string}`;

const PREFIX = "published:";

export function publishedMobileThemeId(environmentThemeId: string): PublishedMobileThemeId {
  return `${PREFIX}${environmentThemeId}`;
}

export function isPublishedMobileThemeId(value: unknown): value is PublishedMobileThemeId {
  return typeof value === "string" && value.startsWith(PREFIX) && value.length > PREFIX.length;
}

type PublishedPalettes = ReadonlyMap<
  PublishedMobileThemeId,
  Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>
>;

const publishedPalettes = new Map<
  PublishedMobileThemeId,
  Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>
>();

/**
 * Fork: published theme palettes for the lookups by theme id in `mobileTheme.ts`. Like web
 * `setEnvironmentThemes`, one module store keeps those lookups pure. It only adds and replaces:
 * `availableMobileThemeIds` swaps an id that no server offers for the stock theme. Limit: a view
 * that memoizes on the id, such as the terminal, keeps old colors when a server republishes it.
 */
export function registerPublishedMobileThemePalettes(palettes: PublishedPalettes): void {
  for (const [id, colors] of palettes) publishedPalettes.set(id, colors);
}

export function publishedMobileThemePalette(
  themeId: PublishedMobileThemeId,
  appearance: ThemeAppearance,
): ThemeColors | null {
  return publishedPalettes.get(themeId)?.[appearance] ?? null;
}
