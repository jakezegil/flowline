/**
 * Flowkit without a UI: a `demo` plugin, a workflow built in code, an in-memory engine.
 * Run it with `pnpm --filter headless start`.
 */
import { pathToFileURL } from "node:url";
import {
  createRegistry,
  defineNode,
  definePlugin,
  FatalError,
  ref,
  tpl,
  workflow,
} from "@flowkit/core";
import { createEngine } from "@flowkit/engine";
import { and, conditionNode, isTrue, manualTrigger, stopNode } from "@flowkit/nodes-builtin";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { z } from "zod";

/** A sent notification. */
export interface Message {
  to: string;
  text: string;
  idempotencyKey: string;
}

// Type `ctx.services` for every handler.
declare module "@flowkit/core" {
  interface FlowkitServices {
    users: Map<string, { name: string; email: string; vip: boolean }>;
    outbox: Message[];
  }
}

const lookupUser = defineNode({
  type: "demo.lookupUser",
  name: "Look up user",
  summary: "Look up {{userId}}",
  input: z.object({ userId: z.string() }),
  output: z.object({ name: z.string(), email: z.string(), vip: z.boolean() }),
  run: ({ input, ctx }) => {
    const user = ctx.services.users.get(input.userId);
    if (!user) throw new FatalError(`No user ${input.userId}`); // fatal: retrying cannot help
    return user;
  },
});

const notify = defineNode({
  type: "demo.notify",
  name: "Notify",
  input: z.object({ to: z.string(), text: z.string() }),
  output: z.object({ sent: z.boolean() }),
  run: ({ input, ctx }) => {
    // Steps run at least once: dedupe side effects on the idempotency key.
    const { outbox } = ctx.services;
    if (!outbox.some((m) => m.idempotencyKey === ctx.idempotencyKey)) {
      outbox.push({ ...input, idempotencyKey: ctx.idempotencyKey });
    }
    return { sent: true };
  },
});

const demo = definePlugin({ id: "demo", name: "Demo", nodes: [lookupUser, notify] });

const welcome = workflow("welcome-vip", { name: "Welcome VIPs" })
  .trigger(manualTrigger, { fields: [{ name: "userId", type: "string", required: true }] })
  .step("lookupUser", lookupUser, { userId: ref("trigger.userId") })
  .step(
    "check",
    conditionNode,
    { rules: and(isTrue(ref("steps.lookupUser.vip"))) },
    {
      if: (b) =>
        b.step("notify", notify, {
          to: ref("steps.lookupUser.email"),
          text: tpl("Welcome back, {{steps.lookupUser.name}}!"),
        }),
      else: (b) => b.step("halt", stopNode, { reason: "Not a VIP" }),
    },
  )
  .build();

/** Run the workflow once for `userId`, print its status and audit log, and return them. */
export async function main({ userId = "u1", log = console.log } = {}) {
  const outbox: Message[] = [];
  const users = new Map([
    ["u1", { name: "Ada", email: "ada@example.com", vip: true }],
    ["u2", { name: "Bob", email: "bob@example.com", vip: false }],
  ]);
  const engine = createEngine({
    registry: createRegistry([demo]),
    storage: createMemoryStorage(),
    services: { users, outbox },
  });

  const tenantId = "acme";
  const { version } = await engine.saveWorkflow(tenantId, welcome, "dev");
  await engine.publish(tenantId, welcome.id, version, "dev");
  const runId = await engine.start({ tenantId, workflowId: welcome.id, input: { userId } });
  await engine.drain(); // a real host calls engine.startWorker() instead

  const detail = await engine.getRunDetail(tenantId, runId);
  if (!detail) throw new Error(`Run ${runId} not found`);
  log(`Run ${runId} ${detail.run.status}`);
  for (const e of detail.events) {
    log(`${String(e.seq).padStart(3)} ${e.type.padEnd(15)} ${e.stepPath ?? ""}`.trimEnd());
  }
  return { status: detail.run.status, events: detail.events, outbox };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({ userId: process.argv[2] ?? "u1" });
}
