/**
 * The value model of a JSON field with reference pills: a JSON value whose `{ $ref }` members
 * show as pills in value position (`{"to": ⟨Contact › email⟩}`) and whose `{ $tpl }` members
 * show as JSON strings with pills inside (`"Hi ⟨Contact › name⟩"`), and back.
 *
 * @module
 */
import { isRef, isTpl, parseTemplate, type ValueExpr } from "@flowlinejs/core";
import { partsToValue, type RefPart } from "./ref-model";

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

/** First code point of the private-use area; pill tokens are built from code points here. */
const PRIVATE_USE_START = 0xe000;

/**
 * Two private-use characters that appear nowhere in `text`, raw or as a `\uXXXX` escape (which
 * `JSON.parse` would decode), to delimit pill tokens without colliding with what the user typed.
 */
function tokenDelimiters(text: string): [string, string] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (let cp = PRIVATE_USE_START; found.length < 2; cp++) {
    const ch = String.fromCharCode(cp);
    if (!text.includes(ch) && !lower.includes(`\\u${cp.toString(16)}`)) found.push(ch);
  }
  return [found[0] as string, found[1] as string];
}

/** Result of reading a JSON field's content. */
export type JsonRead = { ok: true; value: ValueExpr | undefined } | { ok: false };

/**
 * The value of a JSON field's parts: its text parsed as JSON, where a pill in value position is
 * `{ $ref }` and a string holding pills (typed quotes around them) is `{ $tpl }`, literal `{{`
 * escaped. Empty content is `undefined`; text that isn't JSON, or a pill in an object key, is
 * `{ ok: false }`.
 *
 * Pills stand in as tokens of private-use characters that don't occur in the typed text, so the
 * text is parsed by `JSON.parse` itself. `__proto__` keys are kept as own properties.
 */
export function partsToJson(parts: readonly RefPart[]): JsonRead {
  const typed = parts.map((p) => ("text" in p ? p.text : "")).join("");
  const [open, close] = tokenDelimiters(typed);
  const token = new RegExp(`${open}(\\d+)${close}`, "g");
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
      const t = `${open}${pills.length}${close}`;
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
      if (!v.includes(open)) return v;
      const strParts: RefPart[] = [];
      let last = 0;
      for (const m of v.matchAll(token)) {
        const pill = pills[Number(m[1])];
        if (!pill) bad = true;
        strParts.push({ text: v.slice(last, m.index) }, { ref: pill?.ref ?? "" });
        last = m.index + m[0].length;
      }
      strParts.push({ text: v.slice(last) });
      const value = partsToValue(strParts);
      // A lone pill in value position is a reference; inside quotes it is a string of it.
      if (isRef(value)) {
        const [, index] = [...v.matchAll(token)][0] ?? [];
        return pills[Number(index)]?.bare ? value : { $tpl: `{{${value.$ref}}}` };
      }
      return value ?? "";
    }
    if (Array.isArray(v)) return v.map(revive);
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v).map(([k, x]): [string, ValueExpr] => {
        if (k.includes(open)) bad = true;
        return [k, revive(x)];
      });
      // `Object.fromEntries` defines own properties, so a `__proto__` key stays a key.
      return Object.fromEntries(entries);
    }
    return v as ValueExpr;
  };
  const value = revive(parsed);
  return bad ? { ok: false } : { ok: true, value };
}
