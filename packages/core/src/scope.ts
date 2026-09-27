import { outputSchemaFor, payloadSchemaFor, schemaAtPath, schemaTypes } from "./json-schema";
import { isRef, parseRefPath, type RefPath } from "./refs";
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
  /** Lucide icon name or URL of the node/trigger. */
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

function triggerEntry(doc: WorkflowDoc, idx: ManifestIndex): ScopeEntry {
  const t = idx.triggers.get(doc.trigger.type);
  return {
    refBase: "trigger",
    kind: "trigger",
    label: t?.name ?? "Trigger",
    ...(t?.icon !== undefined ? { icon: t.icon } : {}),
    schema: t ? payloadSchemaFor(t, doc.trigger) : {},
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
