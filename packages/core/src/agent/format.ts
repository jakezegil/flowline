/**
 * The outline line format shared by `overview`, `outline` and the `apply` report: step lines,
 * string cuts, follow-up calls and result sizes.
 *
 * @module
 */
import { isAnnotationColor } from "../annotations";
import type { AnnotationColor, NodeManifest, Step } from "../types";
import type { FollowUp, OutlineResult } from "./read-types";

/** Longest a step name or section title is shown in an outline line. */
const LABEL_MAX = 120;

/** `180`, `1.2k`, `19.5k`. */
function shortCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * `s` cut to its first `max` characters followed by `…(+N chars)`, when it is longer than `max`
 * (`N` is the number of characters cut, shortened as `1.2k` from 1000 on). A surrogate pair is
 * never split.
 *
 * @example
 * cutString("a".repeat(300), 120).text // 120 × "a" + "…(+180 chars)"
 */
export function cutString(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  let end = Math.max(0, max);
  const code = s.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return { text: `${s.slice(0, end)}…(+${shortCount(s.length - end)} chars)`, cut: true };
}

/** Whitespace runs (including newlines) as one space, so a value stays on its line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A colour for display: one of the six, anything else as `gray`. */
export function shownColor(c: unknown): AnnotationColor {
  return isAnnotationColor(c) ? c : "gray";
}

/** `: note "<note cut to noteMax>"`, and whether it was cut. Empty when there is no note. */
export function noteSuffix(note: unknown, noteMax: number): { text: string; cut: boolean } {
  if (typeof note !== "string" || note === "") return { text: "", cut: false };
  const c = cutString(note, noteMax);
  return { text: `: note ${JSON.stringify(c.text)}`, cut: c.cut };
}

/** A name or title for display: on one line, cut to 120 chars. */
export function shownLabel(s: string): string {
  return cutString(oneLine(s), LABEL_MAX).text;
}

/**
 * @internal One outline line with the ID padded to `idWidth` (at least the ID plus two spaces),
 * and whether its note was cut.
 */
export function stepLineParts(
  step: Step,
  node: NodeManifest | undefined,
  issues: number,
  noteMax: number,
  idWidth: number,
): { text: string; noteCut: boolean } {
  let text = step.id.padEnd(Math.max(idWidth, step.id.length + 2)) + (node?.name ?? step.type);
  if (typeof step.name === "string" && step.name !== "") text += ` “${shownLabel(step.name)}”`;
  if (step.color !== undefined) text += ` [${shownColor(step.color)}]`;
  if (issues > 0) text += ` · ${issues} ${issues === 1 ? "issue" : "issues"}`;
  const note = noteSuffix(step.note, noteMax);
  return { text: text + note.text, noteCut: note.cut };
}

/**
 * One outline line, without indentation: the ID and two spaces, the node label (the node type
 * when `node` is unknown), then ` “<name>”`, ` [<color>]` (an unknown colour shows as `gray`),
 * ` · N issue(s)` and `: note "<note>"`, each only when present. The note is cut to `noteMax`.
 *
 * @example
 * stepLine(step, node, 1, 120) // getDeal  Get deal “Load it” [pink] · 1 issue: note "Check it"
 */
export function stepLine(
  step: Step,
  node: NodeManifest | undefined,
  issues: number,
  noteMax: number,
): string {
  return stepLineParts(step, node, issues, noteMax, 0).text;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A JSON value as a compact JS literal: identifier keys unquoted, strings JSON-quoted. */
function literal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(literal).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}:${literal(x)}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * A follow-up as a compact call, as shown in collapse markers.
 *
 * @example
 * formatCall({ tool: "outline", args: { stepId: "recheck", branch: "else" } })
 * // outline({stepId:"recheck",branch:"else"})
 */
export function formatCall(f: FollowUp): string {
  return `${f.tool}(${literal(f.args)})`;
}

/** The size of a result against a budget: `text.length + JSON.stringify(omitted).length`. */
export function resultSize(r: Pick<OutlineResult, "text" | "omitted">): number {
  return r.text.length + JSON.stringify(r.omitted).length;
}
