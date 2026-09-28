import { z } from "zod";
import {
  FlowlineDefinitionError,
  type NodeDefinition,
  type PluginDefinition,
  type TriggerDefinition,
} from "./define";
import { showIfOf, showIfProblems } from "./show-if";
import type {
  JSONSchema,
  Manifest,
  NodeManifest,
  OutputSpec,
  PluginManifest,
  TriggerManifest,
} from "./types";
import { UI_META_KEY } from "./ui";
import { assertZod4, CORE_ZOD_VERSION, isZod3Schema, ZOD_ADVICE } from "./zod-check";

/** The set of registered plugins, with type lookups and the serializable manifest. */
export interface Registry {
  /** Registered plugins, in order. */
  plugins: PluginDefinition[];
  /** Look up a node definition by type. */
  // biome-ignore lint/suspicious/noExplicitAny: definitions of any input/output types
  getNode(type: string): NodeDefinition<any, any> | undefined;
  /** Look up a trigger definition by type. */
  // biome-ignore lint/suspicious/noExplicitAny: definitions of any config/payload types
  getTrigger(type: string): TriggerDefinition<any, any> | undefined;
  /**
   * The JSON-serializable manifest of all plugins, nodes and triggers. Computed once and frozen.
   *
   * @throws {@link FlowlineDefinitionError} when a schema can't be converted to JSON Schema, or
   * has an invalid `showIf` (a required conditional field, an unknown sibling, a cycle, or a
   * conditional `secret()` field or webhook signing secret).
   */
  manifest(): Manifest;
}

const PLUGIN_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Create a registry from plugins.
 *
 * @throws {@link FlowlineDefinitionError} on an invalid or duplicate plugin ID, a duplicate node or
 * trigger type (node and trigger types share one namespace), or a type that does not start with
 * `<pluginId>.`.
 */
export function createRegistry(plugins: PluginDefinition[]): Registry {
  // biome-ignore lint/suspicious/noExplicitAny: definitions of any input/output types
  const nodes = new Map<string, { plugin: string; def: NodeDefinition<any, any> }>();
  // biome-ignore lint/suspicious/noExplicitAny: definitions of any config/payload types
  const triggers = new Map<string, { plugin: string; def: TriggerDefinition<any, any> }>();
  const pluginIds = new Set<string>();
  const owner = new Map<string, string>();

  const claim = (kind: "Node" | "Trigger", type: string, pluginId: string) => {
    if (
      typeof type !== "string" ||
      !type.startsWith(`${pluginId}.`) ||
      type.length <= pluginId.length + 1
    ) {
      throw new FlowlineDefinitionError(
        `${kind} type "${type}" in plugin "${pluginId}" must start with "${pluginId}."`,
      );
    }
    const existing = owner.get(type);
    if (existing !== undefined) {
      throw new FlowlineDefinitionError(
        `Duplicate type "${type}" (already registered as ${existing})`,
      );
    }
    owner.set(type, kind.toLowerCase());
  };

  for (const plugin of plugins) {
    if (typeof plugin.id !== "string" || !PLUGIN_ID.test(plugin.id)) {
      throw new FlowlineDefinitionError(
        `Invalid plugin id "${plugin.id}": must match ${PLUGIN_ID} (no dots)`,
      );
    }
    if (pluginIds.has(plugin.id)) {
      throw new FlowlineDefinitionError(`Duplicate plugin id "${plugin.id}"`);
    }
    pluginIds.add(plugin.id);
    for (const def of plugin.nodes ?? []) {
      claim("Node", def.type, plugin.id);
      nodes.set(def.type, { plugin: plugin.id, def });
    }
    for (const def of plugin.triggers ?? []) {
      claim("Trigger", def.type, plugin.id);
      triggers.set(def.type, { plugin: plugin.id, def });
    }
  }

  let manifest: Manifest | undefined;
  return {
    plugins: [...plugins],
    getNode: (type) => nodes.get(type)?.def,
    getTrigger: (type) => triggers.get(type)?.def,
    manifest() {
      manifest ??= deepFreeze({
        plugins: plugins.map(pluginManifest),
        nodes: [...nodes.values()].map(({ plugin, def }) => nodeManifest(plugin, def)),
        triggers: [...triggers.values()].map(({ plugin, def }) => triggerManifest(plugin, def)),
      });
      return manifest;
    },
  };
}

function pluginManifest(p: PluginDefinition): PluginManifest {
  return compact({ id: p.id, name: p.name, icon: p.icon, description: p.description });
}

// biome-ignore lint/suspicious/noExplicitAny: definitions of any input/output types
function nodeManifest(plugin: string, def: NodeDefinition<any, any>): NodeManifest {
  // No declared output ⇒ `{}` (any JSON). Never substitute `z.object({})`: it would strip keys.
  const output: OutputSpec = def.dynamicOutput
    ? structuredClone(def.dynamicOutput)
    : {
        kind: "schema",
        schema: def.output ? toSchema(def.output, "output", def.type, "output") : {},
      };
  return compact({
    type: def.type,
    plugin,
    name: def.name,
    description: def.description,
    icon: def.icon,
    category: def.category,
    keywords: def.keywords ? [...def.keywords] : undefined,
    endsRun: def.endsRun ? true : undefined,
    summary: def.summary,
    input: toSchema(def.input, "input", def.type, "input"),
    output,
    branches: def.branches ? structuredClone(def.branches) : { kind: "none" },
    resume: def.resume
      ? compact({
          body: def.resume.body
            ? toSchema(def.resume.body, "input", def.type, "resume body")
            : undefined,
          hostHandled: def.resume.hostHandled,
          hint: def.resume.hint,
        })
      : undefined,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: definitions of any config/payload types
function triggerManifest(plugin: string, def: TriggerDefinition<any, any>): TriggerManifest {
  // No declared payload ⇒ `{}` (any JSON). Never substitute `z.object({})`: it would strip keys.
  const payload: OutputSpec = def.dynamicPayload
    ? structuredClone(def.dynamicPayload)
    : {
        kind: "schema",
        schema: def.payload ? toSchema(def.payload, "output", def.type, "payload") : {},
      };
  const config = toSchema(def.config, "input", def.type, "config");
  // The engine verifies webhook signatures with config `secret`; hiding it would skip the check.
  const props = config.properties as Record<string, unknown> | undefined;
  if (def.kind === "webhook" && props?.secret !== undefined && showIfOf(props.secret, config)) {
    throw new FlowlineDefinitionError(
      `Invalid showIf in config schema of "${def.type}": "secret" is the webhook signing secret and can't have showIf`,
    );
  }
  return compact({
    type: def.type,
    plugin,
    name: def.name,
    description: def.description,
    icon: def.icon,
    kind: def.kind,
    event: def.event,
    events: def.events ? [...def.events] : undefined,
    config,
    payload,
  });
}

function toSchema(
  schema: z.ZodType,
  io: "input" | "output",
  type: string,
  what: string,
): JSONSchema {
  assertZod4Tree(schema, type, what);
  let json: JSONSchema;
  const visited = new Set<unknown>();
  const blank = new Set<unknown>();
  try {
    json = z.toJSONSchema(schema, {
      io,
      unrepresentable: "any",
      override: (ctx) => {
        visited.add(ctx.zodSchema);
        if (isBlankForeign(ctx.zodSchema, ctx.jsonSchema)) blank.add(ctx.zodSchema);
      },
    }) as JSONSchema;
  } catch (cause) {
    throw new FlowlineDefinitionError(
      `Cannot convert ${what} schema of "${type}" to JSON Schema: ${(cause as Error).message}`,
      { cause },
    );
  }
  assertReadableMeta(schema, visited, blank, type, what);
  hoistUiMeta(json);
  if (io === "input") {
    const problems = showIfProblems(json);
    if (problems.length > 0) {
      throw new FlowlineDefinitionError(
        `Invalid showIf in ${what} schema of "${type}": ${problems.join("; ")}`,
      );
    }
  }
  return json;
}

/** Zod's version as `major.minor.patch`. */
const versionOf = (v: { major: number; minor: number; patch: number } | undefined) =>
  v ? `${v.major}.${v.minor}.${v.patch}` : "unknown";

interface ZodLike {
  _zod: { def: Record<string, unknown>; version?: { major: number; minor: number; patch: number } };
  meta?: () => Record<string, unknown> | undefined;
}
const isZodLike = (v: unknown): v is ZodLike =>
  typeof v === "object" && v !== null && typeof (v as ZodLike)._zod?.def === "object";

/** Zod types that always convert to a JSON Schema `type`. */
const TYPED = new Set(["string", "number", "boolean", "object", "array", "int", "bigint"]);

/**
 * A schema from a different zod copy that the converter turned into nothing (no `type`), which
 * happens when that copy's internals differ from core's.
 */
function isBlankForeign(s: unknown, json: Record<string, unknown>): boolean {
  if (!isZodLike(s) || versionOf(s._zod.version) === CORE_ZOD_VERSION) return false;
  const kind = s._zod.def.type;
  const shaped = ["type", "$ref", "anyOf", "oneOf", "allOf", "const", "enum"].some(
    (k) => json[k] !== undefined,
  );
  return typeof kind === "string" && TYPED.has(kind) && !shaped;
}

/**
 * The schemas nested in `s` (object shapes, wrappers, unions, arrays, records, tuples, pipes,
 * lazies), whichever zod copy built them, with the property path to each.
 */
function nestedSchemas(
  s: ZodLike,
  path: string,
  onForeign?: (v: unknown, path: string) => void,
): [ZodLike, string][] {
  const out: [ZodLike, string][] = [];
  const add = (v: unknown, p: string) => {
    if (isZodLike(v)) out.push([v, p]);
    else if (isZod3Schema(v)) onForeign?.(v, p);
  };
  for (const [key, value] of Object.entries(s._zod.def)) {
    if (key === "checks") continue;
    if (key === "getter" && typeof value === "function") {
      try {
        add((value as () => unknown)(), path);
      } catch {
        // A lazy schema that can't be built yet has nothing to check.
      }
    } else if (key === "shape" && typeof value === "object" && value !== null) {
      for (const [prop, child] of Object.entries(value))
        add(child, path ? `${path}.${prop}` : prop);
    } else if (Array.isArray(value)) {
      for (const child of value) add(child, path);
    } else {
      add(value, key === "element" || key === "valueType" ? `${path}[]` : path);
    }
  }
  return out;
}

/** `'field "a.b" of the input schema of "x.y"'`, or without the field part at the root. */
const subjectOf = (path: string, what: string, type: string) =>
  `${path ? `Field "${path}" of the ` : "The "}${what} schema of "${type}"`;

/**
 * Throws a clear {@link FlowlineDefinitionError} when `root`, or any schema nested in it, is a
 * zod 3 schema (or not a zod schema at all) instead of letting the converter crash on it.
 */
function assertZod4Tree(root: unknown, type: string, what: string): void {
  assertZod4(root, subjectOf("", what, type));
  const seen = new Set<unknown>();
  const queue: [ZodLike, string][] = [[root as ZodLike, ""]];
  for (let i = 0; i < queue.length; i++) {
    const [s, path] = queue[i] as [ZodLike, string];
    if (seen.has(s)) continue;
    seen.add(s);
    queue.push(...nestedSchemas(s, path, (v, p) => assertZod4(v, subjectOf(p, what, type))));
  }
}

/**
 * Throws when `root` holds a schema built by a different copy of zod whose flowline metadata
 * (`ui()`, `secret()`, `sensitive()`) the converter can't see, e.g. a `link:`ed package with its
 * own zod next to the host's older one. Without this, a secret field would silently lose its
 * literal-only and masking guarantees.
 */
function assertReadableMeta(
  root: z.ZodType,
  visited: ReadonlySet<unknown>,
  blank: ReadonlySet<unknown>,
  type: string,
  what: string,
): void {
  const seen = new Set<unknown>();
  // Breadth-first, so the first field in declaration order is the one reported.
  const queue: [ZodLike, string][] = [[root as unknown as ZodLike, ""]];
  for (let i = 0; i < queue.length; i++) {
    const [s, path] = queue[i] as [ZodLike, string];
    if (seen.has(s)) continue;
    seen.add(s);
    let own: Record<string, unknown> | undefined;
    try {
      own = typeof s.meta === "function" ? s.meta() : undefined;
    } catch {
      own = undefined;
    }
    const version = versionOf(s._zod.version);
    const readable = z.globalRegistry.get(s as unknown as z.ZodType)?.[UI_META_KEY] !== undefined;
    // A different copy's schema must also have been reached by the converter to be emitted.
    const emitted = version === CORE_ZOD_VERSION || visited.has(s);
    if (blank.has(s) || (own?.[UI_META_KEY] !== undefined && (!readable || !emitted))) {
      const field = path ? `field "${path}" of the ` : "";
      throw new FlowlineDefinitionError(
        `The ${field}${what} schema of "${type}" was built with a different copy of zod (${version}) than the one @flowlinejs/core uses (${CORE_ZOD_VERSION}), so flowline can't read it or its metadata (ui(), secret(), sensitive()), and its secret/sensitive guarantees would be lost. ${ZOD_ADVICE}`,
      );
    }
    queue.push(...nestedSchemas(s, path));
  }
}

/**
 * Zod places metadata of a `.nullable()`-wrapped schema on the non-null `anyOf` member. Move it up
 * to the property schema so the editor finds `"x-flowline"` in one place. Genuine unions are left
 * alone: their members' metadata describes each variant.
 */
function hoistUiMeta(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) hoistUiMeta(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const schema = node as JSONSchema;
  for (const value of Object.values(schema)) hoistUiMeta(value);
  const members = schema.anyOf;
  if (!Array.isArray(members) || members.length !== 2) return;
  const inner = (members as JSONSchema[]).find((m) => m?.type !== "null");
  const isNullable = (members as JSONSchema[]).some((m) => m?.type === "null");
  const meta = inner?.[UI_META_KEY];
  if (!isNullable || !inner || !meta || typeof meta !== "object") return;
  delete inner[UI_META_KEY];
  schema[UI_META_KEY] = { ...meta, ...(schema[UI_META_KEY] as object | undefined) };
}

function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
