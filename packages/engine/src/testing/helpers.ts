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
  type PluginDefinition,
  type RunDetail,
  type RunEvent,
  type WorkflowDoc,
} from "@flowkit/core";
import { createMemoryStorage } from "@flowkit/storage-memory";
import type { z } from "zod";
import { createNodeContext } from "../context";
import { createEngine } from "../engine";

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
 * @example
 * ```ts
 * expect(await testNode(loadContact, { contactId: "c1" }, { services: { db } })).toEqual(contact);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts node definitions of any input/output types
export async function testNode<N extends NodeDefinition<any, any>>(
  node: N,
  input: z.input<N["input"]>,
  ctx: Partial<NodeContext> = {},
): Promise<unknown> {
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
    services: {},
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
  if (isSignal(result) || !node.output) return result;
  return (node.output as z.ZodType).parseAsync(result);
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
 * Requires `@flowkit/storage-memory`.
 */
export async function runWorkflowInMemory(
  doc: WorkflowDoc,
  opts: {
    plugins?: PluginDefinition[];
    trigger?: unknown;
    services?: FlowkitServices;
    clock?: () => number;
  } = {},
): Promise<{ run: RunDetail["run"]; events: RunEvent[] }> {
  const base = opts.clock ?? Date.now;
  let skipped = 0;
  const clock = () => base() + skipped;
  const storage = createMemoryStorage();
  const engine = createEngine({
    registry: createRegistry(opts.plugins ?? []),
    storage,
    clock,
    ...(opts.services ? { services: opts.services } : {}),
  });
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
