/**
 * Theming: Flowline's look is driven by `--fl-*` CSS custom properties defined in `styles.css`
 * (light and dark sets). A {@link FlowlineTheme} picks the color mode and overrides tokens.
 *
 * @module
 */

import type { CSSProperties } from "react";

/** Names of the themeable design tokens. Each maps to a `--fl-<kebab-name>` CSS variable. */
export type ThemeToken =
  | "accent"
  | "accentFg"
  | "bg"
  | "canvasBg"
  | "surface"
  | "surfaceHover"
  | "border"
  | "text"
  | "textMuted"
  | "danger"
  | "warning"
  | "success"
  | "radius"
  | "font"
  | "fontMono";

/** Color mode and token overrides for Flowline components. */
export interface FlowlineTheme {
  /** `"system"` follows `prefers-color-scheme`. Default `"system"`. */
  colorMode?: "light" | "dark" | "system";
  /**
   * CSS values overriding the built-in tokens in both color modes, e.g.
   * `{ accent: "#0f766e", radius: "6px", font: "'Geist', sans-serif" }`.
   */
  tokens?: Partial<Record<ThemeToken, string>>;
}

/** The CSS variable a token is stored in, e.g. `"textMuted"` → `"--fl-text-muted"`. */
export function tokenVar(token: ThemeToken): string {
  return `--fl-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Inline style setting the CSS variables of `tokens` (empty values are skipped). */
export function themeStyle(tokens: FlowlineTheme["tokens"]): CSSProperties {
  const style: Record<string, string> = {};
  for (const [token, value] of Object.entries(tokens ?? {})) {
    if (value) style[tokenVar(token as ThemeToken)] = value;
  }
  return style as CSSProperties;
}
