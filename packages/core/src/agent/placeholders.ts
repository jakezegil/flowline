/**
 * Placeholder resolution: `$1`, `$deal` in step arguments, and `steps.$1…` inside `$ref` paths
 * and `{{ }}` templates.
 *
 * @module
 */
import { isRef, isTpl } from "../refs";
import type { ValueExpr } from "../types";
import type { StepRef } from "./commands";

/** A `steps.$x` at the start of a ref path (after optional spaces). */
const REF_HEAD = /^(\s*steps\s*\.\s*)(\$[A-Za-z0-9_]+)/;

/**
 * `tpl` with the inside of each `{{ … }}` reference passed through `fn`, and everything else
 * (literal text, `\{{` escapes) kept byte for byte. Scans as `parseTemplate` does, so
 * exactly the parts it reads as references are rewritten.
 */
function mapTemplateRefs(tpl: string, fn: (inner: string) => string): string {
  let out = "";
  const n = tpl.length;
  let i = 0;
  while (i < n) {
    if (tpl.charAt(i) === "\\" && tpl.charAt(i + 1) === "{" && tpl.charAt(i + 2) === "{") {
      out += tpl.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (tpl.charAt(i) === "{" && tpl.charAt(i + 1) === "{" && tpl.charAt(i + 2) === "{") {
      out += "{";
      i++;
      continue;
    }
    if (tpl.charAt(i) === "{" && tpl.charAt(i + 1) === "{") {
      const end = tpl.indexOf("}}", i + 2);
      if (end === -1) return out + tpl.slice(i);
      out += `{{${fn(tpl.slice(i + 2, end))}}}`;
      i = end + 2;
      continue;
    }
    out += tpl.charAt(i);
    i++;
  }
  return out;
}

/**
 * @internal The real step ID for `ref`: a placeholder (`$…`) looked up in `ids`, anything else
 * as is. `undefined` for an unknown placeholder.
 */
export function resolveStepRef(ref: StepRef, ids: Map<string, string>): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith("$")) return ref;
  return ids.get(ref);
}

/**
 * @internal `v` with every `steps.$x` in its `$ref` paths and `{{ }}` templates replaced by the
 * real ID, and `used` given each placeholder it met. Returns `v` itself when nothing changes;
 * `unknown` is the first placeholder `ids` doesn't hold (left in place).
 */
export function resolveValuePlaceholders(
  v: ValueExpr,
  ids: Map<string, string>,
  used?: Map<string, string>,
): { value: ValueExpr; unknown?: string } {
  let unknown: string | undefined;
  const sub = (placeholder: string): string | undefined => {
    const id = ids.get(placeholder);
    if (id === undefined) unknown ??= placeholder;
    else used?.set(placeholder, id);
    return id;
  };
  const walk = (x: ValueExpr): ValueExpr => {
    if (Array.isArray(x)) {
      let changed = false;
      const out = x.map((e) => {
        const r = walk(e);
        if (r !== e) changed = true;
        return r;
      });
      return changed ? out : x;
    }
    if (x === null || typeof x !== "object") return x;
    if (isRef(x)) {
      const m = REF_HEAD.exec(x.$ref);
      if (!m) return x;
      const id = sub(m[2] as string);
      return id === undefined ? x : { ...x, $ref: `${m[1]}${id}${x.$ref.slice(m[0].length)}` };
    }
    if (isTpl(x)) {
      if (!x.$tpl.includes("$")) return x;
      const next = mapTemplateRefs(x.$tpl, (inner) => {
        const m = REF_HEAD.exec(inner);
        if (!m) return inner;
        const id = sub(m[2] as string);
        return id === undefined ? inner : `${m[1]}${id}${inner.slice(m[0].length)}`;
      });
      return next === x.$tpl ? x : { ...x, $tpl: next };
    }
    let changed = false;
    const out: Record<string, ValueExpr> = {};
    for (const [k, e] of Object.entries(x)) {
      const r = walk(e);
      if (r !== e) changed = true;
      out[k] = r;
    }
    return changed ? out : x;
  };
  const value = walk(v);
  return unknown === undefined ? { value } : { value, unknown };
}
