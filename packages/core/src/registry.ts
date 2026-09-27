import { z } from "zod";
import {
  FlowkitDefinitionError,
  type NodeDefinition,
  type PluginDefinition,
  type TriggerDefinition,
} from "./define";
import type {
  JSONSchema,
  Manifest,
  NodeManifest,
  OutputSpec,
  PluginManifest,
  TriggerManifest,
} from "./types";
import { UI_META_KEY } from "./ui";

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
  /** The JSON-serializable manifest of all plugins, nodes and triggers. Computed once and frozen. */
  manifest(): Manifest;
}

const PLUGIN_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Create a registry from plugins.
 *
 * @throws {@link FlowkitDefinitionError} on an invalid or duplicate plugin ID, a duplicate node or
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
      throw new FlowkitDefinitionError(
        `${kind} type "${type}" in plugin "${pluginId}" must start with "${pluginId}."`,
      );
    }
    const existing = owner.get(type);
    if (existing !== undefined) {
      throw new FlowkitDefinitionError(
        `Duplicate type "${type}" (already registered as ${existing})`,
      );
    }
    owner.set(type, kind.toLowerCase());
  };

  for (const plugin of plugins) {
    if (typeof plugin.id !== "string" || !PLUGIN_ID.test(plugin.id)) {
      throw new FlowkitDefinitionError(
        `Invalid plugin id "${plugin.id}": must match ${PLUGIN_ID} (no dots)`,
      );
    }
    if (pluginIds.has(plugin.id)) {
      throw new FlowkitDefinitionError(`Duplicate plugin id "${plugin.id}"`);
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
    summary: def.summary,
    input: toSchema(def.input, "input", def.type, "input"),
    output,
    branches: def.branches ? structuredClone(def.branches) : { kind: "none" },
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
  return compact({
    type: def.type,
    plugin,
    name: def.name,
    description: def.description,
    icon: def.icon,
    kind: def.kind,
    event: def.event,
    config: toSchema(def.config, "input", def.type, "config"),
    payload,
  });
}

function toSchema(
  schema: z.ZodType,
  io: "input" | "output",
  type: string,
  what: string,
): JSONSchema {
  let json: JSONSchema;
  try {
    json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JSONSchema;
  } catch (cause) {
    throw new FlowkitDefinitionError(
      `Cannot convert ${what} schema of "${type}" to JSON Schema: ${(cause as Error).message}`,
      { cause },
    );
  }
  hoistUiMeta(json);
  return json;
}

/**
 * Zod places metadata of a `.nullable()`-wrapped schema on the non-null `anyOf` member. Move it up
 * to the property schema so the editor finds `"x-flowkit"` in one place. Genuine unions are left
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
