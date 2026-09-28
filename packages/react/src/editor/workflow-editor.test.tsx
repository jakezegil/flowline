import type { WorkflowDetail, WorkflowDoc } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { httpError, mockClient, setupDom } from "../../test/dom";
import { docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import { FlowkitProvider } from "../provider";
import { WorkflowEditor } from "./workflow-editor";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function detail(doc: WorkflowDoc, version = 3, published: number | null = null): WorkflowDetail {
  const v = (n: number) => ({
    workflowId: doc.id,
    tenantId: "t",
    version: n,
    doc,
    createdBy: "u",
    createdAt: 0,
  });
  return { latest: v(version), published: published === null ? null : v(published) };
}

function setup(doc: WorkflowDoc | null, opts: { published?: number | null } = {}) {
  const client = mockClient({
    getManifest: async () => manifest,
    listSubflows: async () => [],
    getWorkflow: async () => {
      if (!doc) throw httpError(404, { error: "Not found" });
      return detail(doc, 3, opts.published ?? null);
    },
  });
  const onPublish = vi.fn();
  const onSaved = vi.fn();
  const onRunStarted = vi.fn();
  const utils = render(
    <FlowkitProvider client={client}>
      <div style={{ height: 800 }}>
        <WorkflowEditor
          workflowId={doc?.id ?? "welcome"}
          onPublish={onPublish}
          onSaved={onSaved}
          onRunStarted={onRunStarted}
          initialDoc={docWith([], "welcome")}
        />
      </div>
    </FlowkitProvider>,
  );
  return { client, onPublish, onSaved, onRunStarted, ...utils };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const selectedId = () =>
  document.querySelector(".react-flow__node.selected")?.getAttribute("data-id") ?? null;

/** Two steps with required-field errors (email has no `to`, email2 neither). */
function invalidDoc(): WorkflowDoc {
  return docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    step("email", "crm.sendEmail", { subject: "Hi" }),
    step("email2", "crm.sendEmail", { subject: "Hey" }),
  ]);
}

describe("WorkflowEditor", () => {
  test("loads the workflow and shows its name and saved version", async () => {
    setup(fixtureDoc());
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    expect((name as HTMLInputElement).value).toBe("Welcome");
    expect(screen.getByText("Draft · v3")).toBeTruthy();
  });

  test("a workflow that doesn't exist yet starts from initialDoc", async () => {
    const { client } = setup(null);
    await screen.findByRole("textbox", { name: "Workflow name" });
    expect(client.getWorkflow).toHaveBeenCalledWith("welcome");
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  test("publish is disabled while the workflow has errors", async () => {
    const { client } = setup(invalidDoc());
    await screen.findByText("Draft · v3");
    const publish = button("Publish");
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publish);
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  test("Save sends the edited doc and records the new version", async () => {
    const { client, onSaved } = setup(fixtureDoc());
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    fireEvent.change(name, { target: { value: "Onboarding" } });
    fireEvent.blur(name);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    client.saveWorkflow.mockImplementation(async (doc: WorkflowDoc) => ({
      ...detail(doc, 4).latest,
    }));
    fireEvent.click(button("Save"));
    await screen.findByText("Draft · v4");
    expect(client.saveWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "welcome", name: "Onboarding" }),
    );
    expect(onSaved).toHaveBeenCalledWith(4);
    expect(screen.getByText("Saved as v4")).toBeTruthy();
  });

  test("⌘S / Ctrl+S saves", async () => {
    const { client } = setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    client.saveWorkflow.mockImplementation(async (doc: WorkflowDoc) => detail(doc, 4).latest);
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    await screen.findByText("Draft · v4");
  });

  test("the issues pill cycles the selection through steps with issues", async () => {
    setup(invalidDoc());
    const pill = await screen.findByRole("button", { name: "2 issues" });
    fireEvent.click(pill);
    await waitFor(() => expect(selectedId()).toBe("step:email"));
    fireEvent.click(pill);
    await waitFor(() => expect(selectedId()).toBe("step:email2"));
    fireEvent.click(pill);
    await waitFor(() => expect(selectedId()).toBe("step:email"));
    // The side panel opens for the selection and closes with it.
    expect(screen.getByRole("complementary", { name: "Step settings" })).toBeTruthy();
    fireEvent.click(button("Close panel"));
    expect(screen.queryByRole("complementary", { name: "Step settings" })).toBeNull();
  });

  test("Publish saves unsaved changes first, then publishes that version", async () => {
    const { client, onPublish } = setup(fixtureDoc(), { published: 2 });
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.blur(name);
    client.saveWorkflow.mockImplementation(async (doc: WorkflowDoc) => detail(doc, 5).latest);
    client.publish.mockResolvedValue(undefined);
    fireEvent.click(button("Publish"));
    // The status chip and the toast both say so.
    await screen.findByText("Published v5", { selector: ".fk-status" });
    expect(screen.getByText("Published v5", { selector: ".fk-toast__message" })).toBeTruthy();
    expect(client.publish).toHaveBeenCalledWith("welcome", 5);
    expect(onPublish).toHaveBeenCalledWith(5);
    expect(button("Publish").getAttribute("aria-disabled")).toBe("true");
  });

  test("a publish rejected by the server shows its issues in a toast", async () => {
    const { client } = setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    client.publish.mockRejectedValue(httpError(422, { error: "Invalid", issues: [{}, {}] }));
    fireEvent.click(button("Publish"));
    await screen.findByText("Publishing was blocked by 2 issues");
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  test("Run asks for the manual trigger's fields and starts a run", async () => {
    const doc: WorkflowDoc = {
      ...fixtureDoc(),
      trigger: {
        type: "logic.manual",
        config: { fields: [{ name: "email", type: "string", required: true }] },
      },
      steps: [],
    };
    const { client, onRunStarted } = setup(doc, { published: 3 });
    await screen.findByText("Published v3");
    client.runWorkflow.mockResolvedValue({ runId: "r9" });
    fireEvent.click(button("Run"));
    const dialog = await screen.findByRole("dialog", { name: "Run workflow" });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByText("Required", { selector: ".fk-field__error" })).toBeTruthy();
    fireEvent.change(dialog.querySelector("input") as HTMLInputElement, {
      target: { value: "ada@example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    });
    expect(client.runWorkflow).toHaveBeenCalledWith("welcome", { email: "ada@example.com" });
    expect(onRunStarted).toHaveBeenCalledWith("r9");
  });

  test("Run is only offered for manual triggers", async () => {
    setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  test("warns before unload while there are unsaved changes", async () => {
    setup(fixtureDoc());
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(name, { target: { value: "Changed" } });
    fireEvent.blur(name);
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
