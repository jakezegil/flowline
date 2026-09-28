import type {
  JournalEntry,
  Manifest,
  NodeManifest,
  ResumeSpec,
  RunDetail,
  RunEvent,
  RunStatus,
  WorkflowDoc,
} from "@flowkit/core";
import { docWith, manifest, step } from "./fixtures";

/**
 * A doc for run tests: load → cond (if: email, else: nudge) → each (body: tag) → off (disabled).
 */
export function runDoc(): WorkflowDoc {
  return docWith(
    [
      step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
      step(
        "cond",
        "logic.condition",
        { value: true },
        {
          branches: {
            if: [step("email", "crm.sendEmail", { to: "a@b.c", subject: "Hi" })],
            else: [step("nudge", "crm.sendEmail", { to: "a@b.c", subject: "Nudge" })],
          },
        },
      ),
      step(
        "each",
        "logic.forEach",
        { items: { $ref: "steps.load.tags" } },
        { branches: { body: [step("tag", "crm.sendEmail", { to: "a@b.c", subject: "Tag" })] } },
      ),
      step("off", "crm.sendEmail", { to: "a@b.c", subject: "Off" }, { disabled: true }),
    ],
    "welcome",
  );
}

const done = (startedAt: number, at: number, output: unknown = {}, extra = {}): JournalEntry => ({
  status: "done",
  output,
  startedAt,
  at,
  attempts: 1,
  ...extra,
});

let seq = 0;
/** An event of run `r1`. */
export function ev(type: RunEvent["type"], stepPath?: string, data?: unknown, at = 0): RunEvent {
  seq++;
  return {
    id: `e${seq}`,
    runId: "r1",
    tenantId: "t",
    seq,
    type,
    at,
    ...(stepPath ? { stepPath } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** A run detail around {@link runDoc}. */
export function runDetail(
  status: RunStatus,
  journal: Record<string, JournalEntry>,
  events: RunEvent[] = [],
  extra: Partial<RunDetail["run"]> = {},
): RunDetail {
  return {
    run: {
      id: "r1",
      workflowId: "welcome",
      version: 3,
      status,
      createdAt: 1000,
      updatedAt: 5000,
      startedBy: { kind: "event", event: "contact.created" },
      trigger: { contactId: "c1" },
      journal,
      ...extra,
    },
    events,
    doc: runDoc(),
  };
}

/** Failed in iteration 2 (index 1) of the loop; the condition took `if`. */
export function failedLoopRun(): RunDetail {
  return runDetail(
    "failed",
    {
      load: done(1000, 1182, { id: "c1", email: "a@b.c", name: "Ada", tags: ["x", "y", "z"] }),
      cond: done(1200, 1204, { matched: true }, { branch: "if" }),
      "cond/if/email": done(1210, 1500, { messageId: "m1" }),
      each: {
        status: "looping",
        items: ["x", "y", "z"],
        results: [],
        startedAt: 1600,
        at: 1601,
        attempts: 1,
      },
      "each/body[0]/tag": done(1610, 1700, { messageId: "m2" }),
      "each/body[1]/tag": {
        status: "failed",
        error: { message: "Mailbox full", code: "SMTP_552" },
        startedAt: 1710,
        at: 2100,
        attempts: 3,
        input: { to: "a@b.c", subject: "Tag" },
      },
    },
    [
      ev("run.started"),
      ev("step.started", "load"),
      ev("step.completed", "load", { output: { id: "c1" } }),
      ev("step.started", "each/body[1]/tag"),
      ev("step.retrying", "each/body[1]/tag", { attempt: 2 }),
      ev("step.failed", "each/body[1]/tag", { error: { message: "Mailbox full" } }),
      ev("run.failed", "each/body[1]/tag", { error: { message: "Mailbox full" } }),
    ],
    { error: { message: "Mailbox full", code: "SMTP_552", stepPath: "each/body[1]/tag" } },
  );
}

/** Waiting on a callback at `email`; the loop and `off` haven't run. */
export function waitingRun(): RunDetail {
  return runDetail(
    "waiting",
    {
      load: done(1000, 1182),
      cond: {
        status: "branched",
        branch: "if",
        output: { matched: true },
        startedAt: 1200,
        at: 1204,
        attempts: 1,
      },
      "cond/if/email": {
        status: "suspended",
        pending: { hasCallback: true, expiresAt: 10_000_000 },
        startedAt: 1210,
        at: 1300,
        attempts: 1,
      },
    },
    [ev("run.started"), ev("run.suspended", "cond/if/email", { callback: true })],
    { wakeAt: 10_000_000 },
  );
}

/** A node that waits for a decision, like the mini-CRM's approval step. */
export function approveNode(resume?: ResumeSpec): NodeManifest {
  return {
    type: "crm.approve",
    plugin: "crm",
    name: "Request approval",
    icon: "badge-check",
    input: { type: "object", properties: {} },
    output: { kind: "schema", schema: { type: "object", properties: {} } },
    branches: {
      kind: "static",
      branches: [
        { id: "approved", label: "Approved" },
        { id: "rejected", label: "Rejected" },
      ],
    },
    ...(resume ? { resume } : {}),
  };
}

/** The fixture manifest plus {@link approveNode}. */
export function approvalManifest(resume?: ResumeSpec): Manifest {
  return { ...manifest, nodes: [...manifest.nodes, approveNode(resume)] };
}

/**
 * load → size (if: approval (approved: notify, rejected: halt → after_halt), else: welcome) → last.
 */
export function approvalDoc(): WorkflowDoc {
  return docWith(
    [
      step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
      step(
        "size",
        "logic.condition",
        { value: true },
        {
          branches: {
            if: [
              step(
                "approval",
                "crm.approve",
                {},
                {
                  branches: {
                    approved: [step("notify", "crm.sendEmail", { to: "a@b.c", subject: "Yes" })],
                    rejected: [
                      step("halt", "crm.sendEmail", { to: "a@b.c", subject: "Stop" }),
                      step("after_halt", "crm.sendEmail", { to: "a@b.c", subject: "Never" }),
                    ],
                  },
                },
              ),
            ],
            else: [step("welcome", "crm.sendEmail", { to: "a@b.c", subject: "Hi" })],
          },
        },
      ),
      step("last", "crm.sendEmail", { to: "a@b.c", subject: "Last" }),
    ],
    "leads",
  );
}

const branched = (branch: string, startedAt: number, at: number): JournalEntry => ({
  status: "branched",
  branch,
  output: {},
  startedAt,
  at,
  attempts: 1,
});

/** {@link approvalDoc} waiting at `size/if/approval`. */
export function approvalWaitingRun(): RunDetail {
  return {
    ...runDetail(
      "waiting",
      {
        load: done(1000, 1100),
        size: branched("if", 1200, 1210),
        "size/if/approval": {
          status: "suspended",
          pending: { hasCallback: true, expiresAt: 10_000_000 },
          startedAt: 1300,
          at: 1310,
          attempts: 1,
        },
      },
      [ev("run.started"), ev("run.suspended", "size/if/approval", { callback: true })],
    ),
    doc: approvalDoc(),
  };
}

/** {@link approvalDoc} rejected: `halt` stopped the run inside both blocks. */
export function approvalStoppedRun(): RunDetail {
  return {
    ...runDetail(
      "completed",
      {
        load: done(1000, 1100),
        size: branched("if", 1200, 1210),
        "size/if/approval": branched("rejected", 1300, 4000),
        "size/if/approval/rejected/halt": done(4100, 4200, { stopped: true, reason: "No" }),
      },
      [ev("run.started"), ev("run.stopped", "size/if/approval/rejected/halt")],
      {
        output: { stoppedAt: "size/if/approval/rejected/halt", reason: "No" },
        stoppedAt: "size/if/approval/rejected/halt",
      },
    ),
    doc: approvalDoc(),
  };
}

/** A Stop ended the run in the first iteration of {@link runDoc}'s loop (of three items). */
export function loopStoppedRun(): RunDetail {
  return runDetail(
    "completed",
    {
      load: done(1000, 1182, { id: "c1", tags: ["x", "y", "z"] }),
      cond: done(1200, 1204, { matched: true }, { branch: "if" }),
      "cond/if/email": done(1210, 1500, { messageId: "m1" }),
      each: {
        status: "looping",
        items: ["x", "y", "z"],
        results: [],
        startedAt: 1600,
        at: 1601,
        attempts: 1,
      },
      "each/body[0]/tag": done(1610, 1700, { stopped: true, reason: "Enough" }),
    },
    [ev("run.started"), ev("run.stopped", "each/body[0]/tag")],
    { output: { stoppedAt: "each/body[0]/tag", reason: "Enough" }, stoppedAt: "each/body[0]/tag" },
  );
}
