import type { EnvironmentTheme } from "@t3tools/contracts";
import type { ThemeStyle } from "@t3tools/shared/themePalettes";
import * as Equal from "effect/Equal";

/** Id of the style element that holds the active theme's user CSS. */
export const THEME_USER_CSS_ELEMENT_ID = "t3-theme-user-css";
let userCssElement: HTMLStyleElement | null = null;

type ThemeFonts = NonNullable<ThemeStyle["fonts"]>;
const NO_THEME_FONTS: ThemeFonts = {};
let activeThemeFonts: ThemeFonts = NO_THEME_FONTS;
const activeThemeFontListeners = new Set<() => void>();

/** Fonts the active theme suggests. Empty when the theme has none. */
export function getActiveThemeFonts(): ThemeFonts {
  return activeThemeFonts;
}

export function subscribeToActiveThemeFonts(listener: () => void): () => void {
  activeThemeFontListeners.add(listener);
  return () => activeThemeFontListeners.delete(listener);
}

// The icon pack of the active theme, read by `AppIcon`.
type ThemeIcons = NonNullable<ThemeStyle["icons"]>;
const NO_THEME_ICONS: ThemeIcons = {};
let activeThemeIcons: ThemeIcons = NO_THEME_ICONS;
const activeThemeIconListeners = new Set<() => void>();

/** Icons of the active theme, by slot. Empty when the theme has none. */
export function getActiveThemeIcons(): ThemeIcons {
  return activeThemeIcons;
}

export function subscribeToActiveThemeIcons(listener: () => void): () => void {
  activeThemeIconListeners.add(listener);
  return () => activeThemeIconListeners.delete(listener);
}

/** The style fields a published theme sets, or undefined when it sets none. */
export function publishedThemeStyle(theme: EnvironmentTheme): ThemeStyle | undefined {
  const style: ThemeStyle = {
    ...(theme.radius !== undefined ? { radius: theme.radius } : {}),
    ...(theme.borderWidth !== undefined ? { borderWidth: theme.borderWidth } : {}),
    ...(theme.shadow !== undefined ? { shadow: theme.shadow } : {}),
    ...(theme.fonts !== undefined ? { fonts: theme.fonts } : {}),
    ...(theme.canvasPattern !== undefined ? { canvasPattern: theme.canvasPattern } : {}),
    ...(theme.canvasPatternColor !== undefined
      ? { canvasPatternColor: theme.canvasPatternColor }
      : {}),
    ...(theme.css !== undefined ? { css: theme.css } : {}),
    ...(theme.icons !== undefined ? { icons: theme.icons } : {}),
  };
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * Root custom properties and attributes for each style field. The attribute
 * gates the matching rules in fork-theme.css, so a theme without the field gets
 * none of them and renders as stock.
 */
const THEME_STYLE_PROPERTIES = [
  ["radius", "--radius", "themeRadius"],
  ["borderWidth", "--theme-border-width", "themeBorderWidth"],
  ["shadow", "--theme-shadow", "themeShadow"],
  ["canvasPatternColor", "--theme-canvas-pattern-color", null],
] as const satisfies ReadonlyArray<
  readonly [keyof ThemeStyle, `--${string}`, keyof DOMStringMap | null]
>;

/**
 * Writes the theme's optional style fields onto the root, and clears every
 * field the theme does not set. Undefined clears all of them.
 */
export function applyThemeStyle(root: HTMLElement, style: ThemeStyle | undefined): void {
  for (const [field, variable, attribute] of THEME_STYLE_PROPERTIES) {
    const value = style?.[field];
    if (value === undefined) {
      root.style.removeProperty(variable);
      if (attribute !== null) delete root.dataset[attribute];
    } else {
      root.style.setProperty(variable, value);
      if (attribute !== null) root.dataset[attribute] = "";
    }
  }

  const pattern = style?.canvasPattern;
  if (pattern === undefined || pattern === "none") delete root.dataset.canvasPattern;
  else root.dataset.canvasPattern = pattern;

  const fonts = style?.fonts ?? NO_THEME_FONTS;
  if (!Equal.equals(fonts, activeThemeFonts)) {
    activeThemeFonts = fonts;
    for (const listener of activeThemeFontListeners) listener();
  }

  const icons = style?.icons ?? NO_THEME_ICONS;
  if (!Equal.equals(icons, activeThemeIcons)) {
    activeThemeIcons = icons;
    for (const listener of activeThemeIconListeners) listener();
  }

  // The style element goes last in <head>, so user CSS wins over the app
  // stylesheet at equal specificity. It is removed when the theme has none.
  const css = style?.css;
  if (css === undefined) {
    userCssElement?.remove();
    userCssElement = null;
    return;
  }
  userCssElement ??= document.createElement("style");
  userCssElement.id = THEME_USER_CSS_ELEMENT_ID;
  if (userCssElement.textContent !== css) userCssElement.textContent = css;
  if (userCssElement !== document.head.lastElementChild) document.head.append(userCssElement);
}
