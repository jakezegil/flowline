import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANNOTATION_COLORS } from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { themeStyle, tokenVar } from "./theme";

const css = readFileSync(resolve(__dirname, "styles.css"), "utf8");

/** The body of the first rule whose selector is exactly `selector` (after `from`). */
function block(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  if (at === -1) throw new Error(`no ${selector} block`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** The `--fl-*` declarations of a block. */
function vars(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--fl-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
}

const light = vars(block(".fl-root"));
const dark = vars(block('.fl-root[data-fl-theme="dark"]'));
const system = vars(block('.fl-root[data-fl-theme="system"]', css.indexOf("prefers-color-scheme")));

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const annotationVars = (set: Map<string, string>) =>
  [...set].filter(([k]) => k.startsWith("--fl-annot-"));

describe("annotation tokens", () => {
  test("18 tokens in the light block, and the same names in both dark blocks", () => {
    expect(annotationVars(light)).toHaveLength(18);
    expect(annotationVars(dark).map(([k]) => k)).toEqual(annotationVars(light).map(([k]) => k));
  });

  test("the two dark blocks declare identical annotation values", () => {
    expect(annotationVars(system)).toEqual(annotationVars(dark));
  });

  for (const [mode, set] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const c of ANNOTATION_COLORS) {
      test(`${mode} ${c}: -text and --fl-text on -bg meet WCAG AA (4.5)`, () => {
        const bg = set.get(`--fl-annot-${c}-bg`) as string;
        expect(contrast(set.get(`--fl-annot-${c}-text`) as string, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(set.get("--fl-text") as string, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("--fl-changed is derived from the accent, declared once", () => {
    expect(css.match(/--fl-changed\s*:/g)).toHaveLength(1);
    expect(css).toMatch(
      /--fl-changed:\s*color-mix\(in srgb, var\(--fl-accent\) 45%, transparent\)/,
    );
  });

  test("the flash animation is turned off under reduced motion", () => {
    expect(css).toMatch(/@keyframes fl-flash/);
    const at = css.indexOf("prefers-reduced-motion: reduce");
    expect(at).toBeGreaterThan(-1);
    const rules = [
      ...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {2}\}/g),
    ]
      .map((m) => m[1] as string)
      .join("\n");
    expect(rules).toMatch(/\[data-flash\][^{]*\{\s*animation:\s*none/);
  });
});

describe("tokenVar / themeStyle", () => {
  test("annotation tokens map to --fl-annot-* variables", () => {
    expect(tokenVar("annotPurpleBorder")).toBe("--fl-annot-purple-border");
    expect(tokenVar("annotYellowBg")).toBe("--fl-annot-yellow-bg");
    expect(themeStyle({ annotYellowBg: "#fff" })).toEqual({ "--fl-annot-yellow-bg": "#fff" });
  });
});
