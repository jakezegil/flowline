/**
 * Building new steps from their node manifests: default config, declared branches, and the deep
 * JSON equality the commands use to spot no-op edits. Shared by `apply` and the editor.
 *
 * @module
 */
import { branchesFor } from "./json-schema";
import { FlowlineTreeError, findStep, updateStep } from "./tree";
import type { JSONSchema, NodeManifest, Step, ValueExpr, WorkflowDoc } from "./types";

/**
 * Initial config for a new step or trigger: the `default` of each top-level property of the
 * config's JSON Schema (cloned, so steps never share default objects).
 *
 * @example
 * defaultConfig({ type: "object", properties: { retries: { type: "number", default: 3 } } })
 * // { retries: 3 }
 */
export function defaultConfig(schema: JSONSchema): Record<string, ValueExpr> {
  const config: Record<string, ValueExpr> = {};
  const props = schema.properties;
  if (props === null || typeof props !== "object") return config;
  for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
    if (prop !== null && typeof prop === "object" && "default" in prop) {
      const value = (prop as { default: unknown }).default;
      if (value !== undefined) config[key] = structuredClone(value) as ValueExpr;
    }
  }
  return config;
}

/**
 * Makes `step.branches` match what its node declares: every declared branch exists (empty if
 * new), and undeclared branches are dropped only when empty, so no step is ever lost (the
 * validator reports leftovers). Returns `step` itself when nothing changes.
 */
export function syncBranches(step: Step, m: NodeManifest): Step {
  const declared = branchesFor(m, step).map((b) => b.id);
  const current = step.branches ?? {};
  // A Map, so branch IDs such as `constructor` or `__proto__` are plain keys.
  const next = new Map<string, Step[]>();
  for (const id of declared) next.set(id, (Object.hasOwn(current, id) && current[id]) || []);
  for (const [id, list] of Object.entries(current)) {
    if (!next.has(id) && list.length > 0) next.set(id, list);
  }
  const same =
    next.size === Object.keys(current).length &&
    [...next].every(([id, list]) => Object.hasOwn(current, id) && current[id] === list);
  if (same) return step;
  if (next.size === 0) {
    const { branches: _, ...rest } = step;
    return rest;
  }
  return { ...step, branches: Object.fromEntries(next) };
}

/** A new step of node type `m` with default config and an empty list per declared branch. */
export function createStep(id: string, m: NodeManifest): Step {
  return syncBranches({ id, type: m.type, config: defaultConfig(m.input) }, m);
}

/**
 * Whether two JSON values are structurally equal (by their JSON text, so key order counts).
 *
 * @example
 * jsonEqual({ a: [1] }, { a: [1] }) // true
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The doc with step `id` switched to node `m`: its ID stays (so references stay attached), config
 * resets to `m`'s defaults and the name override is dropped. `disabled` and the step's
 * annotations (`note`, `color`) are kept, and so are its children: branches `m` also declares keep
 * their steps, and non-empty branches `m` doesn't declare stay as undeclared leftovers (the policy
 * of {@link syncBranches}), which the validator flags (`branch.unknown`).
 *
 * @throws {FlowlineTreeError} If `id` doesn't exist.
 *
 * @example
 * replaceStepType(doc, "notify", manifest.nodes.find((n) => n.type === "crm.getDeal")!)
 */
export function replaceStepType(doc: WorkflowDoc, id: string, m: NodeManifest): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowlineTreeError(`Step "${id}" not found`);
  const old = found.step;
  const replaced = syncBranches(
    {
      id,
      type: m.type,
      config: defaultConfig(m.input),
      ...(old.disabled ? { disabled: true } : {}),
      ...(old.note !== undefined ? { note: old.note } : {}),
      ...(old.color !== undefined ? { color: old.color } : {}),
      ...(old.branches ? { branches: old.branches } : {}),
    },
    m,
  );
  return updateStep(doc, id, () => replaced);
}

/**
 * The display name for a copy of `base`. Strips a trailing " (copy)" or " (copy N)", then returns
 * "<stem> (copy)", or "<stem> (copy 2)", "(copy 3)"… for the first name not in `taken`.
 *
 * @example
 * copyName("Send email", new Set()) // "Send email (copy)"
 * copyName("Send email (copy)", new Set(["Send email (copy)"])) // "Send email (copy 2)"
 */
export function copyName(base: string, taken: ReadonlySet<string>): string {
  const stem = base.replace(/ \(copy(?: \d+)?\)$/, "");
  let name = `${stem} (copy)`;
  for (let n = 2; taken.has(name); n++) name = `${stem} (copy ${n})`;
  return name;
}
