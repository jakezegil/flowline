/**
 * An in-memory FlowkitClient for the playground: a couple of workflows and a set of runs in the
 * states the run viewer has to explain (running, waiting on a callback, failed, failed inside a
 * loop, completed, cancelled). Times are relative to page load.
 */
import type {
  JournalEntry,
  RunDetail,
  RunEvent,
  RunStatus,
  RunSummary,
  Step,
  SubflowInfo,
  TestStepRequest,
  TestStepResponse,
  WorkflowDoc,
  WorkflowVersion,
} from "@flowkit/core";
import type { FlowkitClient } from "@flowkit/core/client";
import { manifest, nestedDoc, webhookDoc } from "./fixtures";

const T0 = Date.now();
const min = 60_000;

const s = (
  id: string,
  type: string,
  config: Step["config"] = {},
  extra: Partial<Step> = {},
): Step => ({
  id,
  type,
  config,
  ...extra,
});

/** The workflow the sample runs executed. */
export function onboardingDoc(trigger = "crm.contactCreated"): WorkflowDoc {
  return {
    id: "onboarding",
    name: "New contact onboarding",
    trigger: {
      type: trigger,
      config:
        trigger === "core.manual"
          ? {
              fields: [
                {
                  name: "contactId",
                  type: "string",
                  required: true,
                  description: "The contact to onboard",
                },
                { name: "dryRun", type: "boolean", description: "Skip emails and tags" },
              ],
            }
          : {},
    },
    steps: [
      s("loadContact", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
      s(
        "qualified",
        "core.condition",
        { rules: { combinator: "and", rules: [] } },
        {
          name: "Qualified lead?",
          branches: {
            if: [
              s(
                "approval",
                "core.waitForCallback",
                { timeout: "2d" },
                {
                  name: "Sales approval",
                  branches: {
                    resumed: [
                      s("welcome", "crm.sendEmail", {
                        to: { $ref: "steps.loadContact.email" },
                        subject: { $tpl: "Welcome, {{steps.loadContact.name}}" },
                      }),
                    ],
                    timeout: [s("reminder", "crm.createTask", { title: "Chase approval" })],
                  },
                },
              ),
            ],
            else: [
              s(
                "nurture",
                "crm.addTag",
                { contactId: { $ref: "trigger.contactId" }, tag: "nurture" },
                { name: "Tag as nurture" },
              ),
            ],
          },
        },
      ),
      s(
        "eachTag",
        "core.forEach",
        { items: { $ref: "steps.loadContact.tags" } },
        {
          name: "For each interest",
          branches: {
            body: [
              s("addTag", "crm.addTag", {
                contactId: { $ref: "trigger.contactId" },
                tag: { $ref: "loop.item" },
              }),
            ],
          },
        },
      ),
      s("kickoff", "crm.createTask", { title: "Kickoff call" }, { name: "Create kickoff task" }),
    ],
  };
}

const contact = {
  id: "c_8812",
  name: "Ada Lovelace",
  email: "ada@analytical.co",
  phone: "[redacted]",
  region: "EMEA",
  tags: ["analytics", "enterprise", "vip-trial", "newsletter", "events"],
};

function done(startedAt: number, ms: number, output: unknown, extra: object = {}): JournalEntry {
  return {
    status: "done",
    output,
    startedAt: T0 + startedAt,
    at: T0 + startedAt + ms,
    attempts: 1,
    ...extra,
  };
}

class Log {
  events: RunEvent[] = [];
  constructor(private runId: string) {}
  add(type: RunEvent["type"], at: number, stepPath?: string, data?: unknown) {
    const seq = this.events.length + 1;
    this.events.push({
      id: `${this.runId}-${seq}`,
      runId: this.runId,
      tenantId: "acme",
      seq,
      type,
      at: T0 + at,
      ...(stepPath ? { stepPath } : {}),
      ...(data !== undefined ? { data } : {}),
    });
    return this;
  }
  step(path: string, start: number, ms: number, input: unknown, output: unknown) {
    return this.add("step.started", start, path, { input }).add(
      "step.completed",
      start + ms,
      path,
      { output },
    );
  }
}

function detail(
  id: string,
  status: RunStatus,
  start: number,
  end: number,
  journal: Record<string, JournalEntry>,
  log: Log,
  extra: Partial<RunDetail["run"]> = {},
): RunDetail {
  return {
    run: {
      id,
      workflowId: "onboarding",
      version: 7,
      status,
      createdAt: T0 + start,
      updatedAt: T0 + end,
      startedBy: { kind: "event", event: "contact.created" },
      trigger: { contactId: contact.id, source: "webform" },
      journal,
      ...extra,
    },
    events: log.events,
    doc: onboardingDoc(),
  };
}

const loadIn = { contactId: contact.id };
const tagOut = (i: number) => ({ tag: contact.tags[i], applied: true });

/** Running: iterating the loop, second interest in flight. */
function runningRun(): RunDetail {
  const b = -40_000;
  const log = new Log("run_7Kq2")
    .add("run.started", b)
    .step("loadContact", b + 20, 180, loadIn, contact)
    .add("step.started", b + 210, "qualified")
    .add("step.completed", b + 214, "qualified", { output: { matched: false }, branch: "else" })
    .step(
      "qualified/else/nurture",
      b + 220,
      240,
      { tag: "nurture" },
      { tag: "nurture", applied: true },
    )
    .add("step.started", b + 500, "eachTag")
    .step("eachTag/body[0]/addTag", b + 510, 260, { tag: "analytics" }, tagOut(0))
    .add("step.started", b + 800, "eachTag/body[1]/addTag", { input: { tag: "enterprise" } });
  return detail(
    "run_7Kq2",
    "running",
    b,
    b + 800,
    {
      loadContact: done(b + 20, 180, contact),
      qualified: done(b + 210, 4, { matched: false }, { branch: "else" }),
      "qualified/else/nurture": done(b + 220, 240, { tag: "nurture", applied: true }),
      eachTag: {
        status: "looping",
        items: contact.tags,
        results: [tagOut(0)],
        startedAt: T0 + b + 500,
        at: T0 + b + 505,
        attempts: 1,
      },
      "eachTag/body[0]/addTag": done(b + 510, 260, tagOut(0)),
    },
    log,
  );
}

/** Waiting for the sales approval callback, which expires in two days. */
function waitingRun(): RunDetail {
  const b = -3 * 60 * min;
  const expiresAt = T0 + b + 2 * 24 * 60 * min;
  const log = new Log("run_4Hd9")
    .add("run.started", b)
    .step("loadContact", b + 20, 210, loadIn, contact)
    .add("step.started", b + 240, "qualified")
    .add("step.completed", b + 244, "qualified", { output: { matched: true }, branch: "if" })
    .add("step.started", b + 250, "qualified/if/approval", { input: { timeout: "2d" } })
    .add("run.suspended", b + 260, "qualified/if/approval", { callback: true, expiresAt });
  return detail(
    "run_4Hd9",
    "waiting",
    b,
    b + 260,
    {
      loadContact: done(b + 20, 210, contact),
      qualified: {
        status: "branched",
        branch: "if",
        output: { matched: true },
        startedAt: T0 + b + 240,
        at: T0 + b + 244,
        attempts: 1,
      },
      "qualified/if/approval": {
        status: "suspended",
        pending: { hasCallback: true, expiresAt },
        startedAt: T0 + b + 250,
        at: T0 + b + 260,
        attempts: 1,
        input: { timeout: "2d" },
      },
    },
    log,
  );
}

/** Failed on the last step after five attempts: the CRM was down. */
function failedRun(): RunDetail {
  const b = -26 * min;
  const err = { message: "CRM API returned 503 Service Unavailable", code: "HTTP_503" };
  const log = new Log("run_9Tx1")
    .add("run.started", b)
    .step("loadContact", b + 20, 190, loadIn, contact)
    .add("step.started", b + 220, "qualified")
    .add("step.completed", b + 224, "qualified", { output: { matched: false }, branch: "else" })
    .step(
      "qualified/else/nurture",
      b + 230,
      210,
      { tag: "nurture" },
      { tag: "nurture", applied: true },
    )
    .add("step.started", b + 450, "eachTag");
  for (let i = 0; i < 5; i++)
    log.step(
      `eachTag/body[${i}]/addTag`,
      b + 460 + i * 220,
      200,
      { tag: contact.tags[i] },
      tagOut(i),
    );
  log.add("step.completed", b + 1560, "eachTag", { output: { count: 5 } });
  log.add("step.started", b + 1570, "kickoff", {
    input: { title: "Kickoff call", apiKey: "[redacted]" },
  });
  for (let a = 2; a <= 5; a++)
    log.add("step.retrying", b + 1570 + a * 4000, "kickoff", {
      attempt: a,
      delayMs: 2 ** a * 500,
      error: err,
    });
  log
    .add("step.failed", b + 22_000, "kickoff", { error: err })
    .add("run.failed", b + 22_000, "kickoff", { error: err });
  const loopJournal: Record<string, JournalEntry> = {};
  for (let i = 0; i < 5; i++)
    loopJournal[`eachTag/body[${i}]/addTag`] = done(b + 460 + i * 220, 200, tagOut(i));
  return detail(
    "run_9Tx1",
    "failed",
    b,
    b + 22_000,
    {
      loadContact: done(b + 20, 190, contact),
      qualified: done(b + 220, 4, { matched: false }, { branch: "else" }),
      "qualified/else/nurture": done(b + 230, 210, { tag: "nurture", applied: true }),
      eachTag: done(b + 450, 1110, { count: 5, results: contact.tags.map((_, i) => tagOut(i)) }),
      ...loopJournal,
      kickoff: {
        status: "failed",
        error: err,
        startedAt: T0 + b + 1570,
        at: T0 + b + 22_000,
        attempts: 5,
        input: { title: "Kickoff call", apiKey: "[redacted]" },
      },
    },
    log,
    { error: { ...err, stepPath: "kickoff" } },
  );
}

/** Failed inside the loop: the third interest's tag doesn't exist. */
function loopFailedRun(): RunDetail {
  const b = -2 * 60 * min - 12 * min;
  const err = {
    message: "Tag “vip-trial” does not exist in this workspace",
    code: "TAG_NOT_FOUND",
    fatal: true,
  };
  const log = new Log("run_2Mp6")
    .add("run.started", b)
    .step("loadContact", b + 20, 170, loadIn, contact)
    .add("step.started", b + 200, "qualified")
    .add("step.completed", b + 204, "qualified", { output: { matched: false }, branch: "else" })
    .step(
      "qualified/else/nurture",
      b + 210,
      230,
      { tag: "nurture" },
      { tag: "nurture", applied: true },
    )
    .add("step.started", b + 450, "eachTag")
    .step("eachTag/body[0]/addTag", b + 460, 210, { tag: "analytics" }, tagOut(0))
    .step("eachTag/body[1]/addTag", b + 680, 190, { tag: "enterprise" }, tagOut(1))
    .add("step.started", b + 880, "eachTag/body[2]/addTag", { input: { tag: "vip-trial" } })
    .add("step.failed", b + 1040, "eachTag/body[2]/addTag", { error: err })
    .add("run.failed", b + 1040, "eachTag/body[2]/addTag", { error: err });
  return detail(
    "run_2Mp6",
    "failed",
    b,
    b + 1040,
    {
      loadContact: done(b + 20, 170, contact),
      qualified: done(b + 200, 4, { matched: false }, { branch: "else" }),
      "qualified/else/nurture": done(b + 210, 230, { tag: "nurture", applied: true }),
      eachTag: {
        status: "looping",
        items: contact.tags,
        results: [tagOut(0), tagOut(1)],
        startedAt: T0 + b + 450,
        at: T0 + b + 455,
        attempts: 1,
      },
      "eachTag/body[0]/addTag": done(b + 460, 210, tagOut(0)),
      "eachTag/body[1]/addTag": done(b + 680, 190, tagOut(1)),
      "eachTag/body[2]/addTag": {
        status: "failed",
        error: err,
        startedAt: T0 + b + 880,
        at: T0 + b + 1040,
        attempts: 1,
        input: { tag: "vip-trial" },
      },
    },
    log,
    { error: { ...err, stepPath: "eachTag/body[2]/addTag" } },
  );
}

/** Completed yesterday. */
function completedRun(): RunDetail {
  const b = -26 * 60 * min;
  const log = new Log("run_1Ab3").add("run.started", b).add("run.completed", b + 2400);
  const d = detail("run_1Ab3", "completed", b, b + 2400, {}, log, {
    startedBy: { kind: "manual", userId: "u_jo" },
  });
  return d;
}

export const RUNS: Record<string, () => RunDetail> = {
  running: runningRun,
  waiting: waitingRun,
  failed: failedRun,
  loop: loopFailedRun,
};

const all = [runningRun(), waitingRun(), failedRun(), loopFailedRun(), completedRun()];
const byId = new Map(all.map((d) => [d.run.id, d]));

function summaries(): RunSummary[] {
  const extra: RunSummary[] = [
    { status: "completed", at: -3 * 60 * min, ms: 1900, kind: "webhook" },
    { status: "cancelled", at: -5 * 60 * min, ms: 64_000, kind: "manual" },
    { status: "completed", at: -2 * 24 * 60 * min, ms: 2300, kind: "schedule" },
  ].map((r, i) => ({
    id: `run_x${i}`,
    workflowId: "onboarding",
    version: 6,
    status: r.status as RunStatus,
    createdAt: T0 + r.at,
    updatedAt: T0 + r.at + r.ms,
    startedBy:
      r.kind === "webhook"
        ? { kind: "webhook" }
        : r.kind === "schedule"
          ? { kind: "schedule", fireAt: T0 + r.at }
          : { kind: "manual" },
  }));
  return [...all.map(({ run: { trigger, journal, ...rest } }) => rest), ...extra].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

function version(doc: WorkflowDoc, v: number): WorkflowVersion {
  return {
    workflowId: doc.id,
    tenantId: "acme",
    version: v,
    doc,
    createdBy: "u_jo",
    createdAt: T0 - 60 * min,
  };
}

const SUBFLOWS: SubflowInfo[] = [
  {
    id: "enrich-company",
    name: "Enrich company",
    input: {
      type: "object",
      properties: {
        domain: { type: "string", "x-flowkit": { label: "Company domain" } },
        includeContacts: {
          type: "boolean",
          "x-flowkit": { label: "Include contacts" },
          default: false,
        },
      },
      required: ["domain"],
    },
    output: {
      type: "object",
      properties: { industry: { type: "string" }, employees: { type: "number" } },
    },
  },
  {
    id: "notify-owner",
    name: "Notify account owner",
    input: { type: "object", properties: { message: { type: "string" } } },
    output: { type: "object", properties: {} },
  },
];

/** Canned step test results (the panel resolves the input itself): sending email fails. */
function testResult({ step }: TestStepRequest): TestStepResponse {
  switch (step.type) {
    case "crm.loadContact":
      return { ok: true, output: contact, durationMs: 182 };
    case "crm.sendEmail":
      return {
        ok: false,
        error: "SMTP relay rejected the recipient: mailbox ada@analytical.co is unavailable (550)",

        durationMs: 911,
      };
    case "core.condition":
      return { ok: true, output: { matched: true }, branch: "if", durationMs: 3 };
    case "core.switch":
      return { ok: true, output: { matched: "emea" }, branch: "emea", durationMs: 2 };
    case "core.httpRequest":
      return {
        ok: true,
        output: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true },
        },

        durationMs: 348,
      };
    default:
      return { ok: true, output: { id: `${step.id}_1`, ok: true }, durationMs: 64 };
  }
}

/** The playground client. `wf=clean` edits the onboarding flow with a manual trigger. */
export function mockClient(): FlowkitClient {
  const docs: Record<string, WorkflowDoc> = {
    "deal-won": nestedDoc(),
    onboarding: onboardingDoc("core.manual"),
    "inbound-lead": webhookDoc(),
  };
  let saved = 7;
  return {
    baseUrl: "/api/flowkit",
    getManifest: () => delay(manifest),
    listWorkflows: () => delay([]),
    getWorkflow: (id) => {
      const doc = docs[id];
      if (!doc) return Promise.reject(Object.assign(new Error("Not found"), { status: 404 }));
      return delay({ latest: version(doc, saved), published: version(doc, saved - 1) });
    },
    saveWorkflow: (doc) => {
      docs[doc.id] = doc;
      return delay(version(doc, ++saved), 400);
    },
    publish: () => delay(undefined, 400),
    validate: () => delay([]),
    listSubflows: () => delay(SUBFLOWS),
    listSecrets: () => delay(["DATA_TEAM_TOKEN", "SLACK_WEBHOOK", "STRIPE_KEY"]),
    testStep: (req) => delay(testResult(req), 700),
    runWorkflow: () => delay({ runId: "run_new" }, 400),
    listRuns: (filter = {}) =>
      delay(summaries().filter((r) => !filter.status || r.status === filter.status)),
    getRun: (id) => {
      const d = byId.get(id);
      return d ? delay(d) : Promise.reject(new Error(`Run ${id} not found`));
    },
    retryRun: () => delay({ runId: "run_7Kq2" }, 400),
    cancelRun: () => delay(undefined, 300),
    resumeRun: () => delay(undefined, 300),
    subscribeRun: () => () => {},
  } as FlowkitClient;
}

/** The run ID of a playground run state. */
export function runIdOf(state: string): string {
  return (RUNS[state] ?? runningRun)().run.id;
}
