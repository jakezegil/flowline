/**
 * Test-only doc and manifest builders for the agent reads. Not exported from the package.
 *
 * @module
 */
import { z } from "zod";
import { defineNode, definePlugin, defineTrigger } from "../define";
import { createRegistry } from "../registry";
import type { Manifest, Step, WorkflowDoc } from "../types";

const Deal = z.object({ id: z.string(), stage: z.string(), ownerId: z.string() });

const dealStuckInStage = defineTrigger({
  type: "crm.dealStuckInStage",
  name: "Deal stuck in stage",
  kind: "poll",
  interval: "10s",
  config: z.object({ stage: z.string() }),
  payload: z.object({ deal: Deal }),
  poll: () => ({ items: [] }),
});

const getDeal = defineNode({
  type: "crm.getDeal",
  name: "Get deal",
  category: "CRM",
  input: z.object({ dealId: z.string() }),
  output: z.object({ deal: Deal }),
  run: () => ({ deal: { id: "d1", stage: "proposal", ownerId: "u1" } }),
});

const sendEmail = defineNode({
  type: "crm.sendEmail",
  name: "Send email",
  category: "CRM",
  keywords: ["mail"],
  input: z.object({ to: z.string(), subject: z.string(), body: z.string().optional() }),
  output: z.object({ messageId: z.string() }),
  run: () => ({ messageId: "m1" }),
});

const ifNode = defineNode({
  type: "flow.if",
  name: "If",
  category: "Logic",
  input: z.object({ value: z.boolean() }),
  output: z.object({ matched: z.boolean() }),
  branches: {
    kind: "static",
    branches: [
      { id: "then", label: "Then" },
      { id: "else", label: "Else" },
    ],
  },
  run: () => ({ matched: true }),
});

const stopNode = defineNode({
  type: "flow.stop",
  name: "Stop",
  category: "Logic",
  endsRun: true,
  input: z.object({ reason: z.string().optional() }),
  run: () => ({}),
});

const delayNode = defineNode({
  type: "flow.delay",
  name: "Delay",
  category: "Logic",
  input: z.object({ duration: z.string() }),
  run: () => ({}),
});

const registry = createRegistry([
  definePlugin({
    id: "crm",
    name: "CRM",
    nodes: [getDeal, sendEmail],
    triggers: [dealStuckInStage],
  }),
  definePlugin({ id: "flow", name: "Flow", nodes: [ifNode, stopNode, delayNode] }),
]);

/** A small CRM-like manifest: a poll trigger, `crm.getDeal`/`crm.sendEmail`, `flow.if`/`stop`/`delay`. */
export function crmLikeManifest(): Manifest {
  return registry.manifest();
}

const trigger: WorkflowDoc["trigger"] = {
  type: "crm.dealStuckInStage",
  config: { stage: "proposal" },
};

/** The doc behind the spec §3 example: a section around `getDeal`…`recheck`, two notes, one issue. */
export function specExampleDoc(): WorkflowDoc {
  return {
    id: "deal-stuck",
    name: "Deal stuck in stage",
    trigger,
    steps: [
      { id: "getDeal", type: "crm.getDeal", config: { dealId: { $ref: "trigger.deal.id" } } },
      {
        id: "recheck",
        type: "flow.if",
        // `value` is missing on purpose: one `config.required` issue.
        config: {},
        branches: {
          // biome-ignore lint/suspicious/noThenProperty: the spec example names this branch "then"
          then: [
            {
              id: "notifyOwner",
              type: "crm.sendEmail",
              config: {
                to: { $ref: "steps.getDeal.deal.ownerId" },
                subject: "Deal stuck in stage",
                body: "This deal hasn't moved for a while. Can you follow up today?",
              },
              note: "Owner, not assignee",
            },
          ],
          else: [{ id: "stopMoved", type: "flow.stop", config: {} }],
        },
      },
      { id: "delay_1m", type: "flow.delay", config: { duration: "1m" } },
    ],
    sections: [
      {
        id: "check",
        title: "Check the deal",
        color: "blue",
        note: "Skip if the deal already moved",
        first: "getDeal",
        last: "recheck",
      },
    ],
  };
}

/** Options for the large fixtures. */
export interface BigOptions {
  /** Give every step a note of this many characters. */
  noteChars?: number;
  /** Give the first step a config string of this many characters. */
  configChars?: number;
}

function filler(n: number, i: number, opts: BigOptions): Step {
  const id = `step_${n}`;
  const s: Step =
    n % 2 === 1
      ? { id, type: "crm.getDeal", config: { dealId: `deal_${n}` } }
      : { id, type: "crm.sendEmail", config: { to: `u${n}@example.com`, subject: `Hi ${n}` } };
  if (opts.noteChars) s.note = `n${n} `.padEnd(opts.noteChars, "x");
  else if (i % 5 === 0) s.note = `Note on step ${n}`;
  if (opts.configChars && n === 1) s.config = { dealId: "y".repeat(opts.configChars) };
  return s;
}

/** `n` top-level steps `step_1`…`step_n` with config, a note on every 5th, a section on the first 3. */
export function flatDoc(n: number, opts: BigOptions = {}): WorkflowDoc {
  const steps = Array.from({ length: n }, (_, i) => filler(i + 1, i, opts));
  return {
    id: "flat",
    name: "Flat",
    trigger,
    steps,
    ...(n >= 3
      ? {
          sections: [
            { id: "intro", title: "Intro", color: "green", first: "step_1", last: "step_3" },
          ],
        }
      : {}),
  };
}

/**
 * `depth` nested `flow.if` steps `if_1`…`if_<depth>`: each `then` holds filler steps and the next
 * level, each `else` a `stop_<level>`. Filler steps (`step_<k>`) are dealt round-robin over the
 * levels until the doc has `total` steps (at least `2 * depth`).
 */
export function deepDoc(depth: number, total = depth * 3, opts: BigOptions = {}): WorkflowDoc {
  const fill = Math.max(0, total - 2 * depth);
  const perLevel: Step[][] = Array.from({ length: depth }, () => []);
  for (let k = 0; k < fill; k++) {
    (perLevel[k % depth] as Step[]).push(filler(k + 1, k, opts));
  }
  let inner: Step[] = [];
  for (let level = depth; level >= 1; level--) {
    const ifStep: Step = {
      id: `if_${level}`,
      type: "flow.if",
      config: { value: true },
      branches: {
        // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
        then: [...(perLevel[level - 1] as Step[]), ...inner],
        else: [{ id: `stop_${level}`, type: "flow.stop", config: { reason: `level ${level}` } }],
      },
    };
    if (opts.noteChars) ifStep.note = `if${level} `.padEnd(opts.noteChars, "z");
    inner = [ifStep];
  }
  return { id: "deep", name: "Deep", trigger, steps: inner };
}
