/**
 * Building new steps from their node manifests: default config, declared branches, and the deep
 * JSON equality the commands use to spot no-op edits. Shared by `apply` and the editor.
 *
 * @module
 */
import { branchesFor } from "./json-schema";
import type { JSONSchema, NodeManifest, Step, ValueExpr } from "./types";

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
