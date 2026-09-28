import { type APIRequestContext, expect, type Page, test } from "playwright/test";

/** The header's status ("Draft · v2"), as opposed to a toast, which has a Dismiss button. */
function headerStatus(page: Page) {
  return page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasNot: page.getByRole("button", { name: "Dismiss" }) })
    .filter({ hasText: /Draft|Published|Unsaved/ });
}

/** A workflow ID no other test (or `--repeat-each` repetition) uses. */
function uniqueId(base: string): string {
  const info = test.info();
  return `${base}-${info.repeatEachIndex}-${info.retry}`;
}

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/reset");
  expect(res.status()).toBe(204);
});

test("builds a workflow from scratch, maps a field through the data picker, saves and publishes", async ({
  page,
}) => {
  const name = `Deal contact lookup ${uniqueId("e2e")}`;
  await page.goto("/workflows");
  await page.getByRole("button", { name: "New workflow" }).first().click();

  const dialog = page.getByRole("dialog", { name: "New workflow" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await expect(dialog.getByRole("radio", { name: /^Deal updated/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Create and open editor" }).click();

  await expect(page).toHaveURL(/\/workflows\/deal-contact-lookup-e2e-/);
  const main = page.getByRole("main");
  const canvas = main.getByRole("application", { name: "Workflow canvas" });
  const publish = main.getByRole("button", { name: "Publish" });
  await expect(main.getByRole("textbox", { name: "Workflow name" })).toHaveValue(name);
  await expect(headerStatus(page)).toHaveText("Draft · v1");
  // An empty workflow's only issue is that it has no steps: the pill says what to do.
  await expect(main.getByRole("button", { name: "Add a first step" })).toBeVisible();

  // Add "Get contact" with the "+" between the trigger and End.
  await canvas.getByRole("button", { name: "Add first step" }).click();
  const picker = page.getByRole("dialog", { name: "Add step" });
  await picker.getByRole("combobox", { name: "Search steps" }).fill("Get contact");
  await picker.getByRole("option", { name: /^Get contact/ }).click();

  const card = canvas.getByRole("group", { name: "Get contact" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("img", { name: /"Contact ID" is required/ })).toBeVisible();
  await expect(main.getByRole("button", { name: "1 issue" })).toBeVisible();
  await expect(publish).toBeDisabled();
  await expect(headerStatus(page)).toHaveText("Unsaved changes");

  // Map Contact ID to the trigger's deal.contactId through the data picker.
  const panel = main.getByRole("complementary", { name: "Step settings" });
  await expect(panel.getByRole("tab", { name: /Configure/ })).toHaveAccessibleName(/1 issue/);
  await panel.getByRole("button", { name: "Browse data" }).click();
  const tree = page.getByRole("tree", { name: "Insert data" });
  // A click on an object inserts it (M13); its chevron opens it.
  await tree
    .getByRole("treeitem", { name: /^deal\b/ })
    .locator(".fk-dp__chevron")
    .click();
  await tree.getByRole("treeitem", { name: /^contactId\b/ }).click();
  await page.keyboard.press("Escape");

  const contactId = panel.getByRole("textbox", { name: "Contact ID" });
  await expect(contactId.getByRole("img", { name: /Trigger › deal\.contactId/ })).toBeVisible();
  await expect(card).toContainText("Trigger › deal.contactId");
  // Clean now: the pill goes away and Publish is allowed.
  await expect(main.getByRole("button", { name: /issues?$/ })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Configure" })).toBeVisible();
  await expect(publish).toBeEnabled();

  await main.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as v2" })).toBeVisible();
  await expect(headerStatus(page)).toHaveText("Draft · v2");

  await publish.click();
  await expect(headerStatus(page)).toHaveText("Published v2");
  // Nothing new to publish.
  await expect(publish).toBeDisabled();

  await main.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("Live v2");
  await expect(row).toContainText("Deal updated");
});

test("deleting a referenced step flags the stale reference and blocks Publish", async ({
  page,
  request,
}) => {
  const id = uniqueId("stale-ref");
  // Load contact → Email contact, whose To reads the loaded contact's email. Saved, not published,
  // so Publish starts out enabled.
  const saved = await request.put(`/flowkit/workflows/${id}?create=true`, {
    data: {
      id,
      name: "Stale reference",
      trigger: { type: "crm.dealUpdated", config: {} },
      steps: [
        {
          id: "load",
          type: "crm.getContact",
          name: "Load contact",
          config: { contactId: { $ref: "trigger.deal.contactId" } },
        },
        {
          id: "email",
          type: "crm.sendEmail",
          name: "Email contact",
          config: { to: { $ref: "steps.load.contact.email" }, subject: "Hello", body: "Hi there" },
        },
      ],
    },
  });
  expect(saved.ok()).toBe(true);

  await page.goto(`/workflows/${id}`);
  const main = page.getByRole("main");
  const canvas = main.getByRole("application", { name: "Workflow canvas" });
  const publish = main.getByRole("button", { name: "Publish" });
  const email = canvas.getByRole("group", { name: "Email contact" });
  await expect(email).toContainText("Load contact › contact.email");
  await expect(main.getByRole("button", { name: /issues?$/ })).toHaveCount(0);
  await expect(publish).toBeEnabled();

  await canvas.getByRole("button", { name: "Actions for Load contact" }).click();
  await page
    .getByRole("menu", { name: "Actions for Load contact" })
    .getByRole("menuitem", { name: "Delete" })
    .click();
  await expect(canvas.getByRole("group", { name: "Load contact" })).toHaveCount(0);

  // The issues pill counts the dangling reference, and the card carries a badge.
  await expect(main.getByRole("button", { name: "1 issue" })).toBeVisible();
  await expect(
    email.getByRole("img", { name: /references step "load", which isn.t in this workflow/ }),
  ).toBeVisible();
  await expect(publish).toBeDisabled();

  // The field shows the reference as a warning pill, with the reason below it.
  await email.click();
  const panel = main.getByRole("complementary", { name: "Step settings" });
  const to = panel.getByRole("textbox", { name: "To" });
  await expect(
    to.getByRole("img", { name: /load › contact\.email: not available here/ }),
  ).toBeVisible();
  await expect(panel.getByRole("listitem")).toContainText([
    `"To" references step "load", which isn't in this workflow`,
  ]);

  // Saving the broken draft is allowed, but the server refuses to publish it.
  await main.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as v2" })).toBeVisible();
  const published = await request.post(`/flowkit/workflows/${id}/publish`, {
    data: { version: 2 },
  });
  expect(published.ok()).toBe(false);
  const body = (await published.json()) as { issues?: { code: string; stepId?: string }[] };
  expect(body.issues).toContainEqual(
    expect.objectContaining({ code: "ref.unresolved", stepId: "email" }),
  );

  // Undo brings the step back and clears the issue.
  await main
    .getByRole("toolbar", { name: "Workflow actions" })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(canvas.getByRole("group", { name: "Load contact" })).toBeVisible();
  await expect(main.getByRole("button", { name: /issues?$/ })).toHaveCount(0);
  await expect(publish).toBeEnabled();
});

/** Saves a draft (Load contact → Email contact) under a fresh ID and opens it in the editor. */
async function openEmailWorkflow(page: Page, request: APIRequestContext, base: string) {
  const id = uniqueId(base);
  const saved = await request.put(`/flowkit/workflows/${id}?create=true`, {
    data: {
      id,
      name: "Notify owner",
      trigger: { type: "crm.dealUpdated", config: {} },
      steps: [
        {
          id: "load",
          type: "crm.getContact",
          name: "Load contact",
          config: { contactId: { $ref: "trigger.deal.contactId" } },
        },
        { id: "email", type: "crm.sendEmail", name: "Notify owner", config: {} },
      ],
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto(`/workflows/${id}`);
  const main = page.getByRole("main");
  const canvas = main.getByRole("application", { name: "Workflow canvas" });
  await expect(canvas.getByRole("group", { name: "Notify owner" })).toBeVisible();
  return { id, main, canvas };
}

test("H1: the data picker never covers the next field, and clicking that field moves focus there", async ({
  page,
  request,
}) => {
  const { main, canvas } = await openEmailWorkflow(page, request, "h1-picker");
  await canvas.getByRole("group", { name: "Notify owner" }).click();
  const panel = main.getByRole("complementary", { name: "Step settings" });
  const to = panel.getByRole("textbox", { name: "To" });
  const subject = panel.getByRole("textbox", { name: "Subject" });
  await to.click();
  const tree = page.getByRole("tree", { name: "Insert data" });
  await expect(tree).toBeVisible();
  // Insert Load contact › contact.email into To.
  await page.getByRole("combobox", { name: "Search data" }).fill("email");
  await tree
    .getByRole("treeitem", { name: /^email\b/ })
    .first()
    .click();
  await expect(to.getByRole("img", { name: /Load contact › contact\.email/ })).toBeVisible();

  // Wherever the picker is, it isn't over Subject.
  const pickerBox = await page.locator(".fk-dp").first().boundingBox();
  const subjectBox = await subject.boundingBox();
  expect(pickerBox && subjectBox).toBeTruthy();
  if (pickerBox && subjectBox) {
    const overlaps =
      pickerBox.x < subjectBox.x + subjectBox.width &&
      subjectBox.x < pickerBox.x + pickerBox.width &&
      pickerBox.y < subjectBox.y + subjectBox.height &&
      subjectBox.y < pickerBox.y + pickerBox.height;
    expect(overlaps).toBe(false);
  }
  // The click lands on Subject (which opens its own picker), not on To's.
  await subject.click();
  await expect(subject).toBeFocused();
  await page.keyboard.type("Enterprise lead approved");
  await expect(subject).toContainText("Enterprise lead approved");
  await expect(to).not.toContainText("Enterprise lead approved");
});

test("H2: leaving the editor through the app's links with unsaved changes asks first", async ({
  page,
  request,
}) => {
  const { id, main } = await openEmailWorkflow(page, request, "h2-leave");
  const name = main.getByRole("textbox", { name: "Workflow name" });
  await name.fill("Notify owner, edited");
  await name.press("Enter");
  await expect(headerStatus(page)).toHaveText("Unsaved changes");

  await page.getByRole("link", { name: "Runs" }).first().click();
  const confirm = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
  await expect(name).toHaveValue("Notify owner, edited");

  await main.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
  await page
    .getByRole("dialog", { name: "Leave without saving?" })
    .getByRole("button", { name: "Leave and discard" })
    .click();
  await expect(page).toHaveURL(/\/workflows$/);

  // Once saved, leaving doesn't ask.
  await page.goto(`/workflows/${id}`);
  await name.fill("Notify owner, saved");
  await name.press("Enter");
  await main.getByRole("button", { name: "Save" }).click();
  await expect(headerStatus(page)).toHaveText(/Draft · v\d/);
  await page.getByRole("link", { name: "Runs" }).first().click();
  await expect(page).toHaveURL(/\/runs$/);
});

test("H3: step search ranks the step named like the query first, and Enter inserts it", async ({
  page,
  request,
}) => {
  const { canvas } = await openEmailWorkflow(page, request, "h3-search");
  const picker = page.getByRole("dialog", { name: "Add step" });
  const search = picker.getByRole("combobox", { name: "Search steps" });
  const first = picker.locator('[role="option"][aria-selected="true"]');

  await canvas.getByRole("button", { name: "Add step after Notify owner" }).click();
  await search.fill("send email");
  await expect(first).toHaveAccessibleName(/^Send email/);
  await search.fill("approval");
  await expect(first).toHaveAccessibleName(/^Request approval/);
  await page.keyboard.press("Enter");
  await expect(canvas.getByRole("group", { name: "Request approval" })).toBeVisible();
});
