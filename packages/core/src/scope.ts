import {
  isAnySchema,
  isAssignable,
  outputSchemaFor,
  payloadSchemaFor,
  schemaAtPath,
  schemaTypes,
  subflowOutputSchema,
} from "./json-schema";
import { isRef, parseRefPath, type RefPath } from "./refs";
import { dropHiddenFields } from "./show-if";
import type {
  JSONSchema,
  Manifest,
  NodeManifest,
  Step,
  TriggerManifest,
  WorkflowDoc,
} from "./types";

/** Extra knowledge the validator and scope computation need that isn't in the manifest. */
export interface ValidationContext {
  /** Callable sub-flows by workflow ID, with their input and output schemas. */
  subflows?: Record<string, { name: string; input: JSONSchema; output: JSONSchema }>;
  /**
   * The tenant's configured secret names. When given, a `secret()` field naming any other secret
   * gets a `secret.unknown` warning (it would fail at runtime).
   */
  secrets?: readonly string[];
  /**
   * The engine's outbound network policy (its `createEngine({ http })` options), for the
   * `outboundUrl` warning. Unset means the engine's defaults: private and loopback addresses are
   * blocked and every public host is allowed.
   */
  network?: { allowPrivateNetworks?: boolean; allowHosts?: readonly string[] };
}

/** One value a step can reference, as offered by the editor's data picker. */
export interface ScopeEntry {
  /** Reference prefix: `"trigger"`, `"steps.<id>"` or `"loop"`. */
  refBase: string;
  /** What produced the value. */
  kind: "trigger" | "step" | "loop";
  /** For `step` entries the referenced step; for `loop` entries the enclosing loop step. */
  stepId?: string;
  /** Display label: the step's name override, else the node/trigger name. */
  label: string;
  /** Icon name of the node/trigger (see `NodeManifest.icon`). */
  icon?: string;
  /** Schema of the value at `refBase`. `{}` means any. */
  schema: JSONSchema;
  /** Set when the step (or an enclosing block) is disabled: its output will be undefined at runtime. */
  disabled?: boolean;
}

/** @internal Node and trigger manifests keyed by type. */
export interface ManifestIndex {
  nodes: Map<string, NodeManifest>;
  triggers: Map<string, TriggerManifest>;
}

const indexCache = new WeakMap<Manifest, ManifestIndex>();

/** @internal Indexes a manifest by type (cached per manifest object). */
export function indexManifest(manifest: Manifest): ManifestIndex {
  let idx = indexCache.get(manifest);
  if (!idx) {
    idx = {
      nodes: new Map(manifest.nodes.map((n) => [n.type, n])),
      triggers: new Map(manifest.triggers.map((t) => [t.type, t])),
    };
    indexCache.set(manifest, idx);
  }
  return idx;
}

/** @internal Outcome of resolving a parsed reference against visible scope entries. */
export type RefResolution =
  | { ok: true; schema: JSONSchema; entry?: ScopeEntry }
  | { ok: false; reason: "notVisible" | "missingPath"; entry?: ScopeEntry };

/** @internal Finds the entry `path` points into (nearest match wins) and the schema at its path. */
export function resolveRefSchema(path: RefPath, visible: readonly ScopeEntry[]): RefResolution {
  if (path.root === "run") return { ok: true, schema: { type: "string" } };
  const base = path.root === "steps" ? `steps.${path.stepId}` : path.root;
  let entry: ScopeEntry | undefined;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i]?.refBase === base) {
      entry = visible[i];
      break;
    }
  }
  if (!entry) return { ok: false, reason: "notVisible" };
  const schema = schemaAtPath(entry.schema, path.segments);
  if (schema === undefined) return { ok: false, reason: "missingPath", entry };
  return { ok: true, schema, entry };
}

/** @internal Per-step callback of {@link walkScope}; return `true` to stop the walk. */
export type ScopeVisitor = (
  step: Step,
  visible: readonly ScopeEntry[],
  info: { disabled: boolean; ancestors: readonly Step[] },
) => boolean | undefined;

/** @internal The `trigger` scope entry of a doc. */
export function triggerEntry(doc: WorkflowDoc, idx: ManifestIndex): ScopeEntry {
  const t = idx.triggers.get(doc.trigger.type);
  return {
    refBase: "trigger",
    kind: "trigger",
    label: t?.name ?? "Trigger",
    ...(t?.icon !== undefined ? { icon: t.icon } : {}),
    // Declarations hidden by showIf don't exist at run time, so they aren't in scope either.
    schema: t
      ? payloadSchemaFor(t, {
          ...doc.trigger,
          config: dropHiddenFields(doc.trigger.config, t.config) as typeof doc.trigger.config,
        })
      : {},
  };
}

function stepEntry(
  step: Step,
  m: NodeManifest | undefined,
  disabled: boolean,
  ctx: ValidationContext,
): ScopeEntry {
  return {
    refBase: `steps.${step.id}`,
    kind: "step",
    stepId: step.id,
    label: step.name ?? m?.name ?? step.type,
    ...(m?.icon !== undefined ? { icon: m.icon } : {}),
    schema: m ? outputSchemaFor(m, step, ctx) : {},
    ...(disabled ? { disabled: true } : {}),
  };
}

/** Element schema of the array a loop iterates, resolved in the loop step's own scope. */
function loopItemSchema(
  step: Step,
  itemsField: string,
  visible: readonly ScopeEntry[],
): JSONSchema {
  const items = step.config[itemsField];
  if (!isRef(items)) return {};
  let path: RefPath;
  try {
    path = parseRefPath(items.$ref);
  } catch {
    return {};
  }
  const res = resolveRefSchema(path, visible);
  if (!res.ok) return {};
  const types = schemaTypes(res.schema);
  if (types && !types.includes("array")) return {};
  const element = schemaAtPath(res.schema, [0]);
  return element ?? {};
}

function loopEntry(
  step: Step,
  m: NodeManifest,
  itemsField: string,
  visible: readonly ScopeEntry[],
): ScopeEntry {
  return {
    refBase: "loop",
    kind: "loop",
    stepId: step.id,
    label: step.name ?? m.name,
    ...(m.icon !== undefined ? { icon: m.icon } : {}),
    schema: {
      type: "object",
      properties: { item: loopItemSchema(step, itemsField, visible), index: { type: "number" } },
    },
  };
}

/**
 * @internal Walks every step in pre-order, calling `visit` with the scope visible to it (spec
 * §4.4), and returns the scope at the end of the top-level step list. Shared by
 * {@link availableScope} and the validator so both apply the same rule.
 */
export function walkScope(
  doc: WorkflowDoc,
  manifest: Manifest,
  ctx: ValidationContext = {},
  visit?: ScopeVisitor,
): ScopeEntry[] {
  const idx = indexManifest(manifest);
  let stopped = false;

  function walkList(
    steps: Step[],
    visible: ScopeEntry[],
    inheritedDisabled: boolean,
    ancestors: Step[],
  ): ScopeEntry[] {
    let cur = visible;
    for (const step of steps) {
      if (stopped) return cur;
      const disabled = inheritedDisabled || step.disabled === true;
      if (visit?.(step, cur, { disabled, ancestors }) === true) {
        stopped = true;
        return cur;
      }
      const m = idx.nodes.get(step.type);
      const self = stepEntry(step, m, disabled, ctx);
      if (step.branches) {
        const inner = [...ancestors, step];
        for (const [key, list] of Object.entries(step.branches)) {
          const spec = m?.branches;
          // A loop's output exists only once the loop finishes; its body sees `loop.*` instead
          // (replacing any outer loop's entry). Other blocks' output is produced before branching.
          const branchScope =
            spec?.kind === "loop" && key === spec.branch && m
              ? [...cur.filter((e) => e.kind !== "loop"), loopEntry(step, m, spec.itemsField, cur)]
              : [...cur, self];
          walkList(list, branchScope, disabled, inner);
          if (stopped) return cur;
        }
      }
      cur = [...cur, self];
    }
    return cur;
  }

  return walkList(doc.steps, [triggerEntry(doc, idx)], false, []);
}

/**
 * The values a step may reference, in document order. Scope rule (spec §4.4): the trigger, every
 * earlier sibling in the step's own list and — recursively — every earlier sibling of each
 * enclosing block, plus the enclosing block itself (for a loop, as `loop` with `item` typed from
 * the element schema of its `items` ref and `index: number`; for other blocks, the block's
 * output). Steps inside a branch are not visible after the block rejoins.
 *
 * @param stepId The step whose scope to compute, or `null` for the scope at the end of the doc
 *   (the trigger and all top-level steps), used for a sub-flow's `output` mapping. An unknown
 *   step ID yields just the trigger.
 */
export function availableScope(
  doc: WorkflowDoc,
  stepId: string | null,
  manifest: Manifest,
  ctx: ValidationContext = {},
): ScopeEntry[] {
  if (stepId === null) return walkScope(doc, manifest, ctx);
  let result: ScopeEntry[] | undefined;
  const end = walkScope(doc, manifest, ctx, (step, visible) => {
    if (step.id !== stepId) return undefined;
    result = [...visible];
    return true;
  });
  return result ?? end.slice(0, 1);
}

/** A declared `object` or `array` output field: its shape isn't known from the declaration. */
function isOpaqueDecl(s: JSONSchema): boolean {
  if (s.type === "object") return s.properties === undefined;
  if (s.type === "array") return s.items === undefined;
  return false;
}

/**
 * The output schema a sub-flow's callers see: its declared output fields (as
 * `subflowOutputSchema`, declarations hidden by `showIf` dropped), with each declared `object` or
 * `array` field that its `output` mapping fills with one reference refined to the schema of that
 * reference, so `contact` shows its `id`, `email`, … in callers' data pickers and references into
 * it are checked. `undefined` for a workflow that isn't a sub-flow.
 *
 * @param ctx Sub-flows this sub-flow calls, for references to their outputs.
 */
export function describeSubflowOutput(
  doc: WorkflowDoc,
  manifest: Manifest,
  ctx: ValidationContext = {},
): JSONSchema | undefined {
  const t = indexManifest(manifest).triggers.get(doc.trigger.type);
  if (!t) return undefined;
  const config = dropHiddenFields(doc.trigger.config, t.config) as typeof doc.trigger.config;
  const declared = subflowOutputSchema(t, { ...doc.trigger, config });
  const props = declared?.properties as Record<string, JSONSchema> | undefined;
  if (!declared || !props || !doc.output) return declared;
  let end: ScopeEntry[] | undefined;
  const refined: Record<string, JSONSchema> = {};
  for (const [key, decl] of Object.entries(props)) {
    refined[key] = decl;
    const value = Object.hasOwn(doc.output, key) ? doc.output[key] : undefined;
    if (!isOpaqueDecl(decl) || !isRef(value)) continue;
    let path: RefPath;
    try {
      path = parseRefPath(value.$ref);
    } catch {
      continue;
    }
    end ??= walkScope(doc, manifest, ctx);
    const res = resolveRefSchema(path, end);
    if (!res.ok || isAnySchema(res.schema) || !isAssignable(res.schema, decl)) continue;
    refined[key] = {
      ...res.schema,
      ...(decl.description !== undefined ? { description: decl.description } : {}),
    };
  }
  return { ...declared, properties: refined };
}
