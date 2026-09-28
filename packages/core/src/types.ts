/**
 * A JSON Schema document (draft 2020-12), as produced by `z.toJSONSchema`.
 * Kept deliberately loose: Flowkit only ever reads well-known keys.
 */
export type JSONSchema = { [k: string]: unknown };

/** A JSON literal value that can appear directly in step config. */
export type Literal = string | number | boolean | null;

/**
 * A reference to a value in scope, e.g. `{ $ref: "steps.loadContact.email" }`.
 * Path grammar: `trigger.<path>`, `steps.<stepId>.<path>`, `loop.item.<path>`, `loop.index`, `run.id`.
 */
export type RefExpr = { $ref: string };

/** A string template interpolating `{{ <ref path> }}` segments. Always evaluates to a string. */
export type TplExpr = { $tpl: string };

/** Any value a config field may hold: literals, references, templates, and arrays/objects of them. */
export type ValueExpr = Literal | RefExpr | TplExpr | ValueExpr[] | { [k: string]: ValueExpr };

/** One step of a workflow: an instance of a node type with its config. */
export interface Step {
  /** Stable ID, unique within the doc and used in references. Matches `/^[A-Za-z_][A-Za-z0-9_]*$/` and is not `__proto__`, `constructor`, `prototype` or `__trigger`. */
  id: string;
  /** Node type, e.g. `"crm.loadContact"`. */
  type: string;
  /** User-facing label override. */
  name?: string;
  /** Skipped at runtime and faded in the editor. */
  disabled?: boolean;
  /** Config values keyed by input field name. */
  config: Record<string, ValueExpr>;
  /** Child step lists for branching and looping nodes, keyed by branch ID (forEach uses `"body"`). */
  branches?: Record<string, Step[]>;
}

/** The trigger that starts a workflow, with its config. */
export interface TriggerConfig {
  /** Trigger type, e.g. `"crm.dealUpdated"`. */
  type: string;
  /** Config values keyed by config field name. */
  config: Record<string, ValueExpr>;
}

/** A tree-shaped workflow document: one trigger followed by a list of steps. */
export interface WorkflowDoc {
  /** Workflow ID. Matches `/^[a-z0-9][a-z0-9-_]*$/`. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional longer description. */
  description?: string;
  /** What starts the workflow. */
  trigger: TriggerConfig;
  /** Top-level steps, executed in order. */
  steps: Step[];
  /** For sub-flows: the output mapping evaluated at the end of a run. */
  output?: Record<string, ValueExpr>;
}

/** The value kinds a user-declared field ({@link FieldDecl}) can have. */
export type FieldType = "string" | "number" | "boolean" | "object" | "array" | "date";

/** A user-declared field, e.g. a webhook body field or a "set fields" output. */
export interface FieldDecl {
  /** Field name; becomes a property key in the resulting schema. */
  name: string;
  /** Value kind. `date` is an ISO 8601 date-time string. */
  type: FieldType;
  /** Whether the field must be present. */
  required?: boolean;
  /** Help text shown in the editor. */
  description?: string;
}

/** How a node's outgoing branches are determined. */
export type BranchSpec =
  /** A plain node with no branches. */
  | { kind: "none" }
  /** A fixed set of branches, e.g. `if` / `else`. */
  | { kind: "static"; branches: { id: string; label: string }[] }
  /**
   * Branches read from an array in config (e.g. switch cases), with fixed branches appended
   * (e.g. `default`). `idKey`/`labelKey` name the properties of each array item.
   */
  | {
      kind: "fromConfig";
      configPath: string;
      idKey: string;
      labelKey: string;
      append: { id: string; label: string }[];
    }
  /** A loop over the array at config `itemsField`, whose body is the `"body"` branch. */
  | { kind: "loop"; itemsField: string; branch: "body" };

/** How the shape of a node's output (or a trigger's payload) is determined. */
export type OutputSpec =
  /** A fixed JSON Schema. */
  | { kind: "schema"; schema: JSONSchema }
  /** Output schema built from the {@link FieldDecl} array at `config[configPath]`. */
  | { kind: "fields"; configPath: string }
  /** Output is the declared output of the sub-flow whose ID is at `config[configPath]`. */
  | { kind: "subflow"; configPath: string }
  /** Trigger payload `{ body: <fields at configPath>, headers: Record<string, string> }`. */
  | { kind: "webhook"; configPath: string };

/**
 * Editor hints attached to a field schema with {@link ui}. Carried in JSON Schema under the key
 * `"x-flowkit"` on the property schema.
 */
export interface UiMeta {
  /** Field label; defaults to a humanized property name. */
  label?: string;
  /** Placeholder text for empty inputs. */
  placeholder?: string;
  /** Widget ID overriding the default for the schema type, e.g. `"textarea"` or `"crm.contactSelect"`. */
  widget?: string;
  /** Group heading the field is rendered under. */
  group?: string;
  /** Value is masked in run inspection and audit output. */
  sensitive?: boolean;
  /** Value names a host-provided secret, never a secret value itself. */
  secret?: boolean;
  /** Render string inputs as multi-line. */
  multiline?: boolean;
  /** Not rendered in the config form. */
  hidden?: boolean;
  /** Field only accepts a reference (renders as a single-pill picker). */
  refOnly?: boolean;
  /** Field never accepts references (no ref toggle, no pills). */
  literalOnly?: boolean;
  /**
   * On an object schema (e.g. a node's whole input): exactly one of these groups of property
   * names must be set, e.g. `[["duration"], ["until"]]`. A group is set when all its properties
   * are non-empty. The validator reports `config.required` when none or several are set.
   */
  oneOfRequired?: string[][];
  /**
   * On an array field: the validator warns with this message (`config.empty`) when the field is a
   * literal empty list.
   */
  warnIfEmpty?: string;
}

/** Serializable description of a node type, as consumed by the editor and validator. */
export interface NodeManifest {
  /** Node type, e.g. `"crm.loadContact"`. */
  type: string;
  /** ID of the plugin that provides it. */
  plugin: string;
  /** Display name. */
  name: string;
  /** Longer description. */
  description?: string;
  /** Lucide icon name or URL. */
  icon?: string;
  /** Step picker category. */
  category?: string;
  /** Template rendered against config for the step card, e.g. `"Load {{contactId}}"`. */
  summary?: string;
  /** Input-side JSON Schema of the node's config. */
  input: JSONSchema;
  /** Shape of the node's output. */
  output: OutputSpec;
  /** How the node branches. */
  branches: BranchSpec;
  /** How a wait of this node is resumed (see {@link ResumeSpec}). */
  resume?: ResumeSpec;
}

/**
 * How a node that waits on a callback (`suspend({ callback })`) is resumed, in the manifest. Tells
 * the run viewer what body to ask for, or to send people to the host app instead.
 */
export interface ResumeSpec {
  /** Input-side JSON Schema of the callback body the handler expects on resume. */
  body?: JSONSchema;
  /**
   * The wait is decided in the host app (an approvals page, a signed endpoint), not by posting a
   * raw body: the run viewer shows {@link ResumeSpec.hint} instead of its resume form, and the
   * generic `POST /runs/:id/resume` route refuses it (409 `resume_host_handled`). The public
   * token route still resumes it, since a callback token is a bearer capability: never expose the
   * token or resume URL of such a step.
   */
  hostHandled?: boolean;
  /** Where or how to resume, shown in the run viewer, e.g. "Approve or reject it in Approvals." */
  hint?: string;
}

/**
 * How a trigger fires.
 *
 * `subflow` triggers make a workflow callable with `core.callSubflow`. Contract for plugin
 * sub-flow triggers: the payload is the caller's input, and the declared output is the
 * {@link FieldDecl} list at config path `"output"` (as in `core.subflow`). When a sub-flow run
 * finishes, the engine checks its output mapping against those fields and fails the run (and the
 * calling step) on a mismatch.
 */
export type TriggerKind = "event" | "webhook" | "manual" | "schedule" | "subflow";

/** Serializable description of a trigger type. */
export interface TriggerManifest {
  /** Trigger type, e.g. `"crm.dealUpdated"`. */
  type: string;
  /** ID of the plugin that provides it. */
  plugin: string;
  /** Display name. */
  name: string;
  /** Longer description. */
  description?: string;
  /** Lucide icon name or URL. */
  icon?: string;
  /** How the trigger fires. */
  kind: TriggerKind;
  /** For `event` triggers: the event name it listens to. */
  event?: string;
  /** Input-side JSON Schema of the trigger's config. */
  config: JSONSchema;
  /** Shape of the payload, available as `trigger` in reference scope. */
  payload: OutputSpec;
}

/** Serializable description of a plugin. */
export interface PluginManifest {
  /** Plugin ID; prefix of every type it provides. */
  id: string;
  /** Display name. */
  name: string;
  /** Lucide icon name or URL. */
  icon?: string;
  /** Longer description. */
  description?: string;
}

/**
 * Everything the editor and validator know about the available plugins, nodes and triggers.
 * Plain JSON, safe to send to the browser.
 */
export interface Manifest {
  /** Registered plugins, in registration order. */
  plugins: PluginManifest[];
  /** All node types, in registration order. */
  nodes: NodeManifest[];
  /** All trigger types, in registration order. */
  triggers: TriggerManifest[];
}
