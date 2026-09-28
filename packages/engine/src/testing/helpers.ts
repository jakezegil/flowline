/**
 * Helpers for testing nodes and workflows in plugin and host code.
 *
 * @module
 */
import {
  createRegistry,
  type FlowkitServices,
  isSignal,
  type NodeContext,
  type NodeDefinition,
  type NodeResult,
  type PluginDefinition,
  type RunDetail,
  type RunEvent,
  type WorkflowDoc,
} from "@flowkit/core";
import type { z } from "zod";
import { createNodeContext } from "../context";
import { createEngine, type EngineOptions } from "../engine";

const TEST_TENANT = "test";
/** Drain-and-advance rounds before {@link runWorkflowInMemory} gives up on a run. */
const MAX_ROUNDS = 1_000;
const FINISHED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/**
 * Run a node's handler directly: `input` is parsed with the node's input schema (throwing on
 * invalid input), the handler runs with a default context (`runId` `"test-run"`, `stepId`
 * `"test"`, no services, secrets that are all missing, a callback that resumes nothing) overridden
 * by `ctx`, and its output is parsed with the output schema, if any. Signals (`branch()`,
 * `suspend()`, ...) are returned as they are.
 *
 * Resolves {@link TestNodeResult}: the node's output type or a signal. `isSignal(out)` narrows it,
 * so a node that declares `output` needs no cast (`if (!isSignal(out)) out.amount`).
 *
 * @example
 * ```ts
 * expect(await testNode(loadContact, { contactId: "c1" }, { services: { db } })).toEqual(contact);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts node definitions of any input/output types
export async function testNode<N extends NodeDefinition<any, any, any>>(
  node: N,
  input: z.input<N["input"]>,
  ctx: Partial<NodeContext> = {},
): Promise<TestNodeResult<N>> {
  const parsed = await node.input.parseAsync(input);
  const clock = ctx.now ?? Date.now;
  const base = createNodeContext({
    runId: "test-run",
    tenantId: TEST_TENANT,
    workflowId: "test",
    stepId: "test",
    stepPath: "test",
    attempt: 1,
    idempotencyKey: "test-idempotency-key",
    services: {} as FlowkitServices,
    signal: new AbortController().signal,
    clock,
    scope: { trigger: undefined, steps: {}, run: { id: "test-run" } },
    callback: async ({ timeoutMs }) => ({
      token: "test-token",
      resumeUrl: "http://localhost/flowkit/resume/test-token",
      expiresAt: clock() + timeoutMs,
    }),
  });
  const result = await node.run({ input: parsed, ctx: { ...base, ...ctx } });
  if (isSignal(result) || !node.output) return result as TestNodeResult<N>;
  return (await (node.output as z.ZodType).parseAsync(result)) as TestNodeResult<N>;
}

/**
 * What {@link testNode} resolves for node `N`: its parsed output (the output schema's type), a
 * `branch()` signal carrying it, or another signal. Untyped nodes resolve `unknown`.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches node definitions of any input/output types
export type TestNodeResult<N extends NodeDefinition<any, any, any>> =
  N extends NodeDefinition<infer _I, infer O, infer _R> ? NodeResult<O> : unknown;

/** Options of {@link runWorkflowInMemory}. */
export interface RunWorkflowInMemoryOptions {
  /** Plugins to register next to the built-in `core.*` nodes and triggers. */
  plugins?: PluginDefinition[];
  /** The run's trigger input (for a webhook trigger, `{ body, headers }`). */
  trigger?: unknown;
  /** Host services exposed to handlers as `ctx.services`. */
  services?: FlowkitServices;
  /** Base time source in epoch ms. Default `Date.now`. */
  clock?: () => number;
  /**
   * Secret values by name, for `ctx.secrets.get(name)` and the webhook signing secret. A name
   * that isn't listed is "not configured", as in production. Also used as the secret list the
   * validator checks secret names against.
   */
  secrets?: Record<string, string>;
  /**
   * The network policy of `ctx.http.fetch` (see `EngineOptions.http`). Set
   * `allowPrivateNetworks: true` to reach a mock server on `localhost`.
   */
  http?: EngineOptions["http"];
  /**
   * Sub-flows the doc calls: each is saved and published, in order, before the doc, so its
   * `core.callSubflow` steps validate and run. Their runs are advanced along with the doc's.
   */
  subflows?: WorkflowDoc[];
}

/**
 * Run `doc` to the end on a fresh in-memory engine (with the built-in nodes plus `plugins`):
 * saves and publishes it (throwing `FlowkitValidationError` if it has errors), starts it with
 * `trigger` as input and drains it. Timers, retries and callback timeouts are reached by advancing
 * the engine clock (`clock`, default `Date.now`, plus the time skipped so far) to the next wake
 * time, so a `2d` delay completes at once. Stops early when the run waits on something only an
 * outside call can resume (a callback without timeout). Resolves the run as `getRunDetail` shows it
 * (sensitive values masked) and its events.
 *
 * Requires `@flowkit/storage-memory`, loaded lazily on first call so importing `testNode` alone
 * never requires it.
 *
 * @example
 * ```ts
 * const { run } = await runWorkflowInMemory(dealWebhook, {
 *   plugins: [crm],
 *   services,
 *   trigger: { body: { dealId: "d1" }, headers: {} },
 *   secrets: { CHAT_TOKEN: "test-token" }, // what ctx.secrets.get("CHAT_TOKEN") returns
 *   http: { allowPrivateNetworks: true }, // let ctx.http reach a local mock server
 *   subflows: [notifyOwner], // published first, so callSubflow can find it
 * });
 * ```
 */
export async function runWorkflowInMemory(
  doc: WorkflowDoc,
  opts: RunWorkflowInMemoryOptions = {},
): Promise<{ run: RunDetail["run"]; events: RunEvent[] }> {
  const base = opts.clock ?? Date.now;
  let skipped = 0;
  const clock = () => base() + skipped;
  const { createMemoryStorage } = await import("@flowkit/storage-memory");
  const storage = createMemoryStorage();
  const secrets = opts.secrets;
  const engine = createEngine({
    registry: createRegistry(opts.plugins ?? []),
    storage,
    clock,
    ...(opts.services ? { services: opts.services } : {}),
    ...(opts.http ? { http: opts.http } : {}),
    ...(secrets
      ? {
          secrets: {
            get: async (_tenantId: string, name: string) =>
              Object.hasOwn(secrets, name) ? secrets[name] : undefined,
            list: async () => Object.keys(secrets),
          },
        }
      : {}),
  });
  // Sub-flows first, so the doc's callSubflow steps validate and run against them.
  for (const sub of opts.subflows ?? []) {
    const v = await engine.saveWorkflow(TEST_TENANT, sub, "test");
    await engine.publish(TEST_TENANT, sub.id, v.version, "test");
  }
  const saved = await engine.saveWorkflow(TEST_TENANT, doc, "test");
  await engine.publish(TEST_TENANT, doc.id, saved.version, "test");
  const runId = await engine.start({
    tenantId: TEST_TENANT,
    workflowId: doc.id,
    input: opts.trigger,
  });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    await engine.drain();
    const run = await storage.getRun(TEST_TENANT, runId);
    if (!run || FINISHED.has(run.status)) break;
    // The earliest wake time of any waiting run (the run itself or one of its sub-flows).
    let next: number | undefined;
    for (const r of await storage.listRuns(TEST_TENANT, { status: "waiting", limit: 1_000 })) {
      const wakeAt = (await storage.getRun(TEST_TENANT, r.id))?.wakeAt;
      if (wakeAt !== undefined && (next === undefined || wakeAt < next)) next = wakeAt;
    }
    if (next === undefined) break;
    skipped += Math.max(0, next - clock());
  }

  const detail = await engine.getRunDetail(TEST_TENANT, runId);
  if (!detail) throw new Error(`Run "${runId}" disappeared`);
  return { run: detail.run, events: detail.events };
}
