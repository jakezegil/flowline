import type { WorkflowVersion } from "@flowlinejs/core";
import { type APIRequestContext, expect, type Page, test } from "playwright/test";

/**
 * Sections and notes on the seeded deal-stuck workflow. These tests save drafts but never publish:
 * `triggers.spec.ts` runs the seeded published version.
 */
const WORKFLOW = "deal-stuck-in-stage";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/demo/reset")).status()).toBe(204);
  await restoreSeededDraft(request);
});

/**
 * Saves the published (seeded) doc as the latest draft, so each test starts from the seed even
 * after an earlier test (or `--repeat-each` repetition) saved changes. Saving never publishes.
 */
async function restoreSeededDraft(request: APIRequestContext): Promise<void> {
  const res = await request.get(`/flowline/workflows/${WORKFLOW}`);
  const { published } = (await res.json()) as { published: WorkflowVersion | null };
  expect(published?.version).toBe(1);
  const saved = await request.put(`/flowline/workflows/${WORKFLOW}`, {
    data: published?.doc,
  });
  expect(saved.ok()).toBe(true);
}

/**
 * Waits for the canvas viewport to stop moving and for running finite animations and transitions
 * to end. With reduced motion (test 2 sets it) fit view is instant and the theme switch has no
 * transition, so this is a safeguard; infinite animations (spinners, pulses) are skipped.
 */
async function settle(page: Page): Promise<void> {
  const viewport = page.locator(".react-flow__viewport");
  let last = "";
  await expect(async () => {
    const now = await viewport.evaluate((el) => getComputedStyle(el).transform);
    const same = now === last;
    last = now;
    expect(same).toBe(true);
  }).toPass({ intervals: [100] });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
}

async function openEditor(page: Page) {
  await page.goto(`/workflows/${WORKFLOW}`);
  const main = page.getByRole("main");
  const canvas = main.getByRole("application", { name: "Workflow canvas" });
  await expect(canvas.getByRole("group", { name: /^Load owner/ })).toBeVisible();
  return { main, canvas };
}

test("groups two steps into a section, colours it, adds a note, ungroups and deletes through the UI", async ({
  page,
  request,
}) => {
  const { main, canvas } = await openEditor(page);
  const owner = canvas.getByRole("group", { name: /^Load owner/ });
  const nudge = canvas.getByRole("group", { name: /^Nudge owner/ });

  // Owner and nudge sit between the two seeded sections: a range, then Ctrl+G groups it.
  const seeded = ["Check the deal is still stuck", "Escalate"];
  for (const t of seeded) {
    await expect(canvas.getByRole("group", { name: `Section: ${t}` })).toBeVisible();
  }
  await owner.click();
  await nudge.click({ modifiers: ["Shift"] });
  // Playwright's Chromium reports a non-Mac platform, so the editor's mod key is Ctrl here.
  await page.keyboard.press("Control+g");
  const title = canvas.getByRole("textbox", { name: "Section title" });
  await expect(title).toBeFocused();
  await title.fill("Owner loop");
  await title.press("Enter");
  const region = canvas.getByRole("group", { name: "Section: Owner loop" });
  await expect(region).toBeVisible();

  // Chip menu → Color → Green.
  const chip = canvas.getByRole("button", { name: "Owner loop", exact: true });
  await chip.click();
  const menu = page.getByRole("menu", { name: "Section actions: Owner loop" });
  await menu.getByRole("menuitem", { name: "Color" }).click();
  await page.getByRole("menuitem", { name: "Green" }).click();
  await expect(region).toHaveAttribute("data-color", "green");

  // The owner card's "…" → Add note; a click elsewhere on the canvas commits it.
  await canvas.getByRole("button", { name: "Actions for Load owner" }).click();
  await page
    .getByRole("menu", { name: "Actions for Load owner" })
    .getByRole("menuitem", { name: "Add note" })
    .click();
  const noteBox = canvas.getByRole("textbox", { name: "Edit note" });
  await expect(noteBox).toBeFocused();
  await noteBox.fill("Check the owner");
  await canvas.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await expect(noteBox).toHaveCount(0);
  await expect(
    canvas.getByRole("group", { name: "Note: Check the owner", exact: true }),
  ).toBeVisible();

  // Chip menu → Ungroup: the section goes, its steps stay.
  await chip.click();
  await menu.getByRole("menuitem", { name: "Ungroup" }).click();
  await expect(canvas.getByRole("group", { name: "Section: Owner loop" })).toHaveCount(0);
  await expect(owner).toBeVisible();
  await expect(nudge).toBeVisible();

  // Select wait, click the panel header's type label (plain text, not a field), and Backspace
  // deletes the step: focus is on the body, not on the canvas or a text field.
  const wait = canvas.getByRole("group", { name: /^Wait a minute/ });
  await wait.click();
  const panel = main.getByRole("complementary", { name: "Step settings" });
  await panel.getByText("Delay", { exact: true }).click();
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(wait).toHaveCount(0);
  const toast = page.getByRole("status").filter({ hasText: "Deleted “Wait a minute”" });
  await expect(toast).toBeVisible();
  // Undo brings it back, so the saved doc keeps every seeded step.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(wait).toBeVisible();

  // Save (never publish), reload: the note is still on the owner step.
  await main.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Saved as v\d+/ })).toBeVisible();
  await page.reload();
  await expect(
    canvas.getByRole("group", { name: "Note: Check the owner", exact: true }),
  ).toBeVisible();
  await expect(canvas.getByRole("group", { name: /^Wait a minute/ })).toBeVisible();
  await expect(canvas.getByRole("group", { name: "Section: Owner loop" })).toHaveCount(0);
  for (const t of seeded) {
    await expect(canvas.getByRole("group", { name: `Section: ${t}` })).toBeVisible();
  }

  // The published version is still the seeded v1.
  const res = await request.get(`/flowline/workflows/${WORKFLOW}`);
  const { latest, published } = (await res.json()) as {
    latest: WorkflowVersion;
    published: WorkflowVersion | null;
  };
  expect(published?.version).toBe(1);
  expect(latest.doc.steps.find((s) => s.id === "owner")?.note).toBe("Check the owner");
  expect(latest.doc.steps.map((s) => s.id)).toEqual(published?.doc.steps.map((s) => s.id));
  expect(latest.doc.sections).toEqual(published?.doc.sections);
  expect(latest.doc.sections?.map((s) => s.id)).toEqual(["check_deal", "escalate_block"]);
});

test("seeded sections and notes render in light and dark", async ({ page }) => {
  // Tall enough for the whole flow at fit view's minimum zoom; no motion to wait for.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { canvas } = await openEditor(page);
  await expect(
    canvas.getByRole("group", { name: "Section: Check the deal is still stuck" }),
  ).toBeVisible();
  await expect(canvas.getByRole("group", { name: "Section: Escalate" })).toBeVisible();
  await expect(
    canvas.getByRole("group", { name: "Note: Owner, not assignee", exact: true }),
  ).toBeVisible();
  await expect(
    canvas.getByRole("group", { name: "Note: 1m in the demo, 1d in production", exact: true }),
  ).toBeVisible();

  // Artifacts for review, not pixel comparisons: the whole flow, once transitions have settled.
  await canvas.getByRole("button", { name: "Fit workflow to view" }).click();
  await settle(page);
  // Everything is in view, down to the pink escalate card at the bottom of Escalate.
  const escalate = canvas.getByRole("group", { name: /^Escalate to manager/ });
  await expect(escalate.locator('[data-color="pink"]')).toHaveCount(1);
  await expect(escalate).toBeInViewport({ ratio: 1 });
  await expect(canvas.getByRole("group", { name: "Section: Escalate" })).toBeInViewport({
    ratio: 1,
  });
  await expect(
    canvas.getByRole("group", { name: "Section: Check the deal is still stuck" }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/annotations-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await settle(page);
  await page.screenshot({ path: "test-results/annotations-dark.png" });
});
