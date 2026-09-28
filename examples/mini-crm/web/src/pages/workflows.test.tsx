// @vitest-environment jsdom
import type { Manifest, WorkflowDoc } from "@flowline/core";
import { createClient } from "@flowline/core/client";
import { FlowlineProvider } from "@flowline/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const saveWorkflow = vi.fn(async (_doc: WorkflowDoc) => ({}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  flowline: { saveWorkflow: (doc: WorkflowDoc) => saveWorkflow(doc) },
}));

const { NewWorkflowDialog, defaultTrigger, slugify, triggersFor } = await import("./workflows");

const trigger = (type: string, name: string, kind: string, config: object = {}) =>
  ({ type, name, kind, description: `${name} trigger`, config }) as Manifest["triggers"][number];

const MANIFEST = {
  nodes: [],
  triggers: [
    trigger("core.webhook", "Webhook", "webhook"),
    trigger("core.subflow", "Sub-flow", "subflow", {
      properties: { input: { default: [] }, output: { default: [] } },
    }),
    trigger("crm.contactCreated", "Contact created", "event"),
    trigger("crm.dealUpdated", "Deal updated", "event"),
  ],
} as unknown as Manifest;

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
});
afterEach(() => {
  cleanup();
  saveWorkflow.mockClear();
});

function renderDialog() {
  render(
    <FlowlineProvider client={createClient({ baseUrl: "/flowline" })}>
      <MemoryRouter>
        <NewWorkflowDialog open onClose={() => {}} manifest={MANIFEST} taken={new Set()} />
      </MemoryRouter>
    </FlowlineProvider>,
  );
}

describe("New workflow dialog", () => {
  it("splits triggers into workflow and sub-flow ones", () => {
    expect(triggersFor(MANIFEST, "workflow").map((t) => t.type)).toEqual([
      "core.webhook",
      "crm.contactCreated",
      "crm.dealUpdated",
    ]);
    expect(triggersFor(MANIFEST, "subflow").map((t) => t.type)).toEqual(["core.subflow"]);
  });

  it("defaults to the app's own event, else a webhook, else the first trigger", () => {
    const wf = triggersFor(MANIFEST, "workflow");
    expect(defaultTrigger(wf)?.type).toBe("crm.contactCreated");
    const appEvent = trigger("core.event", "App event", "event");
    expect(defaultTrigger([appEvent, ...wf.filter((t) => t.type === "core.webhook")])?.type).toBe(
      "core.webhook",
    );
    expect(defaultTrigger([appEvent])?.type).toBe("core.event");
    expect(defaultTrigger([])).toBeUndefined();
  });

  it("explains both choices and starts a workflow from a CRM event by default", async () => {
    renderDialog();
    const workflow = screen.getByRole("radio", { name: /^Workflow\s*Runs on its own/ });
    expect((workflow as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /^Sub-flow\s*A reusable piece/ })).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: /^Contact created/ }) as HTMLInputElement).checked,
    ).toBe(true);

    await userEvent.type(screen.getByLabelText("Name"), "Big deal alert");
    await userEvent.click(screen.getByRole("button", { name: "Create and open editor" }));
    await waitFor(() => expect(saveWorkflow).toHaveBeenCalled());
    expect(saveWorkflow.mock.calls[0]?.[0]).toMatchObject({
      id: "big-deal-alert",
      trigger: { type: "crm.contactCreated" },
    });
  });

  it("says so, and cannot create, when the app has no trigger of the kind", async () => {
    render(
      <FlowlineProvider client={createClient({ baseUrl: "/flowline" })}>
        <MemoryRouter>
          <NewWorkflowDialog
            open
            onClose={() => {}}
            manifest={{ ...MANIFEST, triggers: triggersFor(MANIFEST, "workflow") }}
            taken={new Set()}
          />
        </MemoryRouter>
      </FlowlineProvider>,
    );
    await userEvent.click(screen.getByRole("radio", { name: /^Sub-flow/ }));
    await userEvent.type(screen.getByLabelText("Name"), "Get or create contact");
    expect(screen.getByRole("alert").textContent).toMatch(/no sub-flow trigger/);
    expect(
      (screen.getByRole("button", { name: "Create and open editor" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("creates a sub-flow with the sub-flow trigger", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: /^Sub-flow/ }));
    expect(screen.getByRole("heading", { name: "New sub-flow" })).toBeTruthy();
    // One sub-flow trigger: nothing to pick.
    expect(screen.queryByText("Starts when")).toBeNull();

    await userEvent.type(screen.getByLabelText("Name"), "Get or create contact");
    await userEvent.click(screen.getByRole("button", { name: "Create and open editor" }));
    await waitFor(() => expect(saveWorkflow).toHaveBeenCalled());
    expect(saveWorkflow.mock.calls[0]?.[0]).toEqual({
      id: "get-or-create-contact",
      name: "Get or create contact",
      trigger: { type: "core.subflow", config: { input: [], output: [] } },
      steps: [],
    });
  });
});

describe("slugify (L16)", () => {
  it("cuts a long name at a word boundary, never mid-word", () => {
    expect(slugify("Big deal alert!")).toBe("big-deal-alert");
    const id = slugify("Notify the account owner when an enterprise deal moves to negotiation");
    expect(id).toBe("notify-the-account-owner-when-an-enterprise-deal");
    expect(id.length).toBeLessThanOrEqual(48);
    expect(slugify("x".repeat(60))).toBe("x".repeat(48));
    // Exactly 48 with the next word right after: kept whole.
    expect(slugify(`${"a".repeat(48)} b`)).toBe("a".repeat(48));
  });
});
