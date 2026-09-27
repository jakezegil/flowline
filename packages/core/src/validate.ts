import { isValidStepId, RESERVED_STEP_IDS } from "./ids";
import {
  asSchema,
  branchesFor,
  carryDefs,
  configValueAt,
  derefSchema,
  describeType,
  isAnySchema,
  isAssignable,
  type Kind,
  schemaTypes,
  schemaUnionMembers,
  valueKind,
} from "./json-schema";
import { isRef, isTpl, parseRefPath, parseTemplate, type RefPath } from "./refs";
import {
  indexManifest,
  resolveRefSchema,
  type ScopeEntry,
  triggerEntry,
  type ValidationContext,
  walkScope,
} from "./scope";
import { walkSteps } from "./tree";
import type { JSONSchema, Manifest, NodeManifest, Step, UiMeta, WorkflowDoc } from "./types";
import { UI_META_KEY } from "./ui";

/** Machine-readable kind of a validation {@link Issue}. */
export type IssueCode =
  | "trigger.unknown"
  | "node.unknown"
  | "step.duplicateId"
  | "step.invalidId"
  | "config.required"
  | "config.invalid"
  | "ref.syntax"
  | "ref.unresolved"
  | "ref.outOfScope"
  | "ref.typeMismatch"
  | "branch.unknown"
  | "branch.missing"
  | "subflow.unknown"
  | "subflow.recursive"
  | "doc.empty";

/** One problem found by {@link validateWorkflow}. */
export interface Issue {
  /** What kind of problem this is. */
  code: IssueCode;
  /** `error` blocks publishing; `warning` is advisory. */
  severity: "error" | "warning";
  /** User-facing explanation, naming fields by their label. */
  message: string;
  /** The step the issue belongs to. Absent for trigger, `output` and doc-level issues. */
  stepId?: string;
  /**
   * Path of the offending config field, e.g. `"to"`, `"headers.replyTo"`, `"cc[1]"`. Trigger config
   * fields are prefixed `"trigger."`, sub-flow output mappings `"output."`.
   */
  field?: string;
}

/** Severity of each code outside disabled steps (inside them everything is a warning). */
const WARNING_CODES = new Set<IssueCode>(["ref.typeMismatch", "branch.missing", "doc.empty"]);

const KIND_WORDS: Record<Kind, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  object: "an object",
  array: "a list",
  null: "empty",
};

/** Where a value sits, for messages and `Issue.field`. */
interface FieldCtx {
  /** Root schema that local `$ref`s resolve against. */
  root: JSONSchema;
  /** `Issue.field`. */
  path: string;
  /** User-facing label. */
  label: string;
}

/** Per-location validation state: where refs resolve and how issues are reported. */
interface Reporter {
  issues: Issue[];
  stepId: string | undefined;
  /** Everything inside a disabled step reports warnings. */
  disabled: boolean;
  /** `"trigger"` in trigger config: only refs into the incoming payload are allowed there. */
  refRoots: "any" | "trigger";
  visible: readonly ScopeEntry[];
  /** The step being validated plus its ancestors, for out-of-scope explanations. */
  current: Step | undefined;
  ancestors: readonly Step[];
  doc: DocInfo;
}

interface DocInfo {
  ids: Set<string>;
  /** Pre-order position of each step ID (first occurrence). */
  order: Map<string, number>;
  /** IDs of top-level steps. */
  topLevel: Set<string>;
}

function report(r: Reporter, code: IssueCode, message: string, field?: string): void {
  const severity = r.disabled || WARNING_CODES.has(code) ? "warning" : "error";
  r.issues.push({
    code,
    severity,
    message,
    ...(r.stepId !== undefined ? { stepId: r.stepId } : {}),
    ...(field !== undefined ? { field } : {}),
  });
}

function fork(r: Reporter): Reporter {
  return { ...r, issues: [] };
}

function uiMeta(schema: JSONSchema | undefined): UiMeta | undefined {
  const meta = schema?.[UI_META_KEY];
  return typeof meta === "object" && meta !== null ? (meta as UiMeta) : undefined;
}

function labelOf(schema: JSONSchema | undefined, key: string): string {
  const label = uiMeta(schema)?.label;
  return typeof label === "string" && label !== "" ? label : key;
}

function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function formatSegments(segments: (string | number)[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

function stepLabel(step: Step, m: NodeManifest | undefined): string {
  return step.name ?? m?.name ?? step.type;
}

// ---------------------------------------------------------------------------------------------
// References

function outOfScopeReason(r: Reporter, stepId: string): string {
  const current = r.current;
  if (current === undefined) {
    return `which is inside a branch; the output can only use top-level steps`;
  }
  if (stepId === current.id) return "which is this step's own output";
  if (r.ancestors.some((a) => a.id === stepId)) {
    return "whose output isn't available until the loop finishes";
  }
  const target = r.doc.order.get(stepId) ?? 0;
  const here = r.doc.order.get(current.id) ?? 0;
  if (target > here) return "which runs after this step";
  return "which is inside a branch that doesn't lead here";
}

/** Resolves one ref path; checks it against `target` when given. */
function checkRef(r: Reporter, raw: string, target: JSONSchema | undefined, f: FieldCtx): void {
  const ref = raw.trim();
  let path: RefPath;
  try {
    path = parseRefPath(ref);
  } catch {
    report(r, "ref.syntax", `"${f.label}" has an invalid reference "${ref}"`, f.path);
    return;
  }
  if (r.refRoots === "trigger" && path.root !== "trigger") {
    report(
      r,
      "config.invalid",
      `"${f.label}" can only reference the trigger's payload in trigger settings`,
      f.path,
    );
    return;
  }
  const res = resolveRefSchema(path, r.visible);
  if (!res.ok && res.reason === "notVisible") {
    if (path.root === "loop") {
      report(
        r,
        "ref.outOfScope",
        `"${f.label}" uses the loop item, but this step isn't inside a loop`,
        f.path,
      );
      return;
    }
    const stepId = path.stepId ?? "";
    if (!r.doc.ids.has(stepId)) {
      report(
        r,
        "ref.unresolved",
        `"${f.label}" references step "${stepId}" which no longer exists`,
        f.path,
      );
    } else {
      report(
        r,
        "ref.outOfScope",
        `"${f.label}" references step "${stepId}", ${outOfScopeReason(r, stepId)}`,
        f.path,
      );
    }
    return;
  }
  if (!res.ok) {
    const segments = path.root === "loop" ? path.segments.slice(1) : path.segments;
    const where =
      path.root === "trigger"
        ? "the trigger"
        : path.root === "loop"
          ? "the loop item"
          : `step "${path.stepId}"`;
    report(
      r,
      "ref.unresolved",
      `"${f.label}" references field "${formatSegments(segments)}", which doesn't exist on ${where}`,
      f.path,
    );
    return;
  }
  const entry = res.entry;
  if (entry?.disabled && entry.kind === "step") {
    report(
      r,
      "ref.typeMismatch",
      `"${f.label}" references step "${entry.stepId}", which is disabled (its output will be empty)`,
      f.path,
    );
    return;
  }
  if (target !== undefined && !isAssignable(res.schema, target)) {
    report(
      r,
      "ref.typeMismatch",
      `"${f.label}" expects ${describeType(target)} but ${ref} is ${describeType(res.schema)}`,
      f.path,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Literals

const patternCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  let re = patternCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    patternCache.set(pattern, re);
  }
  return re;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

function kindAllowed(kind: Kind, allowed: string[]): boolean {
  if (allowed.includes(kind)) return true;
  return kind === "integer" && allowed.includes("number");
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function describeKinds(kinds: string[]): string {
  return kinds
    .filter((k) => k !== "null" || kinds.length === 1)
    .map((k) => KIND_WORDS[k as Kind] ?? k)
    .join(" or ");
}

/** Why a primitive literal doesn't satisfy a (non-union) schema, or `undefined` if it does. */
function literalProblem(value: unknown, s: JSONSchema): string | undefined {
  const types = schemaTypes(s);
  const kind = valueKind(value);
  if (types && !kindAllowed(kind, types)) return `must be ${describeKinds(types)}`;
  if ("const" in s && !sameJson(value, s.const)) return `must be ${JSON.stringify(s.const)}`;
  if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value))) {
    return `must be one of: ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) {
      return `must be at least ${s.minLength} character${s.minLength === 1 ? "" : "s"}`;
    }
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) {
      return `must be at most ${s.maxLength} characters`;
    }
    if (s.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
      return "must be a date and time (ISO 8601, e.g. 2026-01-31T09:00:00Z)";
    }
    if (typeof s.pattern === "string") {
      const re = compilePattern(s.pattern);
      if (re && !re.test(value)) return "has an invalid format";
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return `must be at least ${s.minimum}`;
    if (typeof s.maximum === "number" && value > s.maximum) return `must be at most ${s.maximum}`;
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) {
      return `must be greater than ${s.exclusiveMinimum}`;
    }
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) {
      return `must be less than ${s.exclusiveMaximum}`;
    }
  }
  return undefined;
}

function allowsNull(root: JSONSchema, schema: JSONSchema): boolean {
  const s = derefSchema(root, schema);
  if (isAnySchema(s)) return true;
  if (schemaTypes(s)?.includes("null")) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  const members = (s.anyOf ?? s.oneOf) as unknown;
  return Array.isArray(members) && members.some((m) => allowsNull(root, m as JSONSchema));
}

function isEmptyValue(value: unknown, root: JSONSchema, schema: JSONSchema): boolean {
  if (value === undefined || value === "") return true;
  if (isTpl(value) && value.$tpl.trim() === "") return true;
  return value === null && !allowsNull(root, schema);
}

function errorCount(r: Reporter): number {
  return r.issues.filter((i) => i.severity === "error").length;
}

// ---------------------------------------------------------------------------------------------
// Values

/** Checks any config value (literal, ref, template, or nested) against a field schema. */
function checkValue(r: Reporter, value: unknown, schema: JSONSchema, f: FieldCtx): void {
  const s = derefSchema(f.root, schema);
  const meta = uiMeta(schema) ?? uiMeta(s);

  if (isRef(value) || isTpl(value)) {
    if (meta?.literalOnly) {
      report(r, "config.invalid", `"${f.label}" doesn't accept references`, f.path);
      return;
    }
  }
  if (isRef(value)) {
    checkRef(r, value.$ref, isAnySchema(s) ? undefined : carryDefs(f.root, s), f);
    return;
  }
  if (meta?.refOnly) {
    report(
      r,
      "config.invalid",
      `"${f.label}" must be a reference to a value from an earlier step`,
      f.path,
    );
    return;
  }
  if (isTpl(value)) {
    for (const part of parseTemplate(value.$tpl)) {
      if ("ref" in part) checkRef(r, part.ref, undefined, f);
    }
    if (!isAssignable({ type: "string" }, carryDefs(f.root, s))) {
      report(
        r,
        "ref.typeMismatch",
        `"${f.label}" expects ${describeType(carryDefs(f.root, s))} but a template always produces text`,
        f.path,
      );
    }
    return;
  }

  if (s.not !== undefined && isAnySchema(s.not)) {
    report(r, "config.invalid", `"${f.label}" is not allowed here`, f.path);
    return;
  }
  if (isAnySchema(s)) {
    // Nothing to check, but nested refs must still resolve.
    walkNested(r, value, f);
    return;
  }

  const members = schemaUnionMembers(f.root, s);
  if (members) {
    if (value === null && allowsNull(f.root, s)) return;
    if (members.length === 1) {
      checkValue(r, value, members[0] as JSONSchema, f);
      return;
    }
    let best: Reporter | undefined;
    for (const member of members) {
      const trial = fork(r);
      checkValue(trial, value, member, f);
      if (!best || errorCount(trial) < errorCount(best)) best = trial;
      if (errorCount(trial) === 0) break;
    }
    const isContainer = typeof value === "object" && value !== null;
    if (best && (errorCount(best) === 0 || isContainer)) {
      r.issues.push(...best.issues);
    } else {
      report(
        r,
        "config.invalid",
        `"${f.label}" must be ${describeType(carryDefs(f.root, s))}`,
        f.path,
      );
    }
    return;
  }
  if (Array.isArray(s.allOf)) {
    for (const member of s.allOf) checkValue(r, value, member as JSONSchema, f);
    return;
  }

  const types = schemaTypes(s);
  if (Array.isArray(value)) {
    if (types && !types.includes("array")) {
      report(r, "config.invalid", `"${f.label}" must be ${describeKinds(types)}`, f.path);
      return;
    }
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      report(r, "config.invalid", `"${f.label}" must have at least ${s.minItems} items`, f.path);
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      report(r, "config.invalid", `"${f.label}" must have at most ${s.maxItems} items`, f.path);
    }
    const prefix: unknown[] = Array.isArray(s.prefixItems) ? s.prefixItems : [];
    const closed = s.items === false;
    const maxCovers = typeof s.maxItems === "number" && s.maxItems <= prefix.length;
    if (closed && value.length > prefix.length && !maxCovers) {
      report(r, "config.invalid", `"${f.label}" must have at most ${prefix.length} items`, f.path);
    }
    value.forEach((item, i) => {
      if (closed && i >= prefix.length) return;
      const itemSchema = asSchema(i < prefix.length ? prefix[i] : s.items);
      checkValue(r, item, itemSchema, {
        root: f.root,
        path: `${f.path}[${i}]`,
        label: `${f.label} item ${i + 1}`,
      });
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (types && !types.includes("object")) {
      report(r, "config.invalid", `"${f.label}" must be ${describeKinds(types)}`, f.path);
      return;
    }
    checkObject(r, value as Record<string, unknown>, s, f.root, f.path);
    return;
  }
  const problem = literalProblem(value, s);
  if (problem) report(r, "config.invalid", `"${f.label}" ${problem}`, f.path);
}

/** Resolves refs inside a value whose schema is unconstrained. */
function walkNested(r: Reporter, value: unknown, f: FieldCtx): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      checkValue(r, item, {}, { ...f, path: `${f.path}[${i}]`, label: `${f.label} item ${i + 1}` });
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      checkValue(r, v, {}, { ...f, path: joinPath(f.path, key), label: key });
    }
  }
}

/**
 * Checks an object value against an object schema: required keys, each declared property, and
 * extra keys against `additionalProperties`. `overrides` replaces the schema of individual keys.
 */
/**
 * Runs a check, turning an unexpected exception (e.g. from an odd schema shape) into a
 * warning-level `config.invalid` issue so validation never crashes the editor or publish gate.
 */
function guarded(
  r: Reporter,
  f: { path: string; label: string } | undefined,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    r.issues.push({
      code: "config.invalid",
      severity: "warning",
      message: f
        ? `Could not validate field "${f.label}": ${reason}`
        : `Could not validate this step: ${reason}`,
      ...(r.stepId !== undefined ? { stepId: r.stepId } : {}),
      ...(f ? { field: f.path } : {}),
    });
  }
}

function checkObject(
  r: Reporter,
  obj: Record<string, unknown>,
  schema: JSONSchema,
  root: JSONSchema,
  prefix: string,
  overrides: Record<string, JSONSchema> = {},
): void {
  const rawProps = schema.properties;
  const props = (typeof rawProps === "object" && rawProps !== null ? rawProps : {}) as Record<
    string,
    unknown
  >;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const [key, rawDeclared] of Object.entries(props)) {
    const declared = asSchema(rawDeclared);
    const override = overrides[key];
    const propSchema = override ?? declared;
    const propRoot = override ?? root;
    const f: FieldCtx = {
      root: propRoot,
      path: joinPath(prefix, key),
      label: labelOf(declared, key),
    };
    const value = obj[key];
    if (isEmptyValue(value, propRoot, propSchema)) {
      if (required.has(key)) {
        report(r, "config.required", `"${f.label}" is required`, f.path);
        continue;
      }
      if (value === undefined) continue;
    }
    guarded(r, f, () => checkValue(r, value, propSchema, f));
  }
  for (const key of required) {
    if (!Object.hasOwn(props, key) && isEmptyValue(obj[key], root, {})) {
      report(r, "config.required", `"${key}" is required`, joinPath(prefix, key));
    }
  }
  const extra = schema.additionalProperties;
  for (const [key, value] of Object.entries(obj)) {
    if (Object.hasOwn(props, key)) continue;
    const f: FieldCtx = { root, path: joinPath(prefix, key), label: key };
    if (extra === false) {
      report(r, "config.invalid", `"${key}" is not a known field`, f.path);
      continue;
    }
    guarded(r, f, () => checkValue(r, value, asSchema(extra), f));
  }
}

// ---------------------------------------------------------------------------------------------
// Steps

function checkBranches(r: Reporter, step: Step, m: NodeManifest): void {
  const label = stepLabel(step, m);
  const present = Object.keys(step.branches ?? {});
  const spec = m.branches;
  if (spec.kind === "none") {
    for (const key of present) {
      report(r, "branch.unknown", `"${label}" doesn't have branches, but has branch "${key}"`);
    }
    return;
  }
  // Branches from a non-literal config value can't be known statically.
  if (spec.kind === "fromConfig" && !Array.isArray(configValueAt(step.config, spec.configPath))) {
    return;
  }
  const declared = branchesFor(m, step);
  const ids = new Set(declared.map((b) => b.id));
  for (const key of present) {
    if (!ids.has(key)) report(r, "branch.unknown", `"${label}" has no branch "${key}"`);
  }
  for (const b of declared) {
    if (!present.includes(b.id)) {
      report(r, "branch.missing", `Branch "${b.label}" of "${label}" is missing`);
    }
  }
}

/** The config key holding a sub-flow call's input mapping (by convention of `core.callSubflow`). */
const SUBFLOW_INPUT_KEY = "input";

function checkStep(
  r: Reporter,
  doc: WorkflowDoc,
  step: Step,
  m: NodeManifest,
  ctx: ValidationContext,
): void {
  const overrides: Record<string, JSONSchema> = {};
  const subflowIssues: (() => void)[] = [];
  if (m.output.kind === "subflow") {
    const configPath = m.output.configPath;
    const id = configValueAt(step.config, configPath);
    if (typeof id === "string" && id !== "") {
      const label = labelOf(
        (m.input.properties as Record<string, JSONSchema> | undefined)?.[configPath],
        configPath,
      );
      if (id === doc.id) {
        subflowIssues.push(() =>
          report(r, "subflow.recursive", `"${label}" calls this workflow itself`, configPath),
        );
      } else if (ctx.subflows) {
        const sub = Object.hasOwn(ctx.subflows, id) ? ctx.subflows[id] : undefined;
        if (!sub) {
          subflowIssues.push(() =>
            report(
              r,
              "subflow.unknown",
              `"${label}" calls sub-flow "${id}", which doesn't exist or isn't published`,
              configPath,
            ),
          );
        } else {
          overrides[SUBFLOW_INPUT_KEY] = sub.input;
        }
      }
    }
  }
  checkObject(r, step.config, derefSchema(m.input, m.input), m.input, "", overrides);
  checkBranches(r, step, m);
  for (const push of subflowIssues) push();
}

function docInfo(doc: WorkflowDoc): DocInfo {
  const ids = new Set<string>();
  const order = new Map<string, number>();
  let n = 0;
  walkSteps(doc, (step) => {
    ids.add(step.id);
    if (!order.has(step.id)) order.set(step.id, n);
    n++;
  });
  return { ids, order, topLevel: new Set(doc.steps.map((s) => s.id)) };
}

/**
 * Validates a workflow document against a manifest. Pure and isomorphic: the editor runs it live
 * and the server runs it as the publish gate (publishing is rejected if any issue is an `error`).
 *
 * Checks: unknown trigger/node types; step ID syntax and uniqueness; required config fields
 * (missing or empty); literal values against the field's JSON Schema (type, enum/const,
 * length, range, `date-time`, pattern, nested objects and arrays); every `$ref` (including inside
 * `$tpl`) parses, resolves to a visible step/field ({@link availableScope} rule) and has an
 * assignable type (mismatches are warnings); branch keys match declared branches; sub-flow
 * calls target a known (`ctx.subflows`), non-recursive workflow with a valid input mapping; the
 * doc's `output` mapping resolves in end-of-doc scope. Trigger config may hold only literals.
 *
 * Steps that are disabled (or inside a disabled block) are still validated, with every issue
 * downgraded to a warning; references to a disabled step are warned about.
 */
export function validateWorkflow(
  doc: WorkflowDoc,
  manifest: Manifest,
  ctx: ValidationContext = {},
): Issue[] {
  const idx = indexManifest(manifest);
  const info = docInfo(doc);
  const issues: Issue[] = [];
  const base: Reporter = {
    issues,
    stepId: undefined,
    disabled: false,
    refRoots: "any",
    visible: [],
    current: undefined,
    ancestors: [],
    doc: info,
  };

  if (doc.steps.length === 0) report(base, "doc.empty", "This workflow has no steps");

  const trigger = idx.triggers.get(doc.trigger.type);
  if (!trigger) {
    report(base, "trigger.unknown", `Unknown trigger type "${doc.trigger.type}"`);
  } else {
    checkObject(
      { ...base, refRoots: "trigger", visible: [triggerEntry(doc, idx)] },
      doc.trigger.config,
      derefSchema(trigger.config, trigger.config),
      trigger.config,
      "trigger",
    );
  }

  const seen = new Set<string>();
  const end = walkScope(doc, manifest, ctx, (step, visible, { disabled, ancestors }) => {
    const r: Reporter = {
      ...base,
      stepId: step.id,
      disabled,
      visible,
      current: step,
      ancestors,
    };
    if (seen.has(step.id)) {
      report(r, "step.duplicateId", `Step ID "${step.id}" is used more than once`);
    } else if (!isValidStepId(step.id)) {
      report(
        r,
        "step.invalidId",
        `Step ID "${step.id}" must start with a letter or underscore and contain only letters, digits and underscores, and must not be one of ${[...RESERVED_STEP_IDS].join(", ")}`,
      );
    }
    seen.add(step.id);

    const m = idx.nodes.get(step.type);
    if (!m) {
      report(r, "node.unknown", `Unknown step type "${step.type}"`);
      return undefined;
    }
    guarded(r, undefined, () => checkStep(r, doc, step, m, ctx));
    return undefined;
  });

  if (doc.output) {
    const r: Reporter = { ...base, visible: end };
    for (const [key, value] of Object.entries(doc.output)) {
      const f: FieldCtx = { root: {}, path: `output.${key}`, label: key };
      guarded(r, f, () => checkValue(r, value, {}, f));
    }
  }
  return issues;
}

/** True if any issue is an `error` (which blocks publishing). */
export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
