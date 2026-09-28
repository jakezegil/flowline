import type { WorkflowDetail, WorkflowDoc } from "@flowkit/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { httpError, mockClient, setupDom } from "../../test/dom";
import { docWith, fixtureDoc, manifest } from "../../test/fixtures";
import { FlowkitProvider } from "../provider";
import { WorkflowEditor } from "./workflow-editor";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function detail(doc: WorkflowDoc): WorkflowDetail {
  const v = { workflowId: doc.id, tenantId: "t", version: 2, doc, createdBy: "u", createdAt: 0 };
  return { latest: v, published: null };
}

function setup(
  doc: WorkflowDoc | null,
  props: Partial<ComponentProps<typeof WorkflowEditor>> = {},
) {
  const client = mockClient({
    getManifest: async () => manifest,
    listSubflows: async () => [],
    getWorkflow: async () => {
      if (!doc) throw httpError(404, { error: "Workflow not found" });
      return detail(doc);
    },
  });
  render(
    <FlowkitProvider client={client}>
      <div style={{ height: 800 }}>
        <WorkflowEditor workflowId="leads" {...props} />
      </div>
    </FlowkitProvider>,
  );
  return { client };
}

const nameField = () => screen.findByRole("textbox", { name: "Workflow name" });

describe("WorkflowEditor: missing and new workflows", () => {
  test("a workflow that doesn't exist shows Workflow not found, not a blank draft", async () => {
    setup(null);
    expect(await screen.findByText("Workflow not found")).toBeTruthy();
    expect(screen.getByText("There is no workflow with the ID “leads”.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Workflow name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test("by default it offers Go back (to the previous page), not Create", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const length = vi.spyOn(window.history, "length", "get").mockReturnValue(3);
    setup(null);
    fireEvent.click(await screen.findByRole("button", { name: "Go back" }));
    expect(back).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create this workflow" })).toBeNull();
    cleanup();
    // Nowhere to go back to: no action.
    length.mockReturnValue(1);
    setup(null);
    expect(await screen.findByText("Workflow not found")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    vi.restoreAllMocks();
  });

  test('notFoundAction="create" offers Create this workflow: a blank draft under that ID', async () => {
    const { client } = setup(null, { notFoundAction: "create" });
    fireEvent.click(await screen.findByRole("button", { name: "Create this workflow" }));
    const name = (await nameField()) as HTMLInputElement;
    expect(name.value).toBe("Untitled workflow");
    expect(screen.getByText("Draft")).toBeTruthy();
    // Create mode: the missing workflow isn't asked for again.
    expect(client.getWorkflow).toHaveBeenCalledTimes(1);
    client.saveWorkflow.mockImplementation(async (doc: WorkflowDoc) => detail(doc).latest);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Draft · v2");
    // The first save creates it (only if the ID is still free).
    expect(client.saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: "leads" }), {
      create: true,
    });
    // Later saves are ordinary new versions.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.saveWorkflow).toHaveBeenCalledTimes(2));
    expect(client.saveWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({ id: "leads" }));
  });

  test("create mode never overwrites a workflow that exists: the save fails with a conflict", async () => {
    const { client } = setup(null, { create: true });
    await nameField();
    client.saveWorkflow.mockRejectedValue(
      httpError(409, { error: 'Workflow "leads" already exists', code: "workflow_exists" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Couldn't save\..*already exists/)).toBeTruthy();
    expect(client.saveWorkflow).toHaveBeenCalledWith(expect.anything(), { create: true });
    // Still an unsaved draft: nothing was written.
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  test("the host's action replaces it; null offers none", async () => {
    const back = vi.fn();
    setup(null, { notFoundAction: { label: "Back to workflows", onClick: back } });
    fireEvent.click(await screen.findByRole("button", { name: "Back to workflows" }));
    expect(back).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create this workflow" })).toBeNull();
    cleanup();
    setup(null, { notFoundAction: null });
    expect(await screen.findByText("Workflow not found")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("create mode doesn't request the workflow and starts from initialDoc", async () => {
    const { client } = setup(null, { create: true, initialDoc: docWith([], "leads") });
    const name = (await nameField()) as HTMLInputElement;
    expect(name.value).toBe(docWith([], "leads").name);
    expect(client.getWorkflow).not.toHaveBeenCalled();
    expect(client.getManifest).toHaveBeenCalled();
  });

  test("create mode without initialDoc starts a blank manual workflow", async () => {
    const { client } = setup(null, { create: true });
    expect(((await nameField()) as HTMLInputElement).value).toBe("Untitled workflow");
    expect(client.getWorkflow).not.toHaveBeenCalled();
  });

  test("a workflow that exists still loads as before", async () => {
    setup(fixtureDoc());
    expect(((await nameField()) as HTMLInputElement).value).toBe("Welcome");
    expect(screen.queryByText("Workflow not found")).toBeNull();
  });
});
