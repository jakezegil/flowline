import {
  FlowlineCommandError,
  FlowlineTreeError,
  findStep,
  type Section,
  type Step,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import { atFromLocation, stepToFragment } from "./commands";
import { createEditorStore, type EditorStore } from "./editor-store";

function storeFor(doc: WorkflowDoc = fixtureDoc()): EditorStore {
  return createEditorStore({ doc, manifest });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("errors", () => {
  test.each([
    ["removeStep", (s: EditorStore) => s.getState().removeStep("missing")],
    ["renameStep", (s: EditorStore) => s.getState().renameStep("missing", "x")],
    ["toggleDisabled", (s: EditorStore) => s.getState().toggleDisabled("missing")],
    ["setConfig", (s: EditorStore) => s.getState().setConfig("missing", "k", 1)],
    ["duplicateStep", (s: EditorStore) => s.getState().duplicateStep("missing")],
    ["replaceStep", (s: EditorStore) => s.getState().replaceStep("load", "nope.x")],
    ["setTrigger", (s: EditorStore) => s.getState().setTrigger("nope")],
    [
      "insertStep",
      (s: EditorStore) => s.getState().insertStep({ parentId: null, index: 0 }, "nope.x"),
    ],
  ])("a failed %s throws FlowlineCommandError, a FlowlineTreeError", (_, act) => {
    const store = storeFor();
    const before = store.getState().doc;
    let caught: unknown;
    try {
      act(store);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlowlineCommandError);
    expect(caught).toBeInstanceOf(FlowlineTreeError);
    expect(store.getState().doc).toBe(before);
    expect(store.getState().canUndo).toBe(false);
  });

  test("a bad location throws FlowlineTreeError before anything runs", () => {
    const store = storeFor();
    expect(() =>
      store.getState().insertStep({ parentId: null, index: 9 }, "crm.sendEmail"),
    ).toThrow(FlowlineTreeError);
    expect(() =>
      store.getState().insertStep({ parentId: "load", branch: "x", index: 0 }, "crm.sendEmail"),
    ).toThrow(FlowlineTreeError);
    expect(store.getState().canUndo).toBe(false);
  });
});

describe("no-op identity", () => {
  test("renameStep to the same name and setTrigger to the current type add no history", () => {
    const store = storeFor(docWith([step("load", "crm.loadContact", {}, { name: "Load" })]));
    const before = store.getState().doc;
    store.getState().renameStep("load", "  Load ");
    store.getState().setTrigger("crm.contactCreated");
    expect(store.getState().doc).toBe(before);
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().dirty).toBe(false);
  });

  test("toggleDisabled twice, then undo twice, returns the original doc object", () => {
    const store = storeFor();
    const original = store.getState().doc;
    store.getState().toggleDisabled("load");
    store.getState().toggleDisabled("load");
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().doc).toBe(original);
    expect(store.getState().canUndo).toBe(false);
  });
});

describe("paste", () => {
  test("a step whose refs are out of scope at the target still pastes", () => {
    const store = storeFor();
    store.getState().copy("email");
    const id = store.getState().paste({ parentId: null, index: 0 });
    expect(id).toBe("sendEmail");
    const pasted = store.getState().doc.steps[0] as Step;
    expect(pasted.config.to).toEqual({ $ref: "steps.load.email" });
    expect(store.getState().issues.some((i) => i.stepId === "sendEmail")).toBe(true);
  });

  test("keeps a config without a default key as it is", () => {
    const store = storeFor(
      docWith([step("email", "crm.sendEmail", { to: "a@b.c", subject: "Hi" })]),
    );
    store.getState().copy("email");
    const id = store.getState().paste({ parentId: null, index: 1 }) as string;
    expect(findStep(store.getState().doc, id)?.step.config).toEqual({
      to: "a@b.c",
      subject: "Hi",
    });
  });
});

describe("config values", () => {
  test("setConfig, setTriggerConfig and setOutput store a steps.$x placeholder as it is", () => {
    const store = storeFor();
    const tpl = { $tpl: "Price {{ steps.$price }}" };
    const ref = { $ref: "steps.$1.x" };
    store.getState().setConfig("email", "subject", tpl);
    store.getState().setTriggerConfig("k", ref);
    store.getState().setOutput("k", ref);
    const { doc } = store.getState();
    expect(findStep(doc, "email")?.step.config.subject).toEqual(tpl);
    expect(doc.trigger.config.k).toEqual(ref);
    expect(doc.output).toEqual({ k: ref });
  });
});

describe("replaceStep", () => {
  test("keeps the step's note and colour (annotations are anchored to steps)", () => {
    const store = storeFor(
      docWith([step("load", "crm.loadContact", {}, { note: "Why", color: "blue" })]),
    );
    store.getState().replaceStep("load", "crm.sendEmail");
    const replaced = findStep(store.getState().doc, "load")?.step;
    expect(replaced?.type).toBe("crm.sendEmail");
    expect(replaced?.note).toBe("Why");
    expect(replaced?.color).toBe("blue");
  });

  test("a step whose ID is an Object.prototype key still becomes needs-test", () => {
    localStorage.setItem(
      "flowline:samples:welcome",
      JSON.stringify({ testState: { toString: "tested" } }),
    );
    const store = storeFor(docWith([step("toString", "crm.loadContact")]));
    expect(store.getState().testState.toString).toBe("tested");
    store.getState().replaceStep("toString", "crm.sendEmail");
    expect(findStep(store.getState().doc, "toString")?.step.type).toBe("crm.sendEmail");
    expect(store.getState().testState.toString).toBe("needs-test");
  });

  test("a regenerated ID carries the selection", () => {
    const store = storeFor(docWith([step("loadContact", "crm.loadContact")]));
    store.getState().select("loadContact");
    store.getState().replaceStep("loadContact", "crm.sendEmail");
    expect(store.getState().selection).toBe("sendEmail");
    expect(findStep(store.getState().doc, "sendEmail")?.step.type).toBe("crm.sendEmail");
  });
});

describe("atFromLocation", () => {
  const doc = branchyDoc();
  test("anchors branch positions by index, top-level ones at the start or after a sibling", () => {
    expect(atFromLocation(doc, { parentId: null, index: 0 })).toEqual({ start: true });
    expect(atFromLocation(doc, { parentId: null, index: 3 })).toEqual({ after: "each" });
    expect(atFromLocation(doc, { parentId: "cond", branch: "if", index: 1 })).toEqual({
      in: { stepId: "cond", branch: "if" },
      index: 1,
    });
    expect(atFromLocation(doc, { parentId: "cond", branch: "else", index: 0 })).toEqual({
      in: { stepId: "cond", branch: "else" },
      index: 0,
    });
  });

  test("duplicate IDs: a branch insert lands in that branch, not next to an earlier twin", () => {
    const dupDoc = docWith([
      step("dup", "crm.loadContact"),
      step(
        "cond",
        "logic.condition",
        { value: true },
        { branches: { if: [step("dup", "crm.loadContact"), step("x", "crm.loadContact")] } },
      ),
    ]);
    const store = storeFor(dupDoc);
    const id = store
      .getState()
      .insertStep({ parentId: "cond", branch: "if", index: 1 }, "crm.sendEmail");
    expect(findStep(store.getState().doc, id)?.location).toEqual({
      parentId: "cond",
      branch: "if",
      index: 1,
    });
    expect(store.getState().doc.steps).toHaveLength(2);
  });

  test("duplicate IDs: a top-level insert anchors before the next sibling when it must", () => {
    const dupDoc = docWith([
      step("cond", "logic.condition", { value: true }, { branches: { if: [step("dup", "a.b")] } }),
      step("dup", "crm.loadContact"),
      step("z", "crm.loadContact"),
    ]);
    expect(atFromLocation(dupDoc, { parentId: null, index: 2 })).toEqual({ before: "z" });
    const store = storeFor(dupDoc);
    const id = store.getState().insertStep({ parentId: null, index: 2 }, "crm.sendEmail");
    expect(store.getState().doc.steps.map((s) => s.id)).toEqual(["cond", "dup", id, "z"]);
  });

  test("throws FlowlineTreeError for a missing parent, branch or an out-of-range index", () => {
    expect(() => atFromLocation(doc, { parentId: "nope", branch: "if", index: 0 })).toThrow(
      FlowlineTreeError,
    );
    expect(() => atFromLocation(doc, { parentId: "cond", branch: "__proto__", index: 0 })).toThrow(
      FlowlineTreeError,
    );
    expect(() => atFromLocation(doc, { parentId: null, index: 4 })).toThrow(FlowlineTreeError);
    expect(() => atFromLocation(doc, { parentId: null, index: -1 })).toThrow(FlowlineTreeError);
  });
});

describe("stepToFragment", () => {
  test("keeps IDs, config, annotations and branches exactly", () => {
    const s = step(
      "cond",
      "logic.condition",
      { value: true },
      {
        name: "C",
        disabled: true,
        note: "n",
        color: "pink",
        branches: { if: [step("x", "nope.type", { a: 1 })], else: [], extra: [] },
      },
    );
    expect(stepToFragment(s)).toEqual({
      id: "cond",
      type: "logic.condition",
      config: { value: true },
      name: "C",
      disabled: true,
      note: "n",
      color: "pink",
      branches: {
        if: [{ id: "x", type: "nope.type", config: { a: 1 } }],
        else: [],
        extra: [],
      },
    });
  });
});

describe("performance", () => {
  test("an edit or a move on a 500-step doc with 50 sections takes < 40ms", () => {
    vi.useRealTimers();
    const steps: Step[] = [step("load", "crm.loadContact", { contactId: "c" })];
    for (let i = 0; i < 499; i++) {
      steps.push(
        step(`s${i}`, "crm.sendEmail", {
          to: { $ref: "steps.load.email" },
          subject: { $tpl: "Hi {{ steps.load.name }}" },
        }),
      );
    }
    const sections: Section[] = [];
    for (let i = 0; i < 50; i++) {
      sections.push({
        id: `sec${i}`,
        title: `Section ${i}`,
        color: "blue",
        first: `s${i * 9}`,
        last: `s${i * 9 + 8}`,
      });
    }
    const store = storeFor({ ...docWith(steps), sections });
    store.getState().renameStep("s0", "warm-up");
    // Best of several: robust to CI/parallel-load noise, still catches algorithmic regressions.
    const best = (act: (i: number) => void): number => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 1; i <= 7; i++) {
        const t0 = performance.now();
        act(i);
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    const edit = best((i) => store.getState().setConfig(`s${i * 7}`, "subject", `Timed ${i}`));
    // Interior section members moved elsewhere in the list.
    const move = best((i) =>
      store.getState().moveStep(`s${i * 9 + 4}`, { parentId: null, index: 400 - i * 30 }),
    );
    expect(store.getState().doc.sections).toHaveLength(50);
    expect(edit).toBeLessThan(40);
    expect(move).toBeLessThan(40);
  });
});
