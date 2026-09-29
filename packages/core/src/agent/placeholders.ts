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
/** A `{{ steps.$x` inside a template. */
const TPL_HEAD = /(\{\{\s*steps\s*\.\s*)(\$[A-Za-z0-9_]+)/g;

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
      const next = x.$tpl.replace(TPL_HEAD, (all, head: string, p: string) => {
        const id = sub(p);
        return id === undefined ? all : `${head}${id}`;
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
