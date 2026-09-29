import type { RunDetail, RunSummary } from "@flowlinejs/core";
import { type APIRequestContext, expect, type Page, test } from "playwright/test";

const DAY = 86_400_000;

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/reset");
  expect(res.status()).toBe(204);
});

/** Jump the server's fake clock ahead; the poll triggers are swept before this answers. */
async function advance(request: APIRequestContext, ms: number): Promise<void> {
  const res = await request.post("/api/demo/advance", { data: { ms } });
  expect(res.status()).toBe(204);
}

/** Runs of `workflowId` created at or after `since` (server time), with their trigger payloads. */
async function runsOf<T>(
  request: APIRequestContext,
  workflowId: string,
  since: number,
): Promise<{ run: RunSummary; trigger: T }[]> {
  const res = await request.get(`/flowline/runs?workflowId=${workflowId}&limit=100`);
  const runs = ((await res.json()) as RunSummary[]).filter((r) => r.createdAt >= since);
  return Promise.all(
    runs.map(async (run) => {
      const detail = (await (await request.get(`/flowline/runs/${run.id}`)).json()) as RunDetail;
      return { run, trigger: detail.run.trigger as T };
    }),
  );
}

/** The newest run's creation time: runs created later than this are this test's. */
async function latestRunTime(request: APIRequestContext): Promise<number> {
  const runs = (await (await request.get("/flowline/runs?limit=1")).json()) as RunSummary[];
  return (runs[0]?.createdAt ?? 0) + 1;
}

function contactRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

type StuckTrigger = { deal: { id: string; name: string } };

test("Any call ended: AI and VoIP calls each start a run, a redelivered call does not", async ({
  page,
  request,
}) => {
  const since = await latestRunTime(request);
  await page.goto("/contacts");
  const grace = contactRow(page, "Grace Hopper");

  const logged = page.waitForResponse(
    (r) => r.url().endsWith("/api/calls") && r.request().method() === "POST",
  );
  await grace.getByRole("button", { name: /^Log AI call/ }).click();
  const aiCall = (await (await logged).json()) as { id: string };
  await expect(page.getByText("AI call with Grace Hopper logged")).toBeVisible();

  await grace.getByRole("button", { name: /^Log VoIP call/ }).click();
  await expect(page.getByText("VoIP call with Grace Hopper logged")).toBeVisible();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Runs" }).click();
  const list = page.getByRole("complementary", { name: "Runs" });
  const callRuns = list.getByRole("button", { name: /Any call ended/ });
  await expect(callRuns).toHaveCount(2);
  await expect(callRuns.filter({ hasText: "Event ai_call.ended" })).toHaveCount(1);
  await expect(callRuns.filter({ hasText: "Event voip_call.ended" })).toHaveCount(1);

  // The phone system redelivers the AI call: same call ID, a new event.
  const again = await request.post("/api/calls", {
    data: { id: aiCall.id, contactId: "c_1", kind: "ai", durationSec: 95 },
  });
  expect(again.status()).toBe(200);
  const events = (await (await request.get("/api/demo/trigger-events")).json()) as {
    type: string;
    key?: string;
  }[];
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "trigger.deduped",
      key: `event:any-call-ended:${aiCall.id}`,
    }),
  );
  expect(await runsOf(request, "any-call-ended", since)).toHaveLength(2);
  await page.reload();
  await expect(callRuns).toHaveCount(2);
});

test("Deal stuck in stage: the sweep nudges the owner, and changing the stage cancels the waiting run", async ({
  page,
  request,
}) => {
  const since = await latestRunTime(request);
  await advance(request, 3 * DAY);

  let runId = "";
  await expect(async () => {
    const runs = await runsOf<StuckTrigger>(request, "deal-stuck-in-stage", since);
    const navy = runs.find((r) => r.trigger.deal.id === "d_1");
    expect(navy?.run.status).toBe("waiting");
    runId = navy?.run.id as string;
  }).toPass();

  // The owner's nudge names the deal.
  await page.goto("/outbox");
  await expect(
    page.getByText("Navy Labs expansion has been in proposal for 3 days").first(),
  ).toBeVisible();

  await page.goto("/deals");
  await page.getByRole("combobox", { name: "Stage of Navy Labs expansion" }).selectOption("won");
  await expect(page.getByText("Navy Labs expansion moved to Won")).toBeVisible();

  await page.goto(`/runs/${runId}`);
  const run = page.getByRole("region", { name: "Run" });
  await expect(run.getByRole("heading", { name: /Deal stuck in stage/ })).toBeVisible();
  // The host cancelled it while it waited to re-check, and says why.
  const banner = run.getByRole("status").filter({ hasText: "Cancelled while waiting at" });
  await expect(banner).toContainText("Cancelled while waiting at Wait a minute");
  await expect(banner).toContainText("Stage changed");
});

test("Deal stuck in stage: a deal that moved on before the threshold never fires", async ({
  page,
  request,
}) => {
  const since = await latestRunTime(request);
  await page.goto("/deals");
  await page.getByRole("combobox", { name: "Stage of Kernel Co seats" }).selectOption("qualified");
  await expect(page.getByText("Kernel Co seats moved to Qualified")).toBeVisible();

  await advance(request, 3 * DAY);

  // The sweep ran: the deal still in proposal fired, the one that moved on did not.
  await expect(async () => {
    const runs = await runsOf<StuckTrigger>(request, "deal-stuck-in-stage", since);
    expect(runs.map((r) => r.trigger.deal.id)).toEqual(["d_1"]);
  }).toPass();
});
