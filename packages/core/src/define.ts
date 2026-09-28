import type { z } from "zod";
import type { BranchSpec, OutputSpec, TriggerKind } from "./types";

/**
 * Thrown when a node, trigger, plugin or registry definition is invalid, or when the code-first
 * `workflow()` builder is misused (invalid or duplicate IDs, missing trigger).
 */
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
  /**
   * Opaque token identifying the waiting step. It is a bearer capability: whoever holds it can
   * resume the wait through the public token route, even when the node declares
   * `resume.hostHandled`. Hand it only to whoever may decide the wait.
   */
  token: string;
  /**
   * Absolute URL an external system calls to resume the step (it contains the token). Never
   * expose it for a step only your app may decide (`resume.hostHandled`).
   */
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
  /**
   * Stable across retries of the same step execution; pass it to external APIs. Execution is
   * at-least-once: after a timeout or a lost worker the step runs again (possibly while the earlier
   * attempt is still running), and this key lets the external system deduplicate.
   */
  idempotencyKey: string;
  /** Host services (see {@link FlowkitServices}). */
  services: FlowkitServices;
  /** Run-scoped logger. */
  logger: Logger;
  /**
   * Aborted when the step times out, the worker loses its lease, or the run is cancelled. The
   * engine does not kill the handler: after a timeout a retry may start while this attempt is still
   * running, so handlers must honour the signal (pass it to `fetch`, stop work) and use
   * {@link NodeContext.idempotencyKey} for side effects.
   */
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
  /**
   * SSRF-guarded fetch. `init.timeoutMs` bounds the connect, response-header and body timeouts;
   * `init.signal` defaults to {@link NodeContext.signal}. `init.credentialHeaders` names headers
   * (case-insensitive) that carry credentials: they never follow a redirect to another origin,
   * even when they would otherwise be kept (such as `Accept` or `Idempotency-Key`).
   * Redirects are followed (each hop re-checked) unless `init.redirect` is `"error"` (a redirect
   * throws a `FatalError` and nothing is re-sent) or `"manual"` (the 3xx response is returned).
   */
  http: {
    fetch(
      url: string,
      init?: RequestInit & { timeoutMs?: number; credentialHeaders?: string[] },
    ): Promise<Response>;
  };
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
  /**
   * Ephemeral side effect the engine runs once the suspension is committed (so, for a callback,
   * once its token is stored and the resume URL works), e.g. sending the resume URL elsewhere. It
   * is never journaled. Contract:
   * - Best effort, at most once per suspension: a crash between the commit and the call skips it.
   * - It runs without a lease: by then the run may already have been resumed, moved on or been
   *   cancelled. The engine re-checks before each retry and stops once the run no longer waits on
   *   this suspension.
   * - Each try is bounded by the node's `timeoutMs` (at most 30 s) and gets `signal`, aborted at
   *   that timeout or when the worker stops; pass it to `fetch`. The handler's `ctx` belongs to a
   *   finished invocation: `ctx.signal` is never aborted and `ctx.callback()` throws.
   * - Throwing a `RetryableError` (or timing out) retries it: 3 tries, 100 ms then 200 ms apart.
   *   Any other error, the last try, or a stopping worker records a `step.afterCommitFailed` event
   *   (token and resume URL masked); the run keeps waiting either way.
   */
  readonly afterCommit?: (opts: { signal: AbortSignal }) => Promise<void>;
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

/**
 * Returned by a looping node (`branches: { kind: "loop" }`) to run its `body` branch once per item.
 * The step's output is then built by the engine: `{ count, results }`.
 */
export interface LoopSignal {
  /** Signal tag. */
  readonly [FLOWKIT_SIGNAL]: true;
  /** Signal kind. */
  readonly kind: "loop";
  /** The items to iterate, in order; each is `loop.item` for one run of the body. */
  readonly items: readonly unknown[];
}

/** Any control-flow signal a handler can return instead of plain output. */
export type Signal =
  | BranchSignal<unknown>
  | SuspendSignal
  | StopSignal
  | SubflowSignal
  | LoopSignal;

/** Choose branch `id`, producing `output` as the step's output. */
export function branch<O = undefined>(id: string, output?: O): BranchSignal<O> {
  return { [FLOWKIT_SIGNAL]: true, kind: "branch", branch: id, output: output as O };
}

/**
 * Pause the run. The handler is re-invoked with `ctx.resume` set once the time is reached or the
 * callback is called. `afterCommit` runs once the suspension is committed (see
 * {@link SuspendSignal.afterCommit}).
 */
export function suspend(
  opts: ({ until: number } | { callback: CallbackHandle }) & {
    afterCommit?: (opts: { signal: AbortSignal }) => Promise<void>;
  },
): SuspendSignal {
  const hook = opts.afterCommit ? { afterCommit: opts.afterCommit } : {};
  return "until" in opts
    ? { [FLOWKIT_SIGNAL]: true, kind: "suspend", until: opts.until, ...hook }
    : { [FLOWKIT_SIGNAL]: true, kind: "suspend", callback: opts.callback, ...hook };
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

/**
 * Iterate `items` with a looping node's `body` branch (see {@link LoopSignal}). Returning
 * `{ items }` still works for backwards compatibility.
 *
 * @example
 * ```ts
 * run: ({ input }) => loop(input.contacts)
 * ```
 */
export function loop(items: readonly unknown[]): LoopSignal {
  return { [FLOWKIT_SIGNAL]: true, kind: "loop", items };
}

/**
 * Whether `v` is a signal returned by {@link branch}, {@link suspend}, {@link stop},
 * {@link invokeSubflow} or {@link loop}.
 */
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

/**
 * What a handler may return (or resolve to): its output, a {@link branch} signal carrying its
 * output, or another control-flow signal.
 */
export type NodeResult<O> =
  | O
  | BranchSignal<O>
  | SuspendSignal
  | StopSignal
  | SubflowSignal
  | LoopSignal;

/**
 * A node type: config schema, output shape and handler.
 *
 * @typeParam I - Zod object schema of the step's config (resolved and validated before `run`).
 * @typeParam O - The step's output type after validation (what downstream references see).
 * @typeParam R - What the handler returns: the output schema's input type (`z.input`), since the
 * return value is parsed with `output` (so fields with `.default()` may be omitted).
 */
export interface NodeDefinition<I extends z.ZodObject = z.ZodObject, O = unknown, R = O> {
  /** Globally unique, namespaced by plugin ID, e.g. `"crm.loadContact"`. */
  type: string;
  /** Display name. */
  name: string;
  /** Longer description. */
  description?: string;
  /** A bundled icon name (`bundledIconNames`) or a `<FlowkitProvider icons>` key; else a box. */
  icon?: string;
  /** Step picker category. */
  category?: string;
  /** Template rendered against config for the step card, e.g. `"Load {{contactId}}"`. */
  summary?: string;
  /** Config schema. Use {@link ui} to add editor hints. */
  input: I;
  /**
   * Output schema; the handler's return value is parsed with it. Declare `output` to get typed
   * references and validation. Without it (and without `dynamicOutput`) the output is untyped
   * (any JSON) and returned values are stored as-is.
   */
  output?: z.ZodType<O, R>;
  /** Output shape derived from config instead of a static schema. Mutually exclusive with `output`. */
  dynamicOutput?: Exclude<OutputSpec, { kind: "schema" }>;
  /** How the node branches. Defaults to `{ kind: "none" }`. */
  branches?: BranchSpec;
  /** Retry policy overrides. */
  retry?: Partial<RetryPolicy>;
  /** Handler wall-clock limit in ms, enforced via `ctx.signal`. Default `300_000`. */
  timeoutMs?: number;
  /**
   * For nodes that wait on a callback: how the wait is resumed. The run viewer validates its
   * resume form against `body`, and with `hostHandled` shows `hint` instead of the form (use it
   * when your app resumes the wait itself, e.g. from an approvals page).
   *
   * @example
   * resume: {
   *   body: z.object({ decision: z.enum(["approved", "rejected"]) }),
   *   hostHandled: true,
   *   hint: "Approve or reject it in Approvals.",
   * }
   */
  resume?: {
    /** Schema of the callback body the handler reads from `ctx.resume.body`. */
    body?: z.ZodType;
    /**
     * The host app resumes this wait: the run viewer offers no raw resume form and the generic
     * `POST /runs/:id/resume` route answers 409. The public token route still resumes it (the
     * token is a bearer capability), so never hand out this step's token or resume URL.
     */
    hostHandled?: boolean;
    /** Where or how to resume it, shown in the run viewer. */
    hint?: string;
  };
  /** The handler. Receives validated input; returns output or a signal. */
  run(args: { input: z.infer<I>; ctx: NodeContext }): Promise<NodeResult<R>> | NodeResult<R>;
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
 * return value (including a {@link branch} output) is checked against the output schema's input
 * type. Declare `output` to get typed references and validation.
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
export function defineNode<I extends z.ZodObject, O = unknown, R = O>(
  def: Omit<NodeDefinition<I, O, R>, "run"> & {
    // `NoInfer`: O and R come from `output` only, so `run`'s return is checked against it
    // rather than widening them to whatever `run` returns.
    run(args: {
      input: z.infer<I>;
      ctx: NodeContext;
    }): Promise<NodeResult<NoInfer<R>>> | NodeResult<NoInfer<R>>;
  },
): NodeDefinition<I, O, R> {
  assertNamespaced("Node", def.type);
  if (def.output !== undefined && def.dynamicOutput !== undefined) {
    throw new FlowkitDefinitionError(
      `Node "${def.type}" declares both output and dynamicOutput; use one`,
    );
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
  /** A bundled icon name (`bundledIconNames`) or a `<FlowkitProvider icons>` key; else a box. */
  icon?: string;
  /** How the trigger fires. */
  kind: TriggerKind;
  /** For `event` triggers: the event name to listen to. */
  event?: string;
  /** Config schema. */
  config: C;
  /**
   * Payload schema. Declare `payload` to get typed references and validation. Without it (and
   * without `dynamicPayload`) the payload is untyped (any JSON) and stored as-is. Mutually
   * exclusive with `dynamicPayload`.
   */
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
  /** A bundled icon name (`bundledIconNames`) or a `<FlowkitProvider icons>` key; else a box. */
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
