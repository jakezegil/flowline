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

  test("truncates option text past 60 characters with an ellipsis", () => {
    const longEventsTrigger = {
      ...(singleEvent as NonNullable<typeof singleEvent>),
      type: "crm.longEvents",
      name: "A trigger with a rather long name for this test",
      event: undefined,
      events: ["some_long_event_name.happened", "another_long_event_name.happened"],
    };
    const withLongEvents: Manifest = {
      ...manifest,
      triggers: [longEventsTrigger, ...restTriggers],
    };
    setup(withLongEvents, "crm.longEvents");
    const select = screen.getByRole("combobox", { name: "Trigger type" }) as HTMLSelectElement;
    const option = Array.from(select.options).find((o) => o.value === "crm.longEvents");
    const full = `${longEventsTrigger.name} — ${longEventsTrigger.events.join(", ")}`;
    expect(full.length).toBeGreaterThan(60);
    expect(option?.textContent).toHaveLength(60);
    expect(option?.textContent).toBe(`${full.slice(0, 59)}…`);
  });
});

const pollTrigger = {
  ...(manifest.triggers[0] as NonNullable<(typeof manifest.triggers)[0]>),
  type: "crm.dealStuckInStage",
  name: "Deal stuck in stage",
  kind: "poll" as const,
  event: undefined,
  interval: 300_000,
  config: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { days: { type: "number", default: 3, "x-flowline": { label: "Days in stage" } } },
  },
};

const withPoll: Manifest = {
  ...manifest,
  triggers: [pollTrigger, ...manifest.triggers.slice(1)],
};

describe("TriggerConfigure: poll triggers", () => {
  test("shows the poll hint and the config form, not a webhook URL or event callout", () => {
    setup(withPoll, "crm.dealStuckInStage");
    expect(screen.getByText("Checks every 5 minutes")).toBeTruthy();
    expect(screen.queryByText(/webhook/i)).toBeNull();
    expect(screen.queryByText(/Runs every time the/)).toBeNull();
    expect(screen.getByLabelText("Days in stage")).toBeTruthy();
  });
});
