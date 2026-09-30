/**
 * Success criterion 1 of the 0.3.0 spec: an agent holding only the tool catalog and `runTool`
 * builds `dealStuckFlow` from a blank manual-trigger doc in at most four calls, with no errors.
 */
import {
  type Command,
  commandCatalog,
  commandSchema,
  runTool,
  type Step,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { createCrmRegistry } from "./app";
import { DEAL_STUCK_WORKFLOW_ID, dealStuckFlow, STUCK_DEAL_MANAGER_ID } from "./flows/deal-stuck";

const manifest = createCrmRegistry().manifest();
const catalog = commandCatalog(manifest);
const toolNames = new Set(catalog.map((t) => t.name));

/** The same condition the 0.2.0 spec uses twice: the loaded deal is still in the trigger's stage. */
const stillInStage = (stepRef: string) => ({
  rules: {
    combinator: "and",
    compare: "strict",
    rules: [
      {
        left: { $ref: `steps.${stepRef}.deal.stage` },
        op: "eq",
        right: { $ref: "trigger.deal.stage" },
      },
    ],
  },
});

/** The one `apply` batch: trigger, name, the whole flow, both sections and the annotations. */
const commands: Command[] = [
  { op: "setTrigger", type: "crm.dealStuckInStage", config: { stage: "proposal", days: 3 } },
  { op: "renameWorkflow", name: "Deal stuck in stage" },
  {
    op: "insertSteps",
    at: { start: true },
    steps: [
      {
        ref: "loaded",
        id: "deal",
        type: "crm.getDeal",
        config: { dealId: { $ref: "trigger.deal.id" } },
      },
      {
        id: "still_there",
        type: "core.condition",
        config: stillInStage("$loaded"),
        branches: {
          else: [{ id: "moved_on", type: "core.stop", config: { reason: "Deal moved on" } }],
        },
      },
      {
        ref: "ownerUser",
        id: "owner",
        type: "crm.getUser",
        config: { userId: { $ref: "steps.$loaded.deal.ownerId" } },
      },
      {
        id: "nudge",
        type: "crm.sendEmail",
        config: {
          to: { $ref: "steps.$ownerUser.user.email" },
          subject: {
            $tpl: "{{trigger.deal.name}} has been in {{trigger.deal.stage}} for {{trigger.days}} days",
          },
          body: {
            $tpl: "Hi {{steps.$ownerUser.user.name}},\n\n{{trigger.deal.name}} hasn't moved for {{trigger.days}} days. Can you follow up today?",
          },
        },
      },
      { id: "wait", type: "core.delay", config: { duration: "1m" } },
      {
        ref: "recheck",
        id: "recheck",
        type: "crm.getDeal",
        config: { dealId: { $ref: "trigger.deal.id" } },
      },
      {
        id: "still_stuck",
        type: "core.condition",
        config: stillInStage("$recheck"),
        branches: {
          else: [{ id: "moved_on_later", type: "core.stop", config: { reason: "Deal moved on" } }],
        },
      },
      {
        ref: "manager",
        id: "manager",
        type: "crm.getUser",
        config: { userId: STUCK_DEAL_MANAGER_ID },
      },
      {
        id: "escalate",
        type: "crm.sendEmail",
        config: {
          to: { $ref: "steps.$manager.user.email" },
          subject: { $tpl: "Escalation: {{trigger.deal.name}} is stuck in {{trigger.deal.stage}}" },
          body: {
            $tpl: "{{trigger.deal.name}} is still in {{trigger.deal.stage}} after {{steps.$ownerUser.user.name}} was nudged.",
          },
        },
      },
    ],
  },
  {
    op: "addSection",
    id: "check_deal",
    first: "$loaded",
    last: "still_there",
    title: "Check the deal is still stuck",
    color: "blue",
    note: "Every side effect is preceded by a fresh load",
  },
  {
    op: "addSection",
    id: "escalate_block",
    first: "$recheck",
    last: "escalate",
    title: "Escalate",
    color: "pink",
  },
  { op: "setNote", id: "nudge", note: "Owner, not assignee" },
  { op: "setNote", id: "wait", note: "1m in the demo, 1d in production" },
  { op: "setColor", id: "escalate", color: "pink" },
];

/** The doc without display names (S13): IDs, types, config, branches, notes and colours stay. */
function structure(doc: WorkflowDoc) {
  const strip = (steps: Step[]): unknown[] =>
    steps.map(({ name: _name, branches, ...rest }) =>
      branches
        ? {
            ...rest,
            branches: Object.fromEntries(Object.entries(branches).map(([k, v]) => [k, strip(v)])),
          }
        : rest,
    );
  return { trigger: doc.trigger, steps: strip(doc.steps), sections: doc.sections ?? [] };
}

describe("the agent scenario", () => {
  test("builds dealStuckFlow from a blank doc in at most 4 tool calls, with no errors", () => {
    let doc: WorkflowDoc = {
      id: DEAL_STUCK_WORKFLOW_ID,
      name: "Untitled workflow",
      trigger: { type: "core.manual", config: {} },
      steps: [],
    };
    const used: string[] = [];
    const call = (name: string, args: unknown) => {
      used.push(name);
      const r = runTool({ doc, manifest }, name, args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok && r.doc) doc = r.doc;
      return r.ok ? r.result : undefined;
    };

    // 1. Learn the config of every node type the flow uses.
    const described = call("describeNodeTypes", {
      types: ["crm.getDeal", "crm.getUser", "crm.sendEmail", "core.condition", "core.delay"],
    });
    expect(described).toBeTruthy();

    // 2. Build everything in one atomic batch.
    for (const [i, command] of commands.entries()) {
      const parsed = commandSchema(manifest, { internal: false }).safeParse(command);
      expect(parsed.success, `commands[${i}]: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    const applied = call("apply", { commands });
    expect(applied, JSON.stringify(applied)).toMatchObject({
      ok: true,
      ids: { $loaded: "deal", $ownerUser: "owner", $recheck: "recheck", $manager: "manager" },
    });

    // 3. Check the result.
    const issues = call("getIssues", {}) as { errors: number; issues: unknown[] };
    expect(issues.errors, JSON.stringify(issues.issues)).toBe(0);

    expect(used.length).toBeLessThanOrEqual(4);
    for (const name of used) expect(toolNames).toContain(name);
    expect(doc.name).toBe(dealStuckFlow.name);
    expect(structure(doc)).toEqual(structure(dealStuckFlow));
  });
});
