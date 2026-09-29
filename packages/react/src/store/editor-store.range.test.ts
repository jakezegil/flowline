import {
  allStepIds,
  type Command,
  FlowlineCommandError,
  findStep,
  type Section,
  type Step,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import { createEditorStore, type EditorStore } from "./editor-store";

function storeFor(doc: WorkflowDoc = fixtureDoc(), readOnly?: boolean): EditorStore {
  return createEditorStore({ doc, manifest, ...(readOnly !== undefined ? { readOnly } : {}) });
}

const email = (id: string, extra: Partial<Step> = {}) =>
  step(id, "crm.sendEmail", { to: "a@b.c", subject: "Hi" }, extra);

/** a, b, c, d at the top level (sendEmail steps), optionally with sections. */
function flatDoc(sections?: Section[]): WorkflowDoc {
  const doc = docWith([email("a"), email("b"), email("c"), email("d")]);
  return sections ? { ...doc, sections } : doc;
}

const ids = (list: Step[]) => list.map((s) => s.id);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("apply", () => {
  test("a three-command batch is one undo step; redo gives the batch result", () => {
    const store = storeFor();
    const before = store.getState().doc;
    const r = store.getState().apply([
      { op: "addStep", at: { after: "email" }, type: "crm.sendEmail" },
      { op: "setConfig", id: "$1", key: "to", value: "x@y.z" },
      { op: "renameStep", id: "$1", name: "Follow up" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = store.getState().doc;
    expect(after).toBe(r.doc);
    expect(r.changed).not.toBe("");
    expect(findStep(after, r.ids.$1 as string)?.step.name).toBe("Follow up");
    store.getState().undo();
    expect(store.getState().doc).toBe(before);
    expect(store.getState().canUndo).toBe(false);
    store.getState().redo();
    expect(store.getState().doc).toBe(after);
  });

  test("a failed batch (Review Focus 2) leaves doc, history, canUndo and flash unchanged", () => {
    const store = storeFor();
    store.getState().apply([{ op: "renameStep", id: "load", name: "Load it" }]);
    const doc = store.getState().doc;
    const flash = store.getState().flash;
    const snapshot = structuredClone(doc);
    const r = store.getState().apply([
      { op: "addStep", at: { after: "email" }, type: "logic.condition" },
      {
        op: "insertSteps",
        at: { in: { stepId: "$1", branch: "if" }, index: 0 },
        steps: [
          {
            type: "crm.sendEmail",
            config: { to: "a@b.c", subject: { $tpl: "Re {{steps.$1.matched}}" } },
          },
        ],
      },
      { op: "removeStep", id: "nope" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.index).toBe(2);
    expect(r.error.path.startsWith("commands[2]")).toBe(true);
    expect(r.error.hint).toBeDefined();
    expect(store.getState().doc).toBe(doc);
    expect(doc).toEqual(snapshot);
    expect(store.getState().flash).toBe(flash);
    store.getState().undo();
    expect(store.getState().canUndo).toBe(false);
    expect(findStep(store.getState().doc, "load")?.step.name).toBeUndefined();
  });

  test("a shape error comes back as a result, never thrown", () => {
    const store = storeFor();
    const r = store.getState().apply([{ op: "removeStep" } as unknown as Command]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("command.invalid");
    expect(store.getState().canUndo).toBe(false);
  });

  test("an empty or no-op batch adds no history and no flash", () => {
    const store = storeFor();
    const before = store.getState().doc;
    const r = store.getState().apply([]);
    expect(r.ok && r.doc).toBe(before);
    store.getState().apply([{ op: "renameStep", id: "load", name: "" }]);
    expect(store.getState().doc).toBe(before);
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().flash).toBeNull();
  });

  test("sets flash to the changed steps and sections with a fresh token, unless flash: false", () => {
    const store = storeFor(flatDoc());
    store.getState().apply([
      { op: "setConfig", id: "b", key: "subject", value: "New" },
      { op: "addSection", first: "c", last: "d", title: "Tail", color: "blue" },
    ]);
    const first = store.getState().flash;
    expect(first?.ids).toEqual(["b"]);
    expect(first?.sections).toEqual(["tail"]);
    store.getState().apply([{ op: "setConfig", id: "a", key: "subject", value: "New" }]);
    const second = store.getState().flash;
    expect(second?.ids).toEqual(["a"]);
    expect(second?.sections).toEqual([]);
    expect(second?.token).not.toBe(first?.token);
    store.getState().apply([{ op: "setConfig", id: "c", key: "subject", value: "New" }], {
      flash: false,
    });
    expect(store.getState().flash).toBe(second);
  });

  test("flash pairs duplicate section IDs by occurrence, not by array index", () => {
    const dup: Section[] = [
      { id: "s", title: "One", color: "blue", first: "a", last: "a" },
      { id: "s", title: "Two", color: "green", first: "c", last: "c" },
    ];
    const store = storeFor(flatDoc(dup));
    // updateSection acts on the later "s"; the earlier one is unchanged.
    store.getState().apply([{ op: "updateSection", id: "s", title: "Changed" }]);
    expect(store.getState().flash?.sections).toEqual(["s"]);
    store.getState().apply([{ op: "setConfig", id: "b", key: "subject", value: "x" }]);
    expect(store.getState().flash?.sections).toEqual([]);
  });

  test("a burst with the same coalesceKey joins the previous undo step", () => {
    const store = storeFor();
    const before = store.getState().doc;
    const s = store.getState;
    s().apply([{ op: "renameStep", id: "load", name: "L" }], { coalesceKey: "k" });
    vi.advanceTimersByTime(100);
    s().apply([{ op: "renameStep", id: "load", name: "Lo" }], { coalesceKey: "k" });
    s().undo();
    expect(s().doc).toBe(before);
  });

  test("renameStepId of the selected step moves the selection and its local data", () => {
    const store = storeFor();
    const s = store.getState;
    s().select("load");
    s().setSample("load", { id: "c1" });
    const bridge = s().apply([{ op: "renameStepId", id: "load", newId: "getContact" }]);
    expect(bridge.ok).toBe(true);
    expect(s().selection).toBe("getContact");
    expect(s().samples.getContact).toEqual({ id: "c1" });
    expect(s().samples.load).toBeUndefined();
    expect(s().testState.getContact).toBe("tested");
    expect(s().sampleTypes.getContact).toBe("crm.loadContact");
  });

  test("setType with regeneration moves the selection and samples; the step needs a test", () => {
    const store = storeFor(
      docWith([step("sendEmail", "crm.sendEmail", { to: "a", subject: "b" })]),
    );
    const s = store.getState;
    s().select("sendEmail");
    s().setSample("sendEmail", { messageId: "m" });
    const r = s().apply([{ op: "setType", id: "sendEmail", type: "crm.loadContact" }]);
    expect(r.ok && r.renamed).toEqual({ sendEmail: "loadContact" });
    expect(s().selection).toBe("loadContact");
    expect(s().samples.loadContact).toEqual({ messageId: "m" });
    expect(s().testState.loadContact).toBe("needs-test");
  });

  test("wrapSteps of the selected step keeps it; removeSteps of it clears it", () => {
    const store = storeFor();
    const s = store.getState;
    s().select("email");
    s().apply([
      {
        op: "wrapSteps",
        first: "email",
        last: "email",
        in: { type: "logic.condition", branch: "if" },
      },
    ]);
    expect(s().selection).toBe("email");
    s().apply([{ op: "removeSteps", ids: ["email"] }]);
    expect(s().selection).toBeNull();
  });

  test("a step the batch adds starts without the local data left under its ID", () => {
    const store = storeFor();
    const s = store.getState;
    s().setSample("email", { messageId: "old" });
    s().removeStep("email");
    s().apply([{ op: "addStep", at: { after: "load" }, type: "crm.sendEmail", id: "email" }]);
    expect(s().samples.email).toBeUndefined();
    expect(s().testState.email).toBeUndefined();
  });
});

describe("range", () => {
  test("selectRange in one list sets it (in list order); across lists it returns false", () => {
    const store = storeFor(branchyDoc());
    const s = store.getState;
    expect(s().selectRange("each", "load")).toBe(true);
    expect(s().range).toEqual({ first: "load", last: "each" });
    expect(s().selectRange("load", "email")).toBe(false);
    expect(s().range).toEqual({ first: "load", last: "each" });
    expect(s().selectRange("load", "missing")).toBe(false);
    s().clearRange();
    expect(s().range).toBeNull();
  });

  test("deleting a member prunes the range, deleting all of it clears it", () => {
    const store = storeFor(flatDoc());
    const s = store.getState;
    s().selectRange("b", "d");
    s().removeStep("d");
    expect(s().range).toEqual({ first: "b", last: "c" });
    s().removeStep("b");
    expect(s().range).toEqual({ first: "c", last: "c" });
    s().removeStep("c");
    expect(s().range).toBeNull();
  });

  test("renameStepId of an endpoint remaps the range", () => {
    const store = storeFor(flatDoc());
    const s = store.getState;
    s().selectRange("a", "b");
    s().apply([{ op: "renameStepId", id: "b", newId: "bee" }]);
    expect(s().range).toEqual({ first: "a", last: "bee" });
  });

  test("removeRange removes the run; undo restores the sections removed with it", () => {
    const sections: Section[] = [{ id: "mid", title: "Mid", color: "blue", first: "b", last: "c" }];
    const store = storeFor(flatDoc(sections));
    const s = store.getState;
    const before = s().doc;
    s().selectRange("b", "c");
    s().removeRange("b", "c");
    expect(ids(s().doc.steps)).toEqual(["a", "d"]);
    expect(s().doc.sections ?? []).toEqual([]);
    expect(s().range).toBeNull();
    s().undo();
    expect(s().doc).toBe(before);
    expect(s().doc.sections).toEqual(sections);
  });

  test("duplicateRange copies the run after it and returns the first copy's ID", () => {
    const store = storeFor(flatDoc());
    const s = store.getState;
    const first = s().duplicateRange("a", "b");
    expect(ids(s().doc.steps)).toEqual(["a", "b", first, "sendEmail_2", "c", "d"]);
    expect(first).toBe("sendEmail");
  });

  test("moveBy moves the run one place, and is a no-op at the list edge", () => {
    const store = storeFor(flatDoc());
    const s = store.getState;
    s().moveBy("b", "c", 1);
    expect(ids(s().doc.steps)).toEqual(["a", "d", "b", "c"]);
    s().moveBy("b", "c", 1);
    expect(ids(s().doc.steps)).toEqual(["a", "d", "b", "c"]);
    s().moveBy("a", "a", -1);
    expect(ids(s().doc.steps)).toEqual(["a", "d", "b", "c"]);
    s().moveBy("b", "b", -1);
    expect(ids(s().doc.steps)).toEqual(["a", "b", "d", "c"]);
  });

  test("moveBy of an interior section member keeps the section (Review Focus 1)", () => {
    const sections: Section[] = [{ id: "all", title: "All", color: "blue", first: "a", last: "d" }];
    const store = storeFor(flatDoc(sections));
    const s = store.getState;
    s().moveBy("b", "b", 1);
    expect(ids(s().doc.steps)).toEqual(["a", "c", "b", "d"]);
    expect(s().doc.sections).toEqual(sections);
    s().moveBy("c", "c", -1);
    expect(ids(s().doc.steps)).toEqual(["c", "a", "b", "d"]);
    // Landing right next to the span keeps it a member (core upkeep rule 2).
    expect(s().doc.sections?.[0]).toMatchObject({ first: "c", last: "d" });
  });
});

describe("sections, notes and colours", () => {
  test("addSection, updateSection and removeSection are undoable", () => {
    const store = storeFor(flatDoc());
    const s = store.getState;
    const id = s().addSection("a", "b", { title: "Start", color: "green" });
    expect(s().doc.sections).toEqual([
      { id, title: "Start", color: "green", first: "a", last: "b" },
    ]);
    s().updateSection(id, { title: "Begin", note: "hello" });
    expect(s().doc.sections?.[0]).toMatchObject({ title: "Begin", note: "hello" });
    s().updateSection(id, { note: null });
    expect(s().doc.sections?.[0]?.note).toBeUndefined();
    s().removeSection(id);
    expect(s().doc.sections ?? []).toEqual([]);
    s().undo();
    expect(s().doc.sections?.[0]?.id).toBe(id);
  });

  test("addSection over an existing section throws FlowlineCommandError", () => {
    const store = storeFor(flatDoc());
    store.getState().addSection("a", "b", { title: "One", color: "blue" });
    expect(() => store.getState().addSection("b", "c", { title: "Two", color: "blue" })).toThrow(
      FlowlineCommandError,
    );
  });

  test("setNote bursts coalesce into one undo step; setColor sets and clears", () => {
    const store = storeFor();
    const s = store.getState;
    const before = s().doc;
    s().setNote("load", "h");
    vi.advanceTimersByTime(100);
    s().setNote("load", "hello");
    expect(findStep(s().doc, "load")?.step.note).toBe("hello");
    s().undo();
    expect(s().doc).toBe(before);
    s().setColor("load", "purple");
    expect(findStep(s().doc, "load")?.step.color).toBe("purple");
    s().setColor("load", null);
    expect(findStep(s().doc, "load")?.step.color).toBeUndefined();
  });
});

describe("clipboard", () => {
  test("copy sets clipboardRun to the one step", () => {
    const store = storeFor();
    store.getState().copy("email");
    expect(store.getState().clipboardRun?.map((x) => x.id)).toEqual(["email"]);
    expect(store.getState().clipboard).toBe(store.getState().clipboardRun?.[0]);
  });

  test("copyRange + paste inserts the run with fresh IDs and remapped internal refs", () => {
    const store = storeFor();
    const s = store.getState;
    s().copyRange("load", "email");
    expect(s().clipboard).toBe(findStep(s().doc, "load")?.step);
    expect(s().clipboardRun?.map((x) => x.id)).toEqual(["load", "email"]);
    const first = s().paste({ parentId: null, index: 2 });
    expect(first).toBe("loadContact");
    expect(ids(s().doc.steps)).toEqual(["load", "email", "loadContact", "sendEmail"]);
    expect(findStep(s().doc, "sendEmail")?.step.config.to).toEqual({
      $ref: "steps.loadContact.email",
    });
    expect(s().selection).toBe("loadContact");
    expect(allStepIds(s().doc).size).toBe(4);
    // One undo step.
    s().undo();
    expect(ids(s().doc.steps)).toEqual(["load", "email"]);
  });

  test("copyRange across lists or of unknown steps changes nothing", () => {
    const store = storeFor(branchyDoc());
    store.getState().copyRange("load", "email");
    store.getState().copyRange("load", "missing");
    expect(store.getState().clipboardRun).toBeNull();
  });
});

describe("readOnly", () => {
  const actions: [string, (s: EditorStore) => unknown][] = [
    ["insertStep", (s) => s.getState().insertStep({ parentId: null, index: 0 }, "crm.sendEmail")],
    ["replaceStep", (s) => s.getState().replaceStep("load", "crm.sendEmail")],
    ["removeStep", (s) => s.getState().removeStep("load")],
    ["duplicateStep", (s) => s.getState().duplicateStep("load")],
    ["moveStep", (s) => s.getState().moveStep("load", { parentId: null, index: 1 })],
    ["renameStep", (s) => s.getState().renameStep("load", "x")],
    ["toggleDisabled", (s) => s.getState().toggleDisabled("load")],
    ["setConfig", (s) => s.getState().setConfig("load", "contactId", "c")],
    ["setTrigger", (s) => s.getState().setTrigger("logic.manual")],
    ["setTriggerConfig", (s) => s.getState().setTriggerConfig("k", "v")],
    ["setOutput", (s) => s.getState().setOutput("k", "v")],
    ["paste", (s) => s.getState().paste({ parentId: null, index: 0 })],
    ["undo", (s) => s.getState().undo()],
    ["redo", (s) => s.getState().redo()],
    ["renameWorkflow", (s) => s.getState().renameWorkflow("New")],
    ["removeRange", (s) => s.getState().removeRange("load", "email")],
    ["duplicateRange", (s) => s.getState().duplicateRange("load", "email")],
    ["moveBy", (s) => s.getState().moveBy("load", "load", 1)],
    ["addSection", (s) => s.getState().addSection("load", "email", { title: "T", color: "blue" })],
    ["updateSection", (s) => s.getState().updateSection("sec", { title: "T" })],
    ["removeSection", (s) => s.getState().removeSection("sec")],
    ["setNote", (s) => s.getState().setNote("load", "n")],
    ["setColor", (s) => s.getState().setColor("load", "blue")],
  ];

  test.each(actions)("%s throws FlowlineCommandError with code readOnly", (_, act) => {
    const store = storeFor(fixtureDoc(), true);
    store.getState().copy("load");
    const before = store.getState().doc;
    let caught: unknown;
    try {
      act(store);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlowlineCommandError);
    expect((caught as FlowlineCommandError).error.code).toBe("readOnly");
    expect(store.getState().doc).toBe(before);
  });

  test("apply returns code readOnly; setReadOnly(false) lifts it", () => {
    const store = storeFor(fixtureDoc(), true);
    expect(store.getState().readOnly).toBe(true);
    const r = store.getState().apply([{ op: "removeStep", id: "load" }]);
    expect(r).toMatchObject({ ok: false, error: { code: "readOnly", index: 0, path: "" } });
    store.getState().setReadOnly(false);
    expect(store.getState().apply([{ op: "removeStep", id: "load" }]).ok).toBe(true);
  });

  test("selection, range and copy still work read-only", () => {
    const store = storeFor(fixtureDoc(), true);
    store.getState().select("load");
    expect(store.getState().selectRange("load", "email")).toBe(true);
    store.getState().copyRange("load", "email");
    expect(store.getState().clipboardRun).toHaveLength(2);
    expect(storeFor().getState().readOnly).toBe(false);
  });
});
