import type { AnnotationColor, Step, WorkflowDoc } from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setupDom } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { createAgentBridge } from "../agent-bridge";
import { defaultLabels } from "../labels";
import { layoutTree } from "../layout/layout-tree";
import { createEditorStore, type EditorStore } from "../store/editor-store";
import { WorkflowCanvas } from "./workflow-canvas";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const node = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
};

/** load → [intro section: email, email2] → cond(if: [branch section: tag], else: []) */
function annotatedDoc(
  opts: { color?: string; note?: string; stepNote?: string; stepColor?: AnnotationColor } = {},
): WorkflowDoc {
  const email: Step = step("email", "crm.sendEmail", { to: "a@b.c", subject: "Hi" });
  if (opts.stepNote !== undefined) email.note = opts.stepNote;
  if (opts.stepColor) email.color = opts.stepColor;
  const doc = docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    email,
    step("email2", "crm.sendEmail", { to: "a@b.c", subject: "Hey" }),
    step(
      "cond",
      "logic.condition",
      { value: true },
      {
        branches: {
          if: [step("tag", "crm.sendEmail", { to: "a@b.c", subject: "Tag" })],
          else: [],
        },
      },
    ),
  ]);
  doc.sections = [
    {
      id: "intro",
      title: "Welcome sequence",
      color: (opts.color ?? "blue") as AnnotationColor,
      first: "email",
      last: "email2",
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    },
    { id: "branchy", title: "Tagging", color: "green", first: "tag", last: "tag" },
  ];
  return doc;
}

/** Ends a CSS animation. React listens for the name the environment supports (jsdom: prefixed). */
function endAnimation(el: HTMLElement) {
  act(() => {
    for (const type of ["animationend", "webkitAnimationEnd"]) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
  });
}

const storeOf = (doc: WorkflowDoc, readOnly = false): EditorStore =>
  createEditorStore({ doc, manifest, readOnly });

describe("canvas annotations", () => {
  test("a section renders a group named by its title, behind the cards", () => {
    render(<WorkflowCanvas store={storeOf(annotatedDoc())} />);
    const region = screen.getByRole("group", {
      name: defaultLabels.sectionRegion("Welcome sequence"),
    });
    expect(region.dataset.color).toBe("blue");
    expect(
      screen.getByRole("group", { name: defaultLabels.sectionRegion("Tagging") }),
    ).toBeTruthy();
    const wrapper = node("section:intro");
    expect(wrapper.style.zIndex).toBe("-1");
    expect(wrapper.getAttribute("tabindex")).toBeNull();
    expect(wrapper.classList.contains("selectable")).toBe(false);
  });

  test("the header chip is a focusable button with the title and a note excerpt", () => {
    const note = `Sent over the first week. ${"x".repeat(200)}`;
    render(<WorkflowCanvas store={storeOf(annotatedDoc({ note }))} />);
    const chip = within(node("sectionHeader:intro")).getByRole("button");
    expect(chip.textContent).toContain("Welcome sequence");
    expect(chip.getAttribute("aria-label")).toBe(
      defaultLabels.sectionHeader("Welcome sequence", note),
    );
    const excerpt = chip.querySelector(".fl-section-chip__note") as HTMLElement;
    expect(excerpt.textContent?.length).toBeLessThanOrEqual(61);
    expect(excerpt.textContent?.startsWith("Sent over the first week.")).toBe(true);
    expect(chip.getAttribute("title")).toBe(note);
    chip.focus();
    expect(document.activeElement).toBe(chip);
    // No note: just the title.
    cleanup();
    render(<WorkflowCanvas store={storeOf(annotatedDoc())} />);
    const plain = within(node("sectionHeader:intro")).getByRole("button");
    expect(plain.querySelector(".fl-section-chip__note")).toBeNull();
    expect(plain.getAttribute("aria-label")).toBe("Welcome sequence");
  });

  test("a step note renders a focusable node named Note: …, and the card's name includes it", () => {
    const note = "Double-check the subject line with marketing before launch.";
    render(<WorkflowCanvas store={storeOf(annotatedDoc({ stepNote: note }))} />);
    const noteNode = node("note:email");
    expect(noteNode.getAttribute("aria-label")).toBe(defaultLabels.noteLabel(note));
    expect(noteNode.getAttribute("aria-label")).toMatch(/^Note: Double-check/);
    expect(noteNode.getAttribute("tabindex")).toBe("0");
    const text = noteNode.querySelector(".fl-note__text") as HTMLElement;
    expect(text.textContent).toBe(note);
    expect(noteNode.querySelector(".fl-note")?.getAttribute("title")).toBe(note);
    expect(node("step:email").getAttribute("aria-label")).toBe(
      defaultLabels.stepWithNote("Send email", note),
    );
    // Yellow by default, else the step's colour.
    expect(noteNode.querySelector(".fl-note")?.getAttribute("data-color")).toBe("yellow");
  });

  test('color: "pink" sets data-color on the card and tints its note', () => {
    render(
      <WorkflowCanvas store={storeOf(annotatedDoc({ stepColor: "pink", stepNote: "hello" }))} />,
    );
    expect(node("step:email").querySelector(".fl-card")?.getAttribute("data-color")).toBe("pink");
    expect(node("step:email2").querySelector(".fl-card")?.hasAttribute("data-color")).toBe(false);
    expect(node("note:email").querySelector(".fl-note")?.getAttribute("data-color")).toBe("pink");
  });

  test('an unknown colour ("red") draws gray', () => {
    const doc = annotatedDoc({ color: "red" });
    const email = doc.steps[1] as Step;
    email.color = "red" as AnnotationColor;
    email.note = "n";
    render(<WorkflowCanvas store={storeOf(doc)} />);
    const region = screen.getByRole("group", {
      name: defaultLabels.sectionRegion("Welcome sequence"),
    });
    expect(region.dataset.color).toBe("gray");
    expect(
      node("sectionHeader:intro").querySelector("[data-color]")?.getAttribute("data-color"),
    ).toBe("gray");
    expect(node("step:email").querySelector(".fl-card")?.getAttribute("data-color")).toBe("gray");
    expect(node("note:email").querySelector(".fl-note")?.getAttribute("data-color")).toBe("gray");
  });

  test("read-only: data-readonly, and no buttons in the chip or the note", () => {
    const store = storeOf(annotatedDoc({ note: "Section note", stepNote: "Step note" }), true);
    render(<WorkflowCanvas store={store} />);
    expect(document.querySelector(".fl-canvas")?.hasAttribute("data-readonly")).toBe(true);
    const header = node("sectionHeader:intro");
    const noteNode = node("note:email");
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
    expect(within(noteNode).queryAllByRole("button")).toHaveLength(0);
    // Still in the accessibility tree, and reachable.
    expect(header.getAttribute("aria-label")).toBe(
      defaultLabels.sectionHeader("Welcome sequence", "Section note"),
    );
    expect(header.getAttribute("tabindex")).toBe("0");
    expect(noteNode.getAttribute("aria-label")).toBe(defaultLabels.noteLabel("Step note"));
    expect(
      screen.getByRole("group", { name: defaultLabels.sectionRegion("Welcome sequence") }),
    ).toBeTruthy();
  });

  test("the <WorkflowCanvas readOnly> prop renders annotations read-only too", () => {
    render(<WorkflowCanvas store={storeOf(annotatedDoc({ note: "n" }))} readOnly />);
    expect(within(node("sectionHeader:intro")).queryAllByRole("button")).toHaveLength(0);
  });

  test("edges route with the section regions as obstacles", () => {
    // A loop whose body sits in a section: the return route passes left of the region.
    const doc = docWith([
      step(
        "each",
        "logic.forEach",
        { items: [] },
        { branches: { body: [step("inner", "crm.sendEmail", { to: "x", subject: "y" })] } },
      ),
    ]);
    doc.sections = [{ id: "s", title: "Body", color: "purple", first: "inner", last: "inner" }];
    const layout = layoutTree(doc, manifest);
    const region = layout.sections[0]!;
    render(<WorkflowCanvas store={storeOf(doc)} />);
    const path = document
      .querySelector('[data-testid="rf__edge-join:each->step:each"] path')
      ?.getAttribute("d");
    const xs = [...(path ?? "").matchAll(/[MLQ] (-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.min(...xs)).toBeLessThan(region.x);
  });

  test("keys on a focused note don't act on the selected step", () => {
    const store = storeOf(annotatedDoc({ stepNote: "hello" }));
    store.getState().select("load");
    render(<WorkflowCanvas store={store} />);
    const noteNode = node("note:email");
    noteNode.focus();
    fireEvent.keyDown(noteNode, { key: "Delete" });
    fireEvent.keyDown(noteNode, { key: "Backspace" });
    expect(store.getState().doc.steps.map((s) => s.id)).toContain("load");
  });
});

describe("flash", () => {
  test("a bridge apply flashes the changed cards only, once per token", () => {
    const store = storeOf(annotatedDoc());
    render(<WorkflowCanvas store={store} />);
    const bridge = createAgentBridge(store);
    act(() => {
      bridge.apply([{ op: "setConfig", id: "email2", key: "subject", value: "Changed" }]);
    });
    const card = (id: string) => node(`step:${id}`).querySelector(".fl-card") as HTMLElement;
    expect(card("email2").hasAttribute("data-flash")).toBe(true);
    expect(card("email").hasAttribute("data-flash")).toBe(false);
    expect(card("load").hasAttribute("data-flash")).toBe(false);
    // The animation ending clears it, and the same token never flashes again.
    endAnimation(card("email2"));
    expect(card("email2").hasAttribute("data-flash")).toBe(false);
    act(() => store.getState().select("email2"));
    expect(card("email2").hasAttribute("data-flash")).toBe(false);
    // A new apply is a new token.
    act(() => {
      bridge.apply([{ op: "setConfig", id: "email2", key: "subject", value: "Again" }]);
    });
    expect(card("email2").hasAttribute("data-flash")).toBe(true);
  });

  test("a flash from before the canvas mounted doesn't play", () => {
    const store = storeOf(annotatedDoc());
    createAgentBridge(store).apply([
      { op: "setConfig", id: "email2", key: "subject", value: "Changed" },
    ]);
    expect(store.getState().flash?.ids).toEqual(["email2"]);
    render(<WorkflowCanvas store={store} />);
    expect(node("step:email2").querySelector(".fl-card")?.hasAttribute("data-flash")).toBe(false);
  });

  test("an edited section's region flashes", () => {
    const store = storeOf(annotatedDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => {
      createAgentBridge(store).apply([{ op: "updateSection", id: "intro", title: "Renamed" }]);
    });
    const region = screen.getByRole("group", { name: defaultLabels.sectionRegion("Renamed") });
    expect(region.hasAttribute("data-flash")).toBe(true);
    expect(
      screen
        .getByRole("group", { name: defaultLabels.sectionRegion("Tagging") })
        .hasAttribute("data-flash"),
    ).toBe(false);
  });
});

describe("review round 1", () => {
  const card = (id: string) => node(`step:${id}`).querySelector(".fl-card") as HTMLElement;

  test("M1: the header chip ends short of the edge entering the section's first card", () => {
    const doc = annotatedDoc({ note: "A long note that would otherwise run across the edge line" });
    const layout = layoutTree(doc, manifest);
    const ls = layout.sections.find((s) => s.id === "section:intro")!;
    const first = layout.nodes.find((n) => n.id === "step:email")!;
    render(<WorkflowCanvas store={storeOf(doc)} />);
    const width = Number.parseFloat(node("sectionHeader:intro").style.width);
    const chipLeft = ls.x + 16;
    expect(width).toBeGreaterThan(0);
    expect(chipLeft + width).toBeLessThanOrEqual(first.x + first.w / 2 - 8);
  });

  test("M2: a repeated section ID flashes only the section that changed", () => {
    const doc = annotatedDoc();
    doc.sections = [
      { id: "dup", title: "First", color: "blue", first: "load", last: "load" },
      { id: "dup", title: "Second", color: "green", first: "email2", last: "email2" },
    ];
    const store = storeOf(doc);
    render(<WorkflowCanvas store={store} />);
    act(() => {
      createAgentBridge(store).apply([{ op: "updateSection", id: "dup", title: "Renamed" }]);
    });
    const group = (title: string) =>
      screen.getByRole("group", { name: defaultLabels.sectionRegion(title) });
    expect(group("Renamed").hasAttribute("data-flash")).toBe(true);
    expect(group("First").hasAttribute("data-flash")).toBe(false);
  });

  test("M3: a long note's accessible name is capped with an ellipsis", () => {
    const note = `Start ${"word ".repeat(1000)}`;
    render(<WorkflowCanvas store={storeOf(annotatedDoc({ stepNote: note }))} />);
    const name = node("note:email").getAttribute("aria-label") ?? "";
    expect(name.startsWith("Note: Start word")).toBe(true);
    expect(name.length).toBeLessThanOrEqual("Note: ".length + 140);
    expect(name.endsWith("…")).toBe(true);
    // The full text stays on the note.
    expect(node("note:email").querySelector(".fl-note")?.getAttribute("title")).toBe(note);
  });

  test("M4: undo and redo work while a note has focus; Delete still doesn't", () => {
    const store = storeOf(annotatedDoc({ stepNote: "hello" }));
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().renameStep("email2", "Follow-up"));
    act(() => store.getState().select("email2"));
    const noteNode = node("note:email");
    noteNode.focus();
    const name = () => store.getState().doc.steps.find((s) => s.id === "email2")?.name;
    fireEvent.keyDown(noteNode, { key: "Delete" });
    expect(store.getState().doc.steps.map((s) => s.id)).toContain("email2");
    fireEvent.keyDown(noteNode, { key: "z", metaKey: true, ctrlKey: true });
    expect(name()).toBeUndefined();
    fireEvent.keyDown(noteNode, { key: "z", metaKey: true, ctrlKey: true, shiftKey: true });
    expect(name()).toBe("Follow-up");
  });

  test("M5: an untitled section's region and chip names use the untitledSection label", async () => {
    const { FlowlineProvider } = await import("../provider");
    const doc = annotatedDoc({ note: "n" });
    (doc.sections as NonNullable<WorkflowDoc["sections"]>)[0]!.title = "";
    render(
      <FlowlineProvider client={{} as never} labels={{ untitledSection: "Sans titre" }}>
        <WorkflowCanvas store={storeOf(doc)} />
      </FlowlineProvider>,
    );
    expect(screen.getByRole("group", { name: "Section: Sans titre" })).toBeTruthy();
    const chip = within(node("sectionHeader:intro")).getByRole("button");
    expect(chip.getAttribute("aria-label")).toBe("Sans titre. Note: n");
    cleanup();
    render(
      <FlowlineProvider client={{} as never} labels={{ untitledSection: "Sans titre" }}>
        <WorkflowCanvas store={storeOf(doc, true)} />
      </FlowlineProvider>,
    );
    expect(node("sectionHeader:intro").getAttribute("aria-label")).toBe("Sans titre. Note: n");
  });

  test("M6: under reduced motion the flash clears on a timer", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query.includes("prefers-reduced-motion"),
    })) as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      const store = storeOf(annotatedDoc());
      render(<WorkflowCanvas store={store} />);
      act(() => {
        createAgentBridge(store).apply([
          { op: "setConfig", id: "email2", key: "subject", value: "Changed" },
        ]);
      });
      expect(card("email2").hasAttribute("data-flash")).toBe(true);
      act(() => vi.advanceTimersByTime(1000));
      expect(card("email2").hasAttribute("data-flash")).toBe(false);
    } finally {
      vi.useRealTimers();
      window.matchMedia = original;
    }
  });

  test("M7: a new token mid-animation restarts the flash", () => {
    const store = storeOf(annotatedDoc());
    render(<WorkflowCanvas store={store} />);
    const bridge = createAgentBridge(store);
    act(() => {
      bridge.apply([{ op: "setConfig", id: "email2", key: "subject", value: "One" }]);
    });
    const first = card("email2").getAttribute("data-flash");
    expect(first).not.toBeNull();
    act(() => {
      bridge.apply([{ op: "setConfig", id: "email2", key: "subject", value: "Two" }]);
    });
    const second = card("email2").getAttribute("data-flash");
    expect(second).not.toBeNull();
    // A different value swaps the animation name, which restarts it.
    expect(second).not.toBe(first);
    endAnimation(card("email2"));
    expect(card("email2").hasAttribute("data-flash")).toBe(false);
  });
});
