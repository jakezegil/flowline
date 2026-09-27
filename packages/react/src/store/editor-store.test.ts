import { allStepIds, findStep, type Step, type WorkflowDoc } from "@flowkit/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
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

describe("insertStep", () => {
  test("inserts at the top level with manifest defaults and selects it", () => {
    const store = storeFor();
    const id = store.getState().insertStep({ parentId: null, index: 0 }, "crm.sendEmail");
    const { doc, selection, dirty } = store.getState();
    expect(id).toBe("sendEmail");
    expect(doc.steps[0]).toEqual({
      id: "sendEmail",
      type: "crm.sendEmail",
      config: { subject: "Hello", mode: "html", cc: [] },
    });
    expect(selection).toBe("sendEmail");
    expect(dirty).toBe(true);
  });

  test("inserts into a branch and into a loop body", () => {
    const store = storeFor(branchyDoc());
    const a = store
      .getState()
      .insertStep({ parentId: "cond", branch: "else", index: 0 }, "crm.loadContact");
    const b = store
      .getState()
      .insertStep({ parentId: "each", branch: "body", index: 0 }, "crm.sendEmail");
    const { doc } = store.getState();
    expect(findStep(doc, a)?.location).toEqual({ parentId: "cond", branch: "else", index: 0 });
    expect(findStep(doc, b)?.location).toEqual({ parentId: "each", branch: "body", index: 0 });
    expect(a).toBe("loadContact");
  });

  test("new branching steps get an empty list per declared branch", () => {
    const store = storeFor(docWith([]));
    const c = store.getState().insertStep({ parentId: null, index: 0 }, "logic.condition");
    const s = store.getState().insertStep({ parentId: null, index: 1 }, "logic.switch");
    const l = store.getState().insertStep({ parentId: null, index: 2 }, "logic.forEach");
    const { doc } = store.getState();
    expect(findStep(doc, c)?.step.branches).toEqual({ if: [], else: [] });
    expect(findStep(doc, s)?.step.branches).toEqual({ a: [], default: [] });
    expect(findStep(doc, l)?.step.branches).toEqual({ body: [] });
  });

  test("unknown node types and bad locations throw", () => {
    const store = storeFor();
    expect(() => store.getState().insertStep({ parentId: null, index: 0 }, "nope.x")).toThrow(
      /Unknown node type "nope.x"/,
    );
    expect(() =>
      store.getState().insertStep({ parentId: "missing", branch: "x", index: 0 }, "crm.sendEmail"),
    ).toThrow();
    expect(store.getState().canUndo).toBe(false);
  });
});

describe("undo / redo", () => {
  test("round-trips every command back to a deep-equal doc", () => {
    const initial = branchyDoc();
    const store = storeFor(structuredClone(initial));
    const s = store.getState;
    const snapshots: WorkflowDoc[] = [s().doc];
    const commands: (() => void)[] = [
      () => s().insertStep({ parentId: "cond", branch: "else", index: 0 }, "crm.sendEmail"),
      () => s().renameStep("email", "Welcome mail"),
      () => s().toggleDisabled("load"),
      () => s().setConfig("email", "subject", "Yo"),
      () => s().moveStep("email", { parentId: "each", branch: "body", index: 0 }),
      () => s().duplicateStep("each"),
      () => s().replaceStep("sendEmail", "crm.loadContact"),
      () => s().setTrigger("logic.manual"),
      () => s().setTriggerConfig("fields", [{ name: "x", type: "string" }]),
      () => s().removeStep("cond"),
    ];
    for (const run of commands) {
      run();
      vi.advanceTimersByTime(1000);
      snapshots.push(s().doc);
    }
    expect(s().canUndo).toBe(true);
    for (let i = snapshots.length - 2; i >= 0; i--) {
      s().undo();
      expect(s().doc).toEqual(snapshots[i]);
    }
    expect(s().doc).toEqual(initial);
    expect(s().canUndo).toBe(false);
    expect(s().canRedo).toBe(true);
    for (let i = 1; i < snapshots.length; i++) {
      s().redo();
      expect(s().doc).toEqual(snapshots[i]);
    }
    expect(s().canRedo).toBe(false);
  });

  test("moving a step onto its own position adds no undo step", () => {
    const store = storeFor();
    const doc = store.getState().doc;
    store.getState().moveStep("email", { parentId: null, index: 1 });
    expect(store.getState().doc).toBe(doc);
    expect(store.getState().canUndo).toBe(false);
  });

  test("a new command clears the redo stack", () => {
    const store = storeFor();
    store.getState().renameStep("load", "A");
    store.getState().undo();
    expect(store.getState().canRedo).toBe(true);
    store.getState().toggleDisabled("load");
    expect(store.getState().canRedo).toBe(false);
  });

  test("history is capped at 100 entries", () => {
    const store = storeFor();
    for (let i = 0; i < 150; i++) store.getState().toggleDisabled("load");
    let undos = 0;
    while (store.getState().canUndo) {
      store.getState().undo();
      undos++;
    }
    expect(undos).toBe(100);
  });

  test("undo/redo with empty stacks are no-ops", () => {
    const store = storeFor();
    const doc = store.getState().doc;
    store.getState().undo();
    store.getState().redo();
    expect(store.getState().doc).toBe(doc);
  });

  test("consecutive setConfig on the same step+key within 500ms coalesce", () => {
    const store = storeFor();
    const s = store.getState;
    s().setConfig("email", "subject", "H");
    vi.advanceTimersByTime(200);
    s().setConfig("email", "subject", "He");
    vi.advanceTimersByTime(400); // 400ms since the last keystroke: still one burst
    s().setConfig("email", "subject", "Hey");
    vi.advanceTimersByTime(600); // pause breaks the burst
    s().setConfig("email", "subject", "Hey!");
    s().undo();
    expect(findStep(s().doc, "email")?.step.config.subject).toBe("Hey");
    s().undo();
    expect(findStep(s().doc, "email")?.step.config.subject).toBe("Hi");
    expect(s().canUndo).toBe(false);
  });

  test("a coalesced burst is capped at 2000ms from its first edit", () => {
    const store = storeFor();
    const s = store.getState;
    for (let i = 1; i <= 6; i++) {
      s().setConfig("email", "subject", `v${i}`); // t = 0, 400, ..., 2000
      vi.advanceTimersByTime(400);
    }
    s().undo();
    expect(findStep(s().doc, "email")?.step.config.subject).toBe("v5");
    s().undo();
    expect(findStep(s().doc, "email")?.step.config.subject).toBe("Hi");
  });

  test("setConfig on a different key or step does not coalesce", () => {
    const store = storeFor();
    const s = store.getState;
    s().setConfig("email", "subject", "A");
    s().setConfig("email", "to", "b@c.d");
    s().setConfig("load", "contactId", "c1");
    s().undo();
    s().undo();
    expect(findStep(s().doc, "email")?.step.config).toEqual({
      to: { $ref: "steps.load.email" },
      subject: "A",
    });
  });

  test("another command between two setConfigs breaks coalescing", () => {
    const store = storeFor();
    const s = store.getState;
    s().setConfig("email", "subject", "A");
    s().toggleDisabled("load");
    s().setConfig("email", "subject", "B");
    s().undo();
    expect(findStep(s().doc, "email")?.step.config.subject).toBe("A");
  });

  test("select and samples are not recorded in history", () => {
    const store = storeFor();
    store.getState().select("load");
    store.getState().setSample("load", { id: "c1" });
    expect(store.getState().canUndo).toBe(false);
  });

  test("undo clears a selection that no longer exists", () => {
    const store = storeFor();
    const id = store.getState().insertStep({ parentId: null, index: 2 }, "crm.sendEmail");
    expect(store.getState().selection).toBe(id);
    store.getState().undo();
    expect(store.getState().selection).toBeNull();
  });
});

describe("duplicate / copy / paste", () => {
  test("duplicate generates unique ids for the whole subtree and selects the copy", () => {
    const store = storeFor(branchyDoc());
    const newId = store.getState().duplicateStep("cond");
    const { doc, selection } = store.getState();
    expect(newId).toBe("condition");
    expect(selection).toBe(newId);
    const ids: string[] = [];
    const walk = (steps: Step[]) => {
      for (const s of steps) {
        ids.push(s.id);
        for (const b of Object.values(s.branches ?? {})) walk(b);
      }
    };
    walk(doc.steps);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  test("paste inserts a fresh-id copy each time, rewriting refs within the subtree", () => {
    const doc = docWith([
      step(
        "each",
        "logic.forEach",
        { items: { $ref: "trigger.tags" } },
        {
          branches: {
            body: [
              step("load", "crm.loadContact", { contactId: "c1" }),
              step("email", "crm.sendEmail", {
                to: { $ref: "steps.load.email" },
                subject: { $tpl: "Hi {{ steps.load.name }} from {{ trigger.contactId }}" },
              }),
            ],
          },
        },
      ),
    ]);
    const store = storeFor(doc);
    const s = store.getState;
    expect(s().paste({ parentId: null, index: 0 })).toBeNull();
    s().copy("each");
    const first = s().paste({ parentId: null, index: 1 });
    const second = s().paste({ parentId: null, index: 2 });
    expect(first).toBe("forEach");
    expect(second).toBe("forEach_2");
    expect(s().selection).toBe(second);
    const ids = allStepIds(s().doc);
    expect(ids.size).toBe(9);
    const copy = findStep(s().doc, "forEach")!.step;
    const [load, email] = copy.branches!.body!;
    expect(load!.id).toBe("loadContact");
    expect(email!.config).toEqual({
      to: { $ref: "steps.loadContact.email" },
      subject: { $tpl: "Hi {{ steps.loadContact.name }} from {{ trigger.contactId }}" },
    });
    // The rewritten refs resolve against the copy's own steps.
    expect(s().issues.filter((i) => i.stepId === "sendEmail")).toEqual([]);
  });

  test("copying keeps the clipboard independent of later edits", () => {
    const store = storeFor();
    store.getState().copy("email");
    store.getState().setConfig("email", "subject", "Changed");
    expect(store.getState().clipboard?.config.subject).toBe("Hi");
    store.getState().copy("missing");
    expect(store.getState().clipboard?.id).toBe("email");
  });
});

describe("removeStep", () => {
  test("removing the selected step (or its ancestor) clears the selection", () => {
    const store = storeFor(branchyDoc());
    store.getState().select("email");
    store.getState().removeStep("load");
    expect(store.getState().selection).toBe("email");
    store.getState().removeStep("cond");
    expect(store.getState().selection).toBeNull();
  });

  test("issues update after remove: downstream refs become unresolved", () => {
    const store = storeFor();
    expect(store.getState().issues).toEqual([]);
    store.getState().removeStep("load");
    expect(store.getState().issues).toContainEqual(
      expect.objectContaining({ code: "ref.unresolved", stepId: "email", field: "to" }),
    );
    store.getState().undo();
    expect(store.getState().issues).toEqual([]);
  });
});

describe("test state and samples", () => {
  test("setSample marks tested; a later setConfig marks needs-test", () => {
    const store = storeFor();
    const s = store.getState;
    s().setConfig("load", "contactId", "c0"); // untested stays untested
    expect(s().testState.load).toBeUndefined();
    s().setSample("load", { id: "c1", email: "a@b.c" });
    expect(s().testState.load).toBe("tested");
    expect(s().samples.load).toEqual({ id: "c1", email: "a@b.c" });
    s().setConfig("load", "contactId", "c2");
    expect(s().testState.load).toBe("needs-test");
    s().setSample("__trigger", { contactId: "c9" });
    s().setTriggerConfig("anything", "x");
    expect(s().testState.__trigger).toBe("needs-test");
  });

  test("setConfig with an unchanged value is a no-op", () => {
    const store = storeFor();
    store.getState().setSample("email", {});
    const doc = store.getState().doc;
    store.getState().setConfig("email", "subject", "Hi");
    expect(store.getState().doc).toBe(doc);
    expect(store.getState().testState.email).toBe("tested");
    expect(store.getState().canUndo).toBe(false);
  });

  test("setConfig(undefined) removes the key", () => {
    const store = storeFor();
    store.getState().setConfig("email", "subject", undefined);
    expect(findStep(store.getState().doc, "email")?.step.config).toEqual({
      to: { $ref: "steps.load.email" },
    });
  });

  test("samples persist to localStorage per workflow and never enter the doc", () => {
    const store = storeFor();
    store.getState().setSample("load", { email: "secret@pii.com" });
    expect(JSON.stringify(store.getState().doc)).not.toContain("secret@pii.com");
    const raw = localStorage.getItem("flowkit:samples:welcome");
    expect(raw).toContain("secret@pii.com");
    const reopened = storeFor();
    expect(reopened.getState().samples.load).toEqual({ email: "secret@pii.com" });
    expect(reopened.getState().testState.load).toBe("tested");
  });

  test("corrupt or unavailable storage is ignored", () => {
    localStorage.setItem("flowkit:samples:welcome", "{not json");
    expect(storeFor().getState().samples).toEqual({});
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    const store = storeFor();
    expect(() => store.getState().setSample("load", {})).not.toThrow();
    expect(store.getState().samples.load).toEqual({});
    spy.mockRestore();
  });

  test("delete then undo keeps the sample and test state", () => {
    const store = storeFor();
    store.getState().setSample("email", { messageId: "m" });
    store.getState().removeStep("email");
    store.getState().undo();
    expect(store.getState().samples.email).toEqual({ messageId: "m" });
    expect(store.getState().testState.email).toBe("tested");
  });

  test("a new step reusing a removed step's id starts without its sample", () => {
    const store = storeFor(
      docWith([step("sendEmail", "crm.sendEmail", { to: "a", subject: "b" })]),
    );
    store.getState().setSample("sendEmail", { messageId: "old" });
    store.getState().removeStep("sendEmail");
    const id = store.getState().insertStep({ parentId: null, index: 0 }, "crm.sendEmail");
    expect(id).toBe("sendEmail");
    expect(store.getState().samples.sendEmail).toBeUndefined();
    expect(store.getState().testState.sendEmail).toBeUndefined();
    expect(localStorage.getItem("flowkit:samples:welcome")).not.toContain("old");
  });

  test("pasted and duplicated subtrees start without samples under their new ids", () => {
    const store = storeFor(branchyDoc());
    store.getState().setSample("condition", { stale: true });
    store.getState().setSample("sendEmail", { stale: true });
    store.getState().duplicateStep("cond"); // → condition { if: [sendEmail] }
    expect(store.getState().samples).toEqual({});
    store.getState().setSample("condition_2", { stale: true });
    store.getState().copy("cond");
    expect(store.getState().paste({ parentId: null, index: 0 })).toBe("condition_2");
    expect(store.getState().samples).toEqual({});
  });

  test("loading samples prunes entries of steps that no longer exist", () => {
    localStorage.setItem(
      "flowkit:samples:welcome",
      JSON.stringify({
        samples: { load: 1, gone: 2, __trigger: 3 },
        testState: { load: "tested", gone: "tested" },
      }),
    );
    const store = storeFor();
    expect(store.getState().samples).toEqual({ load: 1, __trigger: 3 });
    expect(store.getState().testState).toEqual({ load: "tested" });
    store.getState().setSample("email", {});
    store.getState().replaceDoc(docWith([step("email", "crm.sendEmail")]));
    expect(store.getState().samples).toEqual({ email: {}, __trigger: 3 });
  });
});

describe("SSR", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("without window the store starts empty until hydrateLocal()", () => {
    localStorage.setItem(
      "flowkit:samples:welcome",
      JSON.stringify({ samples: { load: 1 }, testState: { load: "tested" } }),
    );
    vi.stubGlobal("window", undefined);
    const store = storeFor();
    expect(store.getState().samples).toEqual({});
    vi.unstubAllGlobals();
    store.getState().hydrateLocal();
    expect(store.getState().samples).toEqual({ load: 1 });
    expect(store.getState().testState).toEqual({ load: "tested" });
  });
});

describe("select option", () => {
  test("insertStep, duplicateStep and paste can leave the selection alone", () => {
    const store = storeFor();
    store.getState().select("load");
    store.getState().insertStep({ parentId: null, index: 0 }, "crm.sendEmail", { select: false });
    store.getState().duplicateStep("email", { select: false });
    store.getState().copy("email");
    store.getState().paste({ parentId: null, index: 0 }, { select: false });
    expect(store.getState().selection).toBe("load");
    expect(store.getState().doc.steps).toHaveLength(5);
  });
});

describe("replaceStep", () => {
  test("condition → forEach keeps id; non-empty dropped branches stay as flagged leftovers", () => {
    const store = storeFor(branchyDoc());
    store.getState().setSample("cond", { matched: true });
    store.getState().replaceStep("cond", "logic.forEach");
    const found = findStep(store.getState().doc, "cond")!.step;
    expect(found.type).toBe("logic.forEach");
    expect(found.config).toEqual({});
    // "if" held a step, so it is kept (after the declared "body"); empty "else" is dropped.
    expect(found.branches).toEqual({ body: [], if: [expect.objectContaining({ id: "email" })] });
    expect(store.getState().issues).toContainEqual(
      expect.objectContaining({ code: "branch.unknown", stepId: "cond", severity: "error" }),
    );
    // Undo restores the condition and its sample is still there.
    store.getState().undo();
    expect(findStep(store.getState().doc, "cond")!.step.type).toBe("logic.condition");
    expect(store.getState().samples.cond).toEqual({ matched: true });
  });

  test("condition → leaf keeps the children in place as flagged leftover branches", () => {
    const store = storeFor(branchyDoc());
    store.getState().replaceStep("cond", "crm.sendEmail");
    expect(store.getState().doc.steps.map((s) => s.id)).toEqual(["load", "cond", "each"]);
    const cond = findStep(store.getState().doc, "cond")!.step;
    expect(cond.branches).toEqual({ if: [expect.objectContaining({ id: "email" })] });
    expect(findStep(store.getState().doc, "email")!.location).toEqual({
      parentId: "cond",
      branch: "if",
      index: 0,
    });
    expect(store.getState().issues).toContainEqual(
      expect.objectContaining({ code: "branch.unknown", stepId: "cond", severity: "error" }),
    );
  });

  test("replacing with the same type is a no-op", () => {
    const store = storeFor();
    store.getState().setConfig("load", "contactId", "c1");
    const doc = store.getState().doc;
    store.getState().replaceStep("load", "crm.loadContact");
    expect(store.getState().doc).toBe(doc);
    expect(findStep(doc, "load")!.step.config.contactId).toBe("c1");
  });
});

describe("switch branches follow config", () => {
  test("adding a case adds an empty branch; removing an empty case drops it", () => {
    const store = storeFor(docWith([]));
    const id = store.getState().insertStep({ parentId: null, index: 0 }, "logic.switch");
    store.getState().setConfig(id, "cases", [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    expect(findStep(store.getState().doc, id)!.step.branches).toEqual({
      a: [],
      b: [],
      default: [],
    });
    store.getState().insertStep({ parentId: id, branch: "a", index: 0 }, "crm.sendEmail");
    store.getState().setConfig(id, "cases", []);
    // Empty "b" is dropped; "a" still holds a step, so it is kept after the declared branches
    // (the validator flags it) rather than silently deleted.
    expect(Object.keys(findStep(store.getState().doc, id)!.step.branches!)).toEqual([
      "default",
      "a",
    ]);
  });
});

describe("trigger", () => {
  test("setTrigger resets config to the new trigger's defaults", () => {
    const store = storeFor();
    store.getState().setTrigger("logic.manual");
    expect(store.getState().doc.trigger).toEqual({ type: "logic.manual", config: { fields: [] } });
    const doc = store.getState().doc;
    store.getState().setTrigger("logic.manual");
    expect(store.getState().doc).toBe(doc);
    expect(() => store.getState().setTrigger("nope")).toThrow(/Unknown trigger type/);
  });
});

describe("rename / disable", () => {
  test("renameStep trims, and an empty name clears the override", () => {
    const store = storeFor();
    store.getState().renameStep("load", "  Fetch  ");
    expect(findStep(store.getState().doc, "load")!.step.name).toBe("Fetch");
    store.getState().renameStep("load", " ");
    expect("name" in findStep(store.getState().doc, "load")!.step).toBe(false);
  });

  test("toggleDisabled flips the flag and removes it when re-enabled", () => {
    const store = storeFor();
    store.getState().toggleDisabled("load");
    expect(findStep(store.getState().doc, "load")!.step.disabled).toBe(true);
    store.getState().toggleDisabled("load");
    expect("disabled" in findStep(store.getState().doc, "load")!.step).toBe(false);
  });
});

describe("save state", () => {
  test("dirty tracks the saved doc, including undo back to it", () => {
    const store = storeFor();
    expect(store.getState().dirty).toBe(false);
    store.getState().renameStep("load", "X");
    expect(store.getState().dirty).toBe(true);
    store.getState().undo();
    expect(store.getState().dirty).toBe(false);
    store.getState().redo();
    store.getState().markSaved(3);
    expect(store.getState()).toMatchObject({ dirty: false, savedVersion: 3 });
    store.getState().markPublished(3);
    expect(store.getState().publishedVersion).toBe(3);
    store.getState().undo();
    expect(store.getState().dirty).toBe(true);
  });

  test("replaceDoc swaps the document, clears history and loads that workflow's samples", () => {
    localStorage.setItem(
      "flowkit:samples:other",
      JSON.stringify({ samples: { a: 1 }, testState: { a: "tested" } }),
    );
    const store = storeFor();
    store.getState().renameStep("load", "X");
    store.getState().select("load");
    store.getState().replaceDoc(docWith([step("a", "crm.loadContact")], "other"));
    const s = store.getState();
    expect(s.doc.id).toBe("other");
    expect(s).toMatchObject({ canUndo: false, canRedo: false, dirty: false, selection: null });
    expect(s.samples).toEqual({ a: 1 });
    expect(s.issues).toContainEqual(
      expect.objectContaining({ code: "config.required", stepId: "a" }),
    );
  });
});

describe("performance", () => {
  test("revalidating a 200-step doc on a command takes < 20ms", () => {
    vi.useRealTimers();
    const steps: Step[] = [step("load", "crm.loadContact", { contactId: "c" })];
    for (let i = 0; i < 199; i++) {
      steps.push(
        step(`s${i}`, "crm.sendEmail", {
          to: { $ref: "steps.load.email" },
          subject: { $tpl: "Hi {{ steps.load.name }}" },
        }),
      );
    }
    const store = storeFor(docWith(steps));
    store.getState().renameStep("s0", "warm-up");
    const t0 = performance.now();
    store.getState().renameStep("s1", "Timed");
    expect(performance.now() - t0).toBeLessThan(20);
  });
});
