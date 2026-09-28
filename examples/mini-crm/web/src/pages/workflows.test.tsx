// @vitest-environment jsdom
import type { Manifest, WorkflowDoc } from "@flowkit/core";
import { createClient } from "@flowkit/core/client";
import { FlowkitProvider } from "@flowkit/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const saveWorkflow = vi.fn(async (_doc: WorkflowDoc) => ({}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  flowkit: { saveWorkflow: (doc: WorkflowDoc) => saveWorkflow(doc) },
}));

const { NewWorkflowDialog, triggersFor } = await import("./workflows");

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
    <FlowkitProvider client={createClient({ baseUrl: "/flowkit" })}>
      <MemoryRouter>
        <NewWorkflowDialog open onClose={() => {}} manifest={MANIFEST} taken={new Set()} />
      </MemoryRouter>
    </FlowkitProvider>,
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

  it("explains both choices and starts a workflow from the first trigger", async () => {
    renderDialog();
    const workflow = screen.getByRole("radio", { name: /^Workflow\s*Runs on its own/ });
    expect((workflow as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /^Sub-flow\s*A reusable piece/ })).toBeTruthy();
    expect((screen.getByRole("radio", { name: /^Webhook/ }) as HTMLInputElement).checked).toBe(
      true,
    );

    await userEvent.type(screen.getByLabelText("Name"), "Big deal alert");
    await userEvent.click(screen.getByRole("button", { name: "Create and open editor" }));
    await waitFor(() => expect(saveWorkflow).toHaveBeenCalled());
    expect(saveWorkflow.mock.calls[0]?.[0]).toMatchObject({
      id: "big-deal-alert",
      trigger: { type: "core.webhook" },
    });
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
