import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "playwright/test";

/** The enterprise lead sample: 1,200 employees, so a manager must approve it. */
const ENTERPRISE_LEAD = {
  email: "hank@globex.test",
  firstName: "Hank",
  lastName: "Scorpio",
  company: "Globex",
  source: "referral",
  employees: 1200,
};
const APPROVAL_TITLE = "Enterprise lead: Globex (1200 employees)";

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/reset");
  expect(res.status()).toBe(204);
});

/** POST the enterprise lead to the lead-routing webhook; the new run's ID. */
async function sendEnterpriseLead(request: APIRequestContext): Promise<string> {
  const demo = (await (await request.get("/api/demo")).json()) as {
    webhooks: Record<string, string>;
  };
  const hook = demo.webhooks["inbound-lead-routing"];
  expect(hook).toBeDefined();
  const res = await request.post(hook as string, {
    data: ENTERPRISE_LEAD,
    headers: { "X-Request-Id": randomUUID() },
  });
  expect(res.status()).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

/** The run viewer, and its approval bar once the run waits on the manager. */
function runRegion(page: Page) {
  return page.getByRole("region", { name: "Run" });
}

async function expectWaitingForApproval(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  const run = runRegion(page);
  await expect(run.getByRole("heading", { name: /Inbound lead routing/ })).toBeVisible();
  await expect(
    run.getByRole("group", { name: "Manager approval" }).getByRole("img", { name: "Waiting" }),
  ).toBeVisible();
  await expect(run.getByRole("region", { name: "Approval" })).toContainText(APPROVAL_TITLE);
}

test("a webhook lead waits for approval, and approving it completes the run and emails the owner", async ({
  page,
}) => {
  await page.goto("/webhook-tester");
  const req = page.getByRole("region", { name: "Request" });
  await req.getByRole("button", { name: "Enterprise lead" }).click();
  await expect(req.getByRole("textbox", { name: "Body" })).toContainText("hank@globex.test");
  await req.getByRole("button", { name: "Send request" }).click();

  const response = page.getByRole("region", { name: "Response" });
  await expect(response).toContainText("202 Accepted");
  await response.getByRole("link", { name: "Open run" }).click();
  await expect(page).toHaveURL(/\/runs\/run_[0-9a-f]+/);
  const runId = new URL(page.url()).pathname.split("/").pop() as string;

  // The run list marks this run, waiting.
  const listed = page
    .getByRole("complementary", { name: "Runs" })
    .getByRole("button", { name: /Inbound lead routing/ })
    .and(page.locator("[aria-current=true]"));
  await expect(listed).toContainText("Waiting");
  const run = runRegion(page);
  await expect(
    run.getByRole("group", { name: "Manager approval" }).getByRole("img", { name: "Waiting" }),
  ).toBeVisible();

  // Decide it from the Approvals inbox.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Approvals" })
    .click();
  await expect(page.getByRole("tab", { name: "Pending 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const row = page.getByRole("row", { name: new RegExp(APPROVAL_TITLE.replace(/[()]/g, "\\$&")) });
  await expect(row).toContainText("Pending");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("tab", { name: "Pending 0" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Decided 1" })).toBeVisible();

  // The run resumes and completes down the Approved branch.
  await page.goto(`/runs/${runId}`);
  await expect(run.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(
    run.getByRole("group", { name: "Notify owner" }).getByRole("img", { name: "Succeeded" }),
  ).toBeVisible();
  await expect(run.getByRole("region", { name: "Approval" })).toHaveCount(0);

  // The owner got the email, sent by this run.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Outbox" })
    .click();
  const mail = page.getByRole("list", { name: "Sent emails" }).getByRole("button");
  await expect(mail).toHaveCount(1);
  await expect(mail).toContainText("Enterprise lead approved");
  await mail.click();
  await expect(page.getByRole("article", { name: "Email" })).toContainText(
    "Enterprise lead approved",
  );
  await expect(page.getByRole("article", { name: "Email" }).getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`/runs/${runId}`),
  );
});

test("rejecting the approval stops the run and shows the stopped banner", async ({
  page,
  request,
}) => {
  const runId = await sendEnterpriseLead(request);
  await expectWaitingForApproval(page, runId);

  const run = runRegion(page);
  await run
    .getByRole("region", { name: "Approval" })
    .getByRole("button", { name: "Reject" })
    .click();

  await expect(run.getByRole("region", { name: "Approval" })).toHaveCount(0);
  await expect(run.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await expect(
    run.getByRole("status").filter({ hasText: "Stopped at Stop: rejected" }),
  ).toContainText("Rejected by manager");
  await expect(
    run
      .getByRole("group", { name: "Stop: rejected" })
      .getByRole("img", { name: "Stopped the run" }),
  ).toBeVisible();
  // The Approved branch never ran, so nothing was emailed.
  await expect(run.getByRole("group", { name: "Notify owner" })).not.toContainText("Succeeded");
  const outbox = (await (await request.get("/api/outbox")).json()) as unknown[];
  expect(outbox).toEqual([]);

  // The runs list files it under Stopped.
  const list = page.getByRole("complementary", { name: "Runs" });
  await list
    .getByRole("group", { name: "Filter runs by status" })
    .getByRole("button", { name: "Stopped" })
    .click();
  await expect(list.locator("[aria-current=true]")).toContainText("Stopped");
});

test("cancelling a waiting run shows who cancelled it, and the run list and Approvals badge follow at once", async ({
  page,
  request,
}) => {
  const runId = await sendEnterpriseLead(request);
  await expectWaitingForApproval(page, runId);
  const nav = page.getByRole("navigation", { name: "Main" });
  const approvalsLink = nav.getByRole("link", { name: /^Approvals/ });
  await expect(approvalsLink).toContainText("1 pending");

  // Show only waiting runs: this one is listed.
  const list = page.getByRole("complementary", { name: "Runs" });
  await list
    .getByRole("group", { name: "Filter runs by status" })
    .getByRole("button", { name: "Waiting" })
    .click();
  const row = list.locator("[aria-current=true]");
  await expect(row).toContainText("Waiting");
  // Rows say what the run is about: the lead's email.
  await expect(row).toContainText(ENTERPRISE_LEAD.email);

  const run = runRegion(page);
  await run.getByRole("button", { name: "Cancel run" }).click();
  await page
    .getByRole("dialog", { name: "Cancel this run?" })
    .getByRole("button", { name: "Cancel run" })
    .click();

  // M15: a banner like the stopped one, naming the step, who cancelled and when.
  const banner = run.getByRole("status").filter({ hasText: "Cancelled while waiting at" });
  await expect(banner).toContainText("Cancelled while waiting at Manager approval");
  await expect(banner).toContainText(/By Demo user · (just now|\d+ sec)/);
  await expect(run.getByRole("region", { name: "Approval" })).toHaveCount(0);

  // M16: the run leaves the Waiting list and the badge drops without a reload, and sooner than
  // the list's (3 s) and the badge's (5 s) polls would get to it.
  await expect(list.getByRole("listitem").filter({ hasText: ENTERPRISE_LEAD.email })).toHaveCount(
    0,
    { timeout: 1500 },
  );
  await expect(approvalsLink).not.toContainText("pending", { timeout: 1500 });
});

test("the generic resume endpoint refuses a host-handled approval with 409", async ({
  page,
  request,
}) => {
  const runId = await sendEnterpriseLead(request);
  await expectWaitingForApproval(page, runId);

  const res = await request.post(`/flowline/runs/${runId}/resume`, {
    data: { decision: "approved" },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toMatchObject({ code: "resume_host_handled" });

  // The wait is untouched: the run still waits and the approval is still pending...
  const detail = (await (await request.get(`/flowline/runs/${runId}`)).json()) as {
    run: { status: string };
  };
  expect(detail.run.status).toBe("waiting");
  await page.reload();
  const run = runRegion(page);
  await expect(
    run.getByRole("group", { name: "Manager approval" }).getByRole("img", { name: "Waiting" }),
  ).toBeVisible();

  // ...so the CRM's own approval still decides it.
  await run
    .getByRole("region", { name: "Approval" })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(
    run.getByRole("group", { name: "Notify owner" }).getByRole("img", { name: "Succeeded" }),
  ).toBeVisible();
});

test("the run viewer steps through loop iterations and switches inspector tabs", async ({
  page,
  request,
}) => {
  const id = `loop-${test.info().repeatEachIndex}-${test.info().retry}`;
  const saved = await request.put(`/flowline/workflows/${id}?create=true`, {
    data: {
      id,
      name: "Greet everyone",
      trigger: {
        type: "core.manual",
        config: { fields: [{ name: "names", type: "array", required: true }] },
      },
      steps: [
        {
          id: "each",
          type: "core.forEach",
          name: "Each name",
          config: { items: { $ref: "trigger.names" } },
          branches: {
            body: [
              {
                id: "greet",
                type: "core.transform",
                name: "Greet",
                config: {
                  code: 'return { greeting: "Hi " + loop.item };',
                  outputFields: [{ name: "greeting", type: "string" }],
                },
              },
            ],
          },
        },
      ],
    },
  });
  expect(saved.ok()).toBe(true);
  const { version } = (await saved.json()) as { version: number };
  expect((await request.post(`/flowline/workflows/${id}/publish`, { data: { version } })).ok()).toBe(
    true,
  );
  const started = await request.post(`/flowline/workflows/${id}/run`, {
    data: { input: { names: ["Ada", "Grace", "Linus"] } },
  });
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };

  await page.goto(`/runs/${runId}`);
  const run = runRegion(page);
  await expect(run.getByRole("heading", { name: /Greet everyone/ })).toBeVisible();
  await expect(run.getByText("Completed", { exact: true }).first()).toBeVisible();

  const stepper = run.getByRole("group", { name: "Each name" }).getByRole("toolbar", {
    name: "Loop iteration",
  });
  const prev = stepper.getByRole("button", { name: "Previous iteration" });
  const next = stepper.getByRole("button", { name: "Next iteration" });
  // It opens on the last iteration.
  await expect(stepper).toContainText("3 / 3");
  await expect(next).toBeDisabled();

  await run.getByRole("group", { name: "Greet" }).click();
  const inspector = run.getByRole("complementary", { name: "Step details" });
  const tabs = inspector.getByRole("tablist", { name: "Step details" });
  await expect(inspector.getByRole("heading", { name: "Greet" })).toBeVisible();
  await expect(inspector).toContainText("iteration 3 of 3");
  await expect(tabs.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("tabpanel", { name: "Output" })).toContainText('"Hi Linus"');

  await prev.click();
  await expect(stepper).toContainText("2 / 3");
  await expect(next).toBeEnabled();
  await expect(inspector).toContainText("iteration 2 of 3");
  await expect(inspector.getByRole("tabpanel", { name: "Output" })).toContainText('"Hi Grace"');

  await prev.click();
  await expect(stepper).toContainText("1 / 3");
  await expect(prev).toBeDisabled();
  await expect(inspector.getByRole("tabpanel", { name: "Output" })).toContainText('"Hi Ada"');

  // Input shows what the step ran with.
  await tabs.getByRole("tab", { name: "Input" }).click();
  await expect(tabs.getByRole("tab", { name: "Input" })).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("tabpanel", { name: "Input" })).toContainText("loop.item");

  // Timeline lists the iteration's events.
  await tabs.getByRole("tab", { name: /^Timeline/ }).click();
  const timeline = inspector.getByRole("tabpanel", { name: /^Timeline/ });
  await expect(timeline.getByRole("listitem")).toHaveCount(2);
  await expect(timeline.getByRole("listitem").first()).toContainText("Started");
  await expect(timeline.getByRole("listitem").last()).toContainText("Completed");

  // Error has nothing for a step that succeeded.
  await tabs.getByRole("tab", { name: "Error" }).click();
  await expect(inspector.getByRole("tabpanel", { name: "Error" })).toBeVisible();

  await next.click();
  await expect(stepper).toContainText("2 / 3");
  await expect(inspector).toContainText("iteration 2 of 3");
});
