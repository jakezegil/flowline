import type { Manifest } from "@flowlinejs/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { fixtureDoc, manifest } from "../../test/fixtures";
import { FlowlineProvider } from "../provider";
import { createEditorStore, TRIGGER_KEY } from "../store/editor-store";
import { ConfigPanel } from "./config-panel";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const [singleEvent, ...restTriggers] = manifest.triggers;

const multiEventTrigger = {
  ...(singleEvent as NonNullable<typeof singleEvent>),
  type: "crm.callEnded",
  name: "Any call ended",
  event: undefined,
  events: ["ai_call.ended", "voip_call.ended"],
};

const withMultiEvent: Manifest = {
  ...manifest,
  triggers: [multiEventTrigger, ...restTriggers],
};

function setup(manifestOverride: Manifest, triggerType: string) {
  const doc = fixtureDoc();
  const store = createEditorStore({
    doc: { ...doc, trigger: { ...doc.trigger, type: triggerType, config: {} } },
    manifest: manifestOverride,
  });
  store.getState().select(TRIGGER_KEY);
  const utils = render(
    <FlowlineProvider client={mockClient()}>
      <ConfigPanel store={store} />
    </FlowlineProvider>,
  );
  return { store, ...utils };
}

describe("TriggerConfigure: multi-event triggers", () => {
  test("shows the multi-event callout listing every event, not the single-event hint", () => {
    const { container } = setup(withMultiEvent, "crm.callEnded");
    const callout = container.querySelector(".fl-callout");
    expect(callout?.textContent).toContain("ai_call.ended");
    expect(callout?.textContent).toContain("voip_call.ended");
    expect(callout?.textContent).toMatch(/normalized/i);
    expect(screen.queryByText(/Runs every time the/)).toBeNull();
  });

  test("a single-event trigger is unchanged: shows the single-event hint, not the multi-event callout", () => {
    setup(manifest, "crm.contactCreated");
    expect(screen.getByText(/Runs every time the contact\.created event happens/)).toBeTruthy();
    expect(screen.queryByText(/normalized/i)).toBeNull();
  });

  test("the trigger type select's option text includes the event names for a multi-event trigger", () => {
    setup(withMultiEvent, "crm.callEnded");
    const select = screen.getByRole("combobox", { name: "Trigger type" }) as HTMLSelectElement;
    const option = Array.from(select.options).find((o) => o.value === "crm.callEnded");
    expect(option?.textContent).toContain("ai_call.ended");
    expect(option?.textContent).toContain("voip_call.ended");
  });

  test("the trigger type select's option text includes the event name for a single-event trigger", () => {
    setup(manifest, "crm.contactCreated");
    const select = screen.getByRole("combobox", { name: "Trigger type" }) as HTMLSelectElement;
    const option = Array.from(select.options).find((o) => o.value === "crm.contactCreated");
    expect(option?.textContent).toContain("contact.created");
  });
});
