import { z } from "zod";
import type { BranchSpec, OutputSpec, TriggerKind } from "./types";

/** Thrown when a node, trigger, plugin or registry definition is invalid. */
export class FlowkitDefinitionError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name = "FlowkitDefinitionError";
}

/**
 * Services injected by the host at engine creation and exposed as `ctx.services`.
 * Augment it to type your services:
 *
 * @example
 * ```ts
 * declare module "@flowkit/core" {
 *   interface FlowkitServices { db: Db }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by hosts via declaration merging
export interface FlowkitServices {}

/** Why a suspended handler is being re-invoked (see `ctx.resume`). */
export type ResumeInfo =
  /** The `suspend({ until })` time was reached. */
  | { kind: "timer" }
  /** The callback URL was called; `body` is the request body. */
  | { kind: "callback"; body: unknown }
  /** The callback expired before being called. */
  | { kind: "timeout" }
  /** The invoked sub-flow completed with `output`. */
  | { kind: "subflow"; output: unknown }
  /** The invoked sub-flow failed. */
  | { kind: "subflowFailed"; error: { message: string } };

/** A one-shot URL that resumes a suspended step, created with `ctx.callback()`. */
export interface CallbackHandle {
  /** Opaque token identifying the waiting step. */
  token: string;
  /** Absolute URL an external system calls to resume the step. */
  resumeUrl: string;
  /** Epoch ms after which the callback times out. */
  expiresAt: number;
}

/** Structured logger available to handlers as `ctx.logger`; entries are attached to the run. */
export interface Logger {
  /** Log at debug level. */
  debug(message: string, data?: unknown): void;
  /** Log at info level. */
  info(message: string, data?: unknown): void;
  /** Log at warn level. */
  warn(message: string, data?: unknown): void;
  /** Log at error level. */
  error(message: string, data?: unknown): void;
}

/** Sandboxed JavaScript evaluation available to handlers as `ctx.transform`. */
export interface TransformRuntime {
  /** Evaluate `code` with `scope` in a sandbox, within the given time and memory limits. */
  run(
    code: string,
    scope: unknown,
    opts: { timeoutMs: number; memoryBytes: number },
  ): Promise<unknown>;
}

/** Everything a node handler can use besides its input. */
export interface NodeContext {
  /** ID of the current run. */
  runId: string;
  /** Tenant the run belongs to. */
  tenantId: string;
  /** ID of the workflow being run. */
  workflowId: string;
  /** ID of the step being executed. */
  stepId: string;
  /** Position of the step in the tree, including loop iterations. */
  stepPath: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Stable across retries of the same step execution; pass it to external APIs. */
  idempotencyKey: string;
  /** Host services (see {@link FlowkitServices}). */
  services: FlowkitServices;
  /** Run-scoped logger. */
  logger: Logger;
  /** Aborted when the step times out or the run is cancelled. */
  signal: AbortSignal;
  /** Current time in epoch ms, from the engine's injectable clock. */
  now(): number;
  /** Set when a previously suspended handler is re-invoked. */
  resume?: ResumeInfo;
  /** Host-provided secrets. `get` throws a `FatalError` when the secret is not configured. */
  secrets: { get(name: string): Promise<string> };
  /** Create a callback URL; return `suspend({ callback })` to wait for it. */
  callback(opts: { timeoutMs: number }): Promise<CallbackHandle>;
  /** Sandboxed code evaluation. */
  transform: TransformRuntime;
  /** Resolved values visible to this step. */
  scope: Readonly<{
    trigger: unknown;
    steps: Record<string, unknown>;
    loop?: { item: unknown; index: number };
  }>;
  /** SSRF-guarded fetch. */
  http: { fetch(url: string, init?: RequestInit): Promise<Response> };
}

/**
 * Tag key present on every signal object. Created with `Symbol.for` so signals from a duplicated
 * copy of `@flowkit/core` are still recognised.
 */
export const FLOWKIT_SIGNAL: unique symbol = Symbol.for("flowkit.signal") as never;

/** Returned by a branching handler to choose the branch to run next. */
export interface BranchSignal<O = unknown> {
  /** Signal tag. */
  readonly [FLOWKIT_SIGNAL]: true;
  /** Signal kind. */
  readonly kind: "branch";
  /** ID of the branch to take. */
  readonly branch: string;
  /** The step's output. */
  readonly output: O;
}

/** Returned by a handler to pause the run until a time or a callback. */
export type SuspendSignal = {
  /** Signal tag. */
  readonly [FLOWKIT_SIGNAL]: true;
  /** Signal kind. */
  readonly kind: "suspend";
} & (
  | {
      /** Resume at this epoch ms time. */
      readonly until: number;
    }
  | {
      /** Resume when this callback is called (or times out). */
      readonly callback: CallbackHandle;
    }
);

/** Returned by a handler to end the run successfully without running further steps. */
export interface StopSignal {
  /** Signal tag. */
  readonly [FLOWKIT_SIGNAL]: true;
  /** Signal kind. */
  readonly kind: "stop";
  /** Why the run stopped, recorded in the audit trail. */
  readonly reason?: string;
}

/** Returned by a handler to run another workflow as a sub-flow and wait for its result. */
export interface SubflowSignal {
  /** Signal tag. */
  readonly [FLOWKIT_SIGNAL]: true;
  /** Signal kind. */
  readonly kind: "subflow";
  /** Workflow to run. */
  readonly workflowId: string;
  /** Trigger payload for the sub-flow. */
  readonly input: unknown;
}

/** Any control-flow signal a handler can return instead of plain output. */
export type Signal = BranchSignal<unknown> | SuspendSignal | StopSignal | SubflowSignal;

/** Choose branch `id`, producing `output` as the step's output. */
export function branch<O = undefined>(id: string, output?: O): BranchSignal<O> {
  return { [FLOWKIT_SIGNAL]: true, kind: "branch", branch: id, output: output as O };
}

/**
 * Pause the run. The handler is re-invoked with `ctx.resume` set once the time is reached or the
 * callback is called.
 */
export function suspend(opts: { until: number } | { callback: CallbackHandle }): SuspendSignal {
  return "until" in opts
    ? { [FLOWKIT_SIGNAL]: true, kind: "suspend", until: opts.until }
    : { [FLOWKIT_SIGNAL]: true, kind: "suspend", callback: opts.callback };
}

/** End the run successfully, skipping all remaining steps. */
export function stop(reason?: string): StopSignal {
  return reason === undefined
    ? { [FLOWKIT_SIGNAL]: true, kind: "stop" }
    : { [FLOWKIT_SIGNAL]: true, kind: "stop", reason };
}

/**
 * Run workflow `workflowId` as a sub-flow with `input` as its trigger payload. The handler is
 * re-invoked with `ctx.resume` of kind `subflow` or `subflowFailed`.
 */
export function invokeSubflow(opts: { workflowId: string; input: unknown }): SubflowSignal {
  return {
    [FLOWKIT_SIGNAL]: true,
    kind: "subflow",
    workflowId: opts.workflowId,
    input: opts.input,
  };
}

/** Whether `v` is a signal returned by {@link branch}, {@link suspend}, {@link stop} or {@link invokeSubflow}. */
export function isSignal(v: unknown): v is Signal {
  return (
    typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[FLOWKIT_SIGNAL] === true
  );
}

/** Retry behaviour for failed handler attempts. */
export interface RetryPolicy {
  /** Total attempts including the first (`max: 3` → 1 run + 2 retries). */
  max: number;
  /** Delay growth between attempts. */
  backoff: "fixed" | "exponential";
  /** Delay before the first retry, in ms. */
  initialMs: number;
}

/** What a handler may return (or resolve to): its output or a control-flow signal. */
export type NodeResult<O> = O | Signal;

/**
 * A node type: config schema, output shape and handler.
 *
 * @typeParam I - Zod object schema of the step's config (resolved and validated before `run`).
 * @typeParam O - The handler's output type.
 */
export interface NodeDefinition<I extends z.ZodObject = z.ZodObject, O = unknown> {
  /** Globally unique, namespaced by plugin ID, e.g. `"crm.loadContact"`. */
  type: string;
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
  /** Config schema. Use {@link ui} to add editor hints. */
  input: I;
  /** Output schema; the handler's return value is validated against it. Defaults to `z.object({})`. */
  output?: z.ZodType<O>;
  /** Output shape derived from config instead of a static schema. Mutually exclusive with `output`. */
  dynamicOutput?: Exclude<OutputSpec, { kind: "schema" }>;
  /** How the node branches. Defaults to `{ kind: "none" }`. */
  branches?: BranchSpec;
  /** Retry policy overrides. */
  retry?: Partial<RetryPolicy>;
  /** Handler wall-clock limit in ms, enforced via `ctx.signal`. Default `300_000`. */
  timeoutMs?: number;
  /** The handler. Receives validated input; returns output or a signal. */
  run(args: { input: z.infer<I>; ctx: NodeContext }): Promise<NodeResult<O>> | NodeResult<O>;
}

const NAMESPACED_TYPE = /^[^.]+\.[^.].*$/;

function assertNamespaced(kind: string, type: string): void {
  if (typeof type !== "string" || !NAMESPACED_TYPE.test(type)) {
    throw new FlowkitDefinitionError(
      `${kind} type "${type}" must be namespaced as "<pluginId>.<name>"`,
    );
  }
}

/**
 * Define a node type. Input types flow from `input` into `run`; when `output` is given, `run`'s
 * return value is checked against it.
 *
 * @throws {@link FlowkitDefinitionError} if `type` has no namespace or both `output` and
 * `dynamicOutput` are given.
 *
 * @example
 * ```ts
 * export const loadContact = defineNode({
 *   type: "crm.loadContact",
 *   name: "Load contact",
 *   summary: "Load {{contactId}}",
 *   input: z.object({ contactId: ui(z.string(), { label: "Contact" }) }),
 *   output: ContactSchema,
 *   run: ({ input, ctx }) => ctx.services.db.contacts.get(input.contactId),
 * });
 * ```
 */
export function defineNode<I extends z.ZodObject, O = unknown>(
  def: Omit<NodeDefinition<I, O>, "run"> & {
    // `NoInfer`: O comes from `output` only, so `run`'s return is checked against it
    // rather than widening O to whatever `run` returns.
    run(args: {
      input: z.infer<I>;
      ctx: NodeContext;
    }): Promise<NodeResult<NoInfer<O>>> | NodeResult<NoInfer<O>>;
  },
): NodeDefinition<I, O> {
  assertNamespaced("Node", def.type);
  if (def.output !== undefined && def.dynamicOutput !== undefined) {
    throw new FlowkitDefinitionError(
      `Node "${def.type}" declares both output and dynamicOutput; use one`,
    );
  }
  if (def.output === undefined && def.dynamicOutput === undefined) {
    return { ...def, output: z.object({}) as unknown as z.ZodType<O> };
  }
  return def;
}

/**
 * A trigger type: config schema, payload shape and optional filtering/deduplication.
 *
 * @typeParam C - Zod object schema of the trigger's config.
 * @typeParam P - The payload type (available as `trigger` in reference scope).
 */
export interface TriggerDefinition<C extends z.ZodObject = z.ZodObject, P = unknown> {
  /** Globally unique, namespaced by plugin ID, e.g. `"crm.dealUpdated"`. */
  type: string;
  /** Display name. */
  name: string;
  /** Longer description. */
  description?: string;
  /** Lucide icon name or URL. */
  icon?: string;
  /** How the trigger fires. */
  kind: TriggerKind;
  /** For `event` triggers: the event name to listen to. */
  event?: string;
  /** Config schema. */
  config: C;
  /** Payload schema. Mutually exclusive with `dynamicPayload`. */
  payload?: z.ZodType<P>;
  /** Payload shape derived from config. */
  dynamicPayload?: { kind: "fields" | "webhook"; configPath: string };
  /** Return `false` to skip starting a run for this payload. */
  filter?(args: { config: z.infer<C>; payload: P }): boolean;
  /** A key identifying duplicate deliveries; at most one run starts per key. */
  dedupeKey?(args: { config: z.infer<C>; payload: P }): string | undefined;
}

/**
 * Define a trigger type.
 *
 * @throws {@link FlowkitDefinitionError} if `type` has no namespace or both `payload` and
 * `dynamicPayload` are given.
 */
export function defineTrigger<C extends z.ZodObject, P>(
  def: TriggerDefinition<C, P>,
): TriggerDefinition<C, P> {
  assertNamespaced("Trigger", def.type);
  if (def.payload !== undefined && def.dynamicPayload !== undefined) {
    throw new FlowkitDefinitionError(
      `Trigger "${def.type}" declares both payload and dynamicPayload; use one`,
    );
  }
  return def;
}

/** A plugin: a named group of node and trigger types sharing the `<id>.` type prefix. */
export interface PluginDefinition {
  /** Plugin ID; every node and trigger type must start with `<id>.`. */
  id: string;
  /** Display name. */
  name: string;
  /** Lucide icon name or URL. */
  icon?: string;
  /** Longer description. */
  description?: string;
  /** Node types provided by the plugin. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous list of node definitions
  nodes?: NodeDefinition<any, any>[];
  /** Trigger types provided by the plugin. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous list of trigger definitions
  triggers?: TriggerDefinition<any, any>[];
}

/** Define a plugin. Validation happens in `createRegistry`. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
