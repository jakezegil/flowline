import { expect, type Page, test } from "playwright/test";

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
  // An empty workflow has one (warning) issue.
  await expect(main.getByRole("button", { name: "1 issue" })).toBeVisible();

  // Add "Get contact" with the "+" between the trigger and End.
  await canvas.getByRole("button", { name: "Add step here" }).click();
  const picker = page.getByRole("dialog", { name: "Add step" });
  await picker.getByRole("combobox", { name: "Add step" }).fill("Get contact");
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
  await tree.getByRole("treeitem", { name: /^deal\b/ }).click();
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
    email.getByRole("img", { name: /references step "load" which no longer exists/ }),
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
    `"To" references step "load" which no longer exists`,
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
