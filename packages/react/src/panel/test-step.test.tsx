import type { WorkflowDoc } from "@flowkit/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { EditorContext } from "../hooks";
import { FlowkitProvider } from "../provider";
import { createEditorStore, TRIGGER_KEY } from "../store/editor-store";
import { TestStep } from "./test-step";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const doc = (): WorkflowDoc =>
  docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    step("email", "crm.sendEmail", { to: { $ref: "steps.load.email" }, subject: "Hi" }),
  ]);

function setup(stepId: string, client = mockClient(), d = doc()) {
  const store = createEditorStore({ doc: d, manifest });
  render(
    <FlowkitProvider client={client}>
      <EditorContext.Provider value={store}>
        <TestStep stepId={stepId} />
      </EditorContext.Provider>
    </FlowkitProvider>,
  );
  return { store, client };
}

describe("TestStep", () => {
  test("a successful test shows the output and keeps it as the step's sample", async () => {
    const client = mockClient({
      testStep: async () => ({
        ok: true,
        output: { id: "c1", email: "ada@x.test" },
        durationMs: 42,
      }),
    });
    const { store } = setup("load", client);
    store.getState().setSample(TRIGGER_KEY, { contactId: "c1" });
    expect(screen.getByText("Not tested yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test step" }));
    const output = await screen.findByRole("region", { name: "Output" });
    expect(within(output).getByText(/ada@x\.test/)).toBeTruthy();
    expect(within(output).getByText("Took 42ms")).toBeTruthy();
    expect(store.getState().samples.load).toEqual({ id: "c1", email: "ada@x.test" });
    expect(store.getState().testState.load).toBe("tested");
    expect(screen.getByText("Tested")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test again" })).toBeTruthy();

    // The request carries the step, the doc and the samples, the trigger's apart.
    expect(client.testStep).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({ id: "load" }),
        doc: expect.objectContaining({ id: "welcome" }),
        triggerSample: { contactId: "c1" },
        samples: {},
      }),
    );
  });

  test("the input preview resolves references against the samples", () => {
    const { store } = setup("email");
    store.getState().setSample("load", { email: "ada@x.test" });
    const input = screen.getByRole("region", { name: "Input" });
    return waitFor(() => expect(within(input).getByText(/ada@x\.test/)).toBeTruthy());
  });

  test("a failing step shows its error and keeps no sample", async () => {
    const client = mockClient({
      testStep: async () => ({ ok: false, error: "Mailbox unavailable", durationMs: 9 }),
    });
    const { store } = setup("email", client);
    fireEvent.click(screen.getByRole("button", { name: "Test step" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Mailbox unavailable");
    expect(screen.getByRole("region", { name: "Error" })).toBeTruthy();
    expect(store.getState().samples.email).toBeUndefined();
  });

  test("a request that fails is reported as such", async () => {
    const client = mockClient({ testStep: async () => Promise.reject(new Error("Network down")) });
    setup("email", client);
    fireEvent.click(screen.getByRole("button", { name: "Test step" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The test couldn't run. Network down");
  });

  test("warns about untested upstream steps and links to them", () => {
    const { store } = setup("email");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Test first: Load contact.");
    fireEvent.click(within(note).getByRole("button", { name: "Load contact" }));
    expect(store.getState().selection).toBe("load");
  });

  test("a missing trigger sample links to the trigger", () => {
    const { store } = setup("load");
    const note = screen.getByRole("note");
    fireEvent.click(within(note).getByRole("button", { name: "Add trigger sample" }));
    expect(store.getState().selection).toBe(TRIGGER_KEY);
  });

  test("a sample from a different step type needs a re-test", async () => {
    const d = docWith([step("x", "crm.loadContact", { contactId: "c1" })]);
    const { store } = setup("x", mockClient(), d);
    store.getState().setSample("x", { id: "c1" });
    await screen.findByText("Tested");
    store.getState().replaceStep("x", "crm.sendEmail");
    expect(await screen.findByText("Needs re-test")).toBeTruthy();
    expect(screen.getByText("The step's type changed since its last test.")).toBeTruthy();
  });
});
