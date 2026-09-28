import type { WorkflowDetail, WorkflowDoc } from "@flowline/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { httpError, mockClient, setupDom } from "../../test/dom";
import { docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import { FlowlineProvider } from "../provider";
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
    <FlowlineProvider client={client}>
      <div style={{ height: 800 }}>
        <WorkflowEditor
          workflowId={doc?.id ?? "welcome"}
          onPublish={onPublish}
          onSaved={onSaved}
          onRunStarted={onRunStarted}
          initialDoc={docWith([], "welcome")}
        />
      </div>
    </FlowlineProvider>,
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
    await screen.findByText("Published v5", { selector: ".fl-status" });
    expect(screen.getByText("Published v5", { selector: ".fl-toast__message" })).toBeTruthy();
    expect(client.publish).toHaveBeenCalledWith("welcome", 5);
    expect(onPublish).toHaveBeenCalledWith(5);
    expect(button("Publish").getAttribute("aria-disabled")).toBe("true");
  });

  test("a publish rejected by the server shows its issues in a toast", async () => {
    const { client } = setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    const issue = { code: "x", message: "Server says no", severity: "error", stepId: "email" };
    // Malformed entries aren't counted (Minor 3).
    client.publish.mockRejectedValue(
      httpError(422, { error: "Invalid", issues: [{}, issue, { ...issue, stepId: "load" }] }),
    );
    fireEvent.click(button("Publish"));
    await screen.findByText("Publishing was blocked by 2 issues");
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  test("Minor 4: a save rejected by the server shows its issues like a publish", async () => {
    const { client } = setup(fixtureDoc());
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    fireEvent.change(name, { target: { value: "Onboarding" } });
    fireEvent.blur(name);
    const before = screen.queryByRole("button", { name: /issue/ })?.textContent ?? "";
    const issue = { code: "x", message: "Server says no", severity: "error", stepId: "email" };
    client.saveWorkflow.mockRejectedValue(httpError(422, { error: "Invalid", issues: [issue] }));
    fireEvent.click(button("Save"));
    await screen.findByText("Saving was blocked by 1 issue");
    const pill = await screen.findByRole("button", { name: /\d+ issues?/ });
    expect(pill.textContent).not.toBe(before);
    fireEvent.click(button("Show"));
    await waitFor(() => expect(selectedId()).toBe("step:email"));
  });

  test("Minor 12: Enter in the name box commits and keeps focus there", async () => {
    setup(fixtureDoc());
    const name = (await screen.findByRole("textbox", {
      name: "Workflow name",
    })) as HTMLInputElement;
    name.focus();
    fireEvent.change(name, { target: { value: "Onboarding" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("Onboarding");
  });

  test("Show on a server rejection selects the step the server flagged", async () => {
    const { client } = setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    const issue = { code: "x", message: "Server says no", severity: "error", stepId: "email" };
    client.publish.mockRejectedValue(httpError(422, { error: "Invalid", issues: [issue] }));
    fireEvent.click(button("Publish"));
    await screen.findByText("Publishing was blocked by 1 issue");
    fireEvent.click(button("Show"));
    await waitFor(() => expect(selectedId()).toBe("step:email"));
  });

  test("M17: URL fields warn about hosts the engine blocks, per the network prop", async () => {
    const fetchNode = {
      ...(manifest.nodes[0] as (typeof manifest.nodes)[number]),
      type: "test.fetch",
      name: "Fetch",
      summary: undefined,
      input: {
        type: "object",
        properties: { url: { type: "string", "x-flowline": { label: "URL", outboundUrl: true } } },
      },
    };
    const m = { ...manifest, nodes: [...manifest.nodes, fetchNode] };
    const doc = docWith([step("fetch", "test.fetch", { url: "http://localhost:8911/x" })]);
    const view = (network?: { allowPrivateNetworks: boolean }) => (
      <FlowlineProvider
        client={mockClient({
          getManifest: async () => m,
          listSubflows: async () => [],
          getWorkflow: async () => detail(doc),
        })}
      >
        <div style={{ height: 800 }}>
          <WorkflowEditor workflowId={doc.id} {...(network ? { network } : {})} />
        </div>
      </FlowlineProvider>
    );
    const { unmount } = render(view());
    await screen.findByText("Draft · v3");
    expect((await screen.findByRole("button", { name: /1 issue/ })).textContent).toContain("1");
    unmount();
    render(view({ allowPrivateNetworks: true }));
    await screen.findByText("Draft · v3");
    expect(screen.queryByRole("button", { name: /issue/ })).toBeNull();
  });

  test("M7: a server rejection's issues show on the pill, the step and its field", async () => {
    const { client } = setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    const before = screen.queryByRole("button", { name: /issue/ })?.textContent ?? "";
    const issue = {
      code: "config.invalid",
      message: "Subject is too long for the mail server",
      severity: "error",
      stepId: "email",
      field: "subject",
    };
    client.publish.mockRejectedValue(httpError(422, { error: "Invalid", issues: [issue] }));
    fireEvent.click(button("Publish"));
    await screen.findByText("Publishing was blocked by 1 issue");
    const pill = await screen.findByRole("button", { name: /\d+ issues?/ });
    expect(pill.textContent).not.toBe(before);
    fireEvent.click(button("Show"));
    const field = (await screen.findByRole("textbox", { name: "Subject" })).closest(
      ".fl-f",
    ) as HTMLElement;
    expect(field.textContent).toContain("Subject is too long for the mail server");
    // Publishing stays blocked until the flagged step changes.
    expect(button("Publish").getAttribute("aria-disabled")).toBe("true");
  });

  test('M3: a new workflow\'s pill reads "Add a first step" and opens the picker at the "+"', async () => {
    setup(null);
    const pill = await screen.findByRole("button", { name: "Add a first step" });
    const plus = screen.getByRole("button", { name: "Add first step" });
    fireEvent.click(pill);
    expect(plus.hasAttribute("data-pulse")).toBe(true);
    expect(await screen.findByRole("dialog", { name: "Add step" })).toBeTruthy();
    // Nothing selected: the trigger has no issue to show.
    expect(screen.queryByRole("complementary", { name: "Step settings" })).toBeNull();
  });

  test("H2: onDirtyChange reports unsaved changes, for the host's router guard", async () => {
    const onDirtyChange = vi.fn();
    const client = mockClient({
      getManifest: async () => manifest,
      listSubflows: async () => [],
      getWorkflow: async () => detail(fixtureDoc()),
    });
    const { unmount } = render(
      <FlowlineProvider client={client}>
        <WorkflowEditor workflowId="welcome" onDirtyChange={onDirtyChange} />
      </FlowlineProvider>,
    );
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(name, { target: { value: "Changed" } });
    fireEvent.blur(name);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    client.saveWorkflow.mockImplementation(async (doc: WorkflowDoc) => detail(doc, 4).latest);
    fireEvent.click(button("Save"));
    await screen.findByText("Draft · v4");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(name, { target: { value: "Again" } });
    fireEvent.blur(name);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  test("L18: a server that can't be reached is said in plain words", async () => {
    const { client } = setup(fixtureDoc());
    await screen.findByText("Draft · v3");
    client.saveWorkflow.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(button("Save"));
    expect(
      await screen.findByText(
        "Couldn't save. The server can't be reached. Check your connection, then try again.",
      ),
    ).toBeTruthy();
  });

  test("Publish stays busy while it saves first", async () => {
    const { client } = setup(fixtureDoc());
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.blur(name);
    let finishSave: (v: unknown) => void = () => {};
    client.saveWorkflow.mockImplementation(() => new Promise((r) => (finishSave = r)));
    client.publish.mockResolvedValue(undefined);
    fireEvent.click(button("Publish"));
    await screen.findByText("Publishing…");
    expect(screen.queryByText("Saving…")).toBeNull();
    await act(async () => {
      finishSave({ ...detail(fixtureDoc(), 4).latest });
    });
    await screen.findByText("Published v4", { selector: ".fl-status" });
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
    expect(await screen.findByText("Required", { selector: ".fl-field__error" })).toBeTruthy();
    fireEvent.change(dialog.querySelector("input") as HTMLInputElement, {
      target: { value: "ada@example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    });
    expect(client.runWorkflow).toHaveBeenCalledWith("welcome", { email: "ada@example.com" });
    expect(onRunStarted).toHaveBeenCalledWith("r9");
  });

  test("L15: a list field's placeholder shows a JSON list, an object field's an object", async () => {
    const doc: WorkflowDoc = {
      ...fixtureDoc(),
      trigger: {
        type: "logic.manual",
        config: {
          fields: [
            { name: "tags", type: "array" },
            { name: "meta", type: "object" },
          ],
        },
      },
      steps: [],
    };
    setup(doc, { published: 3 });
    await screen.findByText("Published v3");
    fireEvent.click(button("Run"));
    await screen.findByRole("dialog", { name: "Run workflow" });
    expect(screen.getByLabelText("tags").getAttribute("placeholder")).toBe(
      'A JSON list, e.g. ["gold", "silver"]',
    );
    expect(screen.getByLabelText("meta").getAttribute("placeholder")).toBe("JSON, e.g. {}");
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
