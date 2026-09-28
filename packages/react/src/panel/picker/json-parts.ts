/**
 * The value model of a JSON field with reference pills: a JSON value whose `{ $ref }` members
 * show as pills in value position (`{"to": ⟨Contact › email⟩}`) and whose `{ $tpl }` members
 * show as JSON strings with pills inside (`"Hi ⟨Contact › name⟩"`), and back.
 *
 * @module
 */
import { isRef, isTpl, parseTemplate, type ValueExpr } from "@flowkit/core";
import type { RefPart } from "./ref-model";

/** Text of a JSON string's content (no quotes). */
const strContent = (s: string) => JSON.stringify(s).slice(1, -1);

/**
 * The parts a JSON value shows as, pretty-printed with two-space indents like
 * `JSON.stringify(value, null, 2)`: a reference is one pill, a template a string with pills.
 */
export function jsonToParts(value: ValueExpr | undefined): RefPart[] {
  if (value === undefined) return [];
  const out: RefPart[] = [];
  const text = (t: string) => {
    const last = out[out.length - 1];
    if (last && "text" in last) last.text += t;
    else out.push({ text: t });
  };
  const write = (v: ValueExpr, indent: string): void => {
    if (isRef(v)) {
      out.push({ ref: v.$ref });
      return;
    }
    if (isTpl(v)) {
      text('"');
      for (const p of parseTemplate(v.$tpl)) {
        if ("ref" in p) out.push({ ref: p.ref });
        else text(strContent(p.text));
      }
      text('"');
      return;
    }
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        text("[]");
        return;
      }
      text("[");
      v.forEach((item, i) => {
        text(`${i === 0 ? "" : ","}\n${inner}`);
        write(item, inner);
      });
      text(`\n${indent}]`);
      return;
    }
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v);
      if (entries.length === 0) {
        text("{}");
        return;
      }
      text("{");
      entries.forEach(([k, item], i) => {
        text(`${i === 0 ? "" : ","}\n${inner}${JSON.stringify(k)}: `);
        write(item, inner);
      });
      text(`\n${indent}}`);
      return;
    }
    text(JSON.stringify(v));
  };
  write(value, "");
  return out;
}

/** Stands in for pill `i` while the text is parsed (private-use code points). */
const token = (i: number) => `${i}`;
const TOKEN = /(\d+)/g;
const WHOLE_TOKEN = /^(\d+)$/;
const escapeText = (t: string) => t.replace(/\{\{/g, "\\{{");

/** Result of reading a JSON field's content. */
export type JsonRead = { ok: true; value: ValueExpr | undefined } | { ok: false };

/**
 * The value of a JSON field's parts: its text parsed as JSON, where a pill in value position is
 * `{ $ref }` and a string holding pills (typed quotes around them) is `{ $tpl }`, literal `{{`
 * escaped. Empty content is `undefined`; text that isn't JSON, or a pill in an object key, is
 * `{ ok: false }`.
 */
export function partsToJson(parts: readonly RefPart[]): JsonRead {
  let src = "";
  /** Each pill, and whether it stood in value position (outside a JSON string). */
  const pills: { ref: string; bare: boolean }[] = [];
  let inString = false;
  let escaped = false;
  for (const part of parts) {
    if ("text" in part) {
      for (const ch of part.text) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = inString;
        else if (ch === '"') inString = !inString;
      }
      src += part.text;
    } else {
      const t = token(pills.length);
      pills.push({ ref: part.ref, bare: !inString });
      src += inString ? t : `"${t}"`;
    }
  }
  if (src.trim() === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(src);
  } catch {
    return { ok: false };
  }
  let bad = false;
  const revive = (v: unknown): ValueExpr => {
    if (typeof v === "string") {
      const whole = WHOLE_TOKEN.exec(v);
      const only = whole ? pills[Number(whole[1])] : undefined;
      if (only?.bare) return { $ref: only.ref };
      if (!v.includes("")) return v;
      let tpl = "";
      let last = 0;
      for (const m of v.matchAll(TOKEN)) {
        tpl += `${escapeText(v.slice(last, m.index))}{{${pills[Number(m[1])]?.ref}}}`;
        last = m.index + m[0].length;
      }
      return { $tpl: tpl + escapeText(v.slice(last)) };
    }
    if (Array.isArray(v)) return v.map(revive);
    if (v !== null && typeof v === "object") {
      const out: Record<string, ValueExpr> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.includes("")) bad = true;
        out[k] = revive(x);
      }
      return out;
    }
    return v as ValueExpr;
  };
  const value = revive(parsed);
  return bad ? { ok: false } : { ok: true, value };
}
