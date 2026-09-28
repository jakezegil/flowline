import type { RefExpr, TplExpr, ValueExpr } from "./types";

/** Thrown when a `$ref` path or `{{ }}` template fails to parse. */
export class FlowkitRefError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name = "FlowkitRefError";
}

/** The top-level namespace a reference path starts from. */
export type RefRoot = "trigger" | "steps" | "loop" | "run";

/**
 * A parsed `$ref` path, e.g. `steps.load.emails[0].value` →
 * `{ root: "steps", stepId: "load", segments: ["emails", 0, "value"] }`.
 */
export interface RefPath {
  /** Which namespace the path resolves against. */
  root: RefRoot;
  /** For `root: "steps"`, the referenced step's ID. */
  stepId?: string;
  /** Remaining property/index path after the root (and step ID, if any). */
  segments: (string | number)[];
}

const IDENTIFIER = /^[A-Za-z0-9_$]$/;
/** Matches a valid step ID: see {@link https://flowkit.dev step-id syntax}. */
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function fail(path: string): never {
  throw new FlowkitRefError(`Invalid reference path: "${path}"`);
}

/** Tokenizes a full path (including its root) into a flat list of segments. */
function tokenize(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const n = path.length;
  let i = 0;

  function parseIdentifier(): string {
    const start = i;
    while (i < n && IDENTIFIER.test(path.charAt(i))) i++;
    if (i === start) fail(path);
    return path.slice(start, i);
  }

  if (n === 0) fail(path);
  segments.push(parseIdentifier());

  while (i < n) {
    const c = path.charAt(i);
    if (c === ".") {
      i++;
      segments.push(parseIdentifier());
    } else if (c === "[") {
      i++;
      const quote = path.charAt(i);
      if (quote === '"' || quote === "'") {
        i++;
        const start = i;
        while (i < n && path.charAt(i) !== quote) i++;
        if (i >= n) fail(path);
        const str = path.slice(start, i);
        i++; // closing quote
        if (path.charAt(i) !== "]") fail(path);
        i++;
        segments.push(str);
      } else {
        const start = i;
        while (i < n && /[0-9]/.test(path.charAt(i))) i++;
        if (i === start) fail(path);
        const num = path.slice(start, i);
        if (path.charAt(i) !== "]") fail(path);
        i++;
        segments.push(Number(num));
      }
    } else {
      fail(path);
    }
  }
  return segments;
}

/**
 * Parses a `$ref` path string into a structured {@link RefPath}.
 *
 * Grammar: `trigger[.<path>]`, `steps.<stepId>[.<path>]`, `loop.item[.<path>]`, `loop.index`,
 * `run.id`, where `<path>` is `.`-separated identifiers with optional `[n]` numeric or
 * `["a b"]` bracket-string indices.
 *
 * @throws {FlowkitRefError} If the syntax is invalid or the root/path combination is unknown.
 */
export function parseRefPath(path: string): RefPath {
  const tokens = tokenize(path);
  const root = tokens[0];
  const rest = tokens.slice(1);

  if (root === "trigger") {
    return { root: "trigger", segments: rest };
  }

  if (root === "steps") {
    const stepId = rest[0];
    if (typeof stepId !== "string" || !STEP_ID.test(stepId)) fail(path);
    return { root: "steps", stepId, segments: rest.slice(1) };
  }

  if (root === "loop") {
    const first = rest[0];
    if (first === "index") {
      if (rest.length !== 1) fail(path);
      return { root: "loop", segments: ["index"] };
    }
    if (first === "item") {
      return { root: "loop", segments: rest };
    }
    fail(path);
  }

  if (root === "run") {
    if (rest.length !== 1 || rest[0] !== "id") fail(path);
    return { root: "run", segments: ["id"] };
  }

  fail(path);
}

function formatSegment(seg: string | number): string {
  if (typeof seg === "number") return `[${seg}]`;
  if (PLAIN_SEGMENT.test(seg)) return `.${seg}`;
  return `[${JSON.stringify(seg)}]`;
}

/** Formats a {@link RefPath} back into its `$ref` string form. */
export function formatRefPath(p: RefPath): string {
  let out: string = p.root;
  if (p.stepId !== undefined) out += `.${p.stepId}`;
  for (const seg of p.segments) out += formatSegment(seg);
  return out;
}

/** True if `v` is a `{ $ref: string }` reference expression. */
export function isRef(v: unknown): v is RefExpr {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { $ref?: unknown }).$ref === "string"
  );
}

/** True if `v` is a `{ $tpl: string }` template expression. */
export function isTpl(v: unknown): v is TplExpr {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { $tpl?: unknown }).$tpl === "string"
  );
}

/** The values a `$ref`/`$tpl` resolves against at a given point in a run. */
export interface ResolveScope {
  /** The trigger's payload. */
  trigger: unknown;
  /** Outputs of steps that have already run, keyed by step ID. */
  steps: Record<string, unknown>;
  /** Present while inside a `forEach` body. */
  loop?: { item: unknown; index: number };
  /** The current run. */
  run: { id: string };
}

function getAt(obj: unknown, segments: (string | number)[]): unknown {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

function resolveRefPath(path: RefPath, scope: ResolveScope): unknown {
  switch (path.root) {
    case "trigger":
      return getAt(scope.trigger, path.segments);
    case "run":
      return scope.run.id;
    case "steps": {
      const base = path.stepId !== undefined ? scope.steps[path.stepId] : undefined;
      return getAt(base, path.segments);
    }
    case "loop": {
      if (!scope.loop) return undefined;
      const [first, ...rest] = path.segments;
      if (first === "index") return scope.loop.index;
      if (first === "item") return getAt(scope.loop.item, rest);
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Resolves a {@link ValueExpr} against a scope, recursing into arrays/objects.
 * A `$ref` resolves to the raw referenced value (`undefined` if missing); a `$tpl` always
 * resolves to a rendered string, even when its content is a single `{{ ref }}`.
 */
export function resolveValue(expr: ValueExpr, scope: ResolveScope): unknown {
  if (Array.isArray(expr)) return expr.map((e) => resolveValue(e, scope));
  if (isRef(expr)) return resolveRefPath(parseRefPath(expr.$ref), scope);
  if (isTpl(expr)) return renderTemplate(expr.$tpl, scope);
  if (expr !== null && typeof expr === "object") {
    // `Object.fromEntries` defines own properties, so a `__proto__` key stays plain data.
    return Object.fromEntries(Object.entries(expr).map(([k, v]) => [k, resolveValue(v, scope)]));
  }
  return expr;
}

function formatTemplateValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Renders a `$tpl` string against a scope. Refs interpolate as: strings as-is, numbers/booleans
 * via `String()`, `null`/`undefined` as `""`, and objects/arrays via `JSON.stringify`.
 */
export function renderTemplate(tpl: string, scope: ResolveScope): string {
  return parseTemplate(tpl)
    .map((part) => {
      if ("text" in part) return part.text;
      const value = resolveRefPath(parseRefPath(part.ref), scope);
      return formatTemplateValue(value);
    })
    .join("");
}

/** One chunk of a parsed template: literal text, or a `{{ ref }}` interpolation. */
export type TemplatePart = { text: string } | { ref: string };

/**
 * Splits a template string into literal-text and ref parts. `{{ path }}` (optional surrounding
 * whitespace) interpolates `path`; `\{{` escapes a literal `{{`. In a run of three or more `{`,
 * only the last two open the reference, so `{{{x}}}` is a literal `{` then `x`.
 */
export function parseTemplate(tpl: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let buf = "";
  const n = tpl.length;
  let i = 0;

  while (i < n) {
    if (tpl.charAt(i) === "\\" && tpl.charAt(i + 1) === "{" && tpl.charAt(i + 2) === "{") {
      buf += "{{";
      i += 3;
      continue;
    }
    // In a run of three or more braces, only the last two open the reference: `{{{x}}}` is a
    // literal `{` followed by `{{x}}` (e.g. JSON text `{` right before a reference).
    if (tpl.charAt(i) === "{" && tpl.charAt(i + 1) === "{" && tpl.charAt(i + 2) === "{") {
      buf += "{";
      i++;
      continue;
    }
    if (tpl.charAt(i) === "{" && tpl.charAt(i + 1) === "{") {
      const end = tpl.indexOf("}}", i + 2);
      if (end === -1) {
        buf += tpl.slice(i);
        i = n;
        break;
      }
      if (buf) {
        parts.push({ text: buf });
        buf = "";
      }
      parts.push({ ref: tpl.slice(i + 2, end).trim() });
      i = end + 2;
      continue;
    }
    buf += tpl.charAt(i);
    i++;
  }
  if (buf) parts.push({ text: buf });
  return parts;
}

function collectRefsInto(expr: ValueExpr, out: string[]): void {
  if (Array.isArray(expr)) {
    for (const e of expr) collectRefsInto(e, out);
    return;
  }
  if (isRef(expr)) {
    out.push(expr.$ref);
    return;
  }
  if (isTpl(expr)) {
    for (const part of parseTemplate(expr.$tpl)) {
      if ("ref" in part) out.push(part.ref);
    }
    return;
  }
  if (expr !== null && typeof expr === "object") {
    for (const v of Object.values(expr)) collectRefsInto(v, out);
  }
}

/** Collects every `$ref` path in a {@link ValueExpr}, including those inside `$tpl` templates. */
export function collectRefs(expr: ValueExpr): string[] {
  const out: string[] = [];
  collectRefsInto(expr, out);
  return out;
}
