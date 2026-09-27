import { describe, expect, test } from "vitest";
import {
  allStepIds,
  duplicateStep,
  FlowkitTreeError,
  findStep,
  generateStepId,
  insertStep,
  moveStep,
  removeStep,
  updateStep,
  walkSteps,
} from "./tree";
import type { Step, WorkflowDoc } from "./types";

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as object)) {
      deepFreeze(value);
    }
  }
  return obj;
}

function frozenClone(doc: WorkflowDoc): WorkflowDoc {
  return deepFreeze(structuredClone(doc));
}

function baseDoc(): WorkflowDoc {
  return {
    id: "wf-1",
    name: "Test workflow",
    trigger: { type: "crm.dealUpdated", config: {} },
    steps: [
      {
        id: "loadContact",
        type: "crm.loadContact",
        config: { contactId: { $ref: "trigger.contactId" } },
      },
      {
        id: "checkVip",
        type: "logic.condition",
        config: { expr: { $ref: "steps.loadContact.tier" } },
        branches: {
          ifTrue: [
            {
              id: "sendVipEmail",
              type: "email.send",
              config: {
                to: { $ref: "steps.loadContact.email" },
                note: { $ref: "steps.checkVip.tier" },
              },
            },
          ],
          ifFalse: [
            {
              id: "sendRegularEmail",
              type: "email.send",
              config: { to: { $tpl: "Hi {{steps.loadContact.name}}" } },
            },
          ],
        },
      },
    ],
  };
}

describe("findStep / walkSteps / allStepIds", () => {
  test("finds a top-level step", () => {
    const doc = frozenClone(baseDoc());
    const found = findStep(doc, "loadContact");
    expect(found?.step.id).toBe("loadContact");
    expect(found?.location).toEqual({ parentId: null, branch: undefined, index: 0 });
    expect(found?.ancestors).toEqual([]);
  });

  test("finds a nested step with ancestors", () => {
    const doc = frozenClone(baseDoc());
    const found = findStep(doc, "sendVipEmail");
    expect(found?.step.id).toBe("sendVipEmail");
    expect(found?.location).toEqual({ parentId: "checkVip", branch: "ifTrue", index: 0 });
    expect(found?.ancestors).toEqual([
      { step: expect.objectContaining({ id: "checkVip" }), branch: "ifTrue" },
    ]);
  });

  test("returns undefined for unknown id", () => {
    const doc = frozenClone(baseDoc());
    expect(findStep(doc, "nope")).toBeUndefined();
  });

  test("walkSteps visits every step pre-order with depth", () => {
    const doc = frozenClone(baseDoc());
    const visited: { id: string; depth: number }[] = [];
    walkSteps(doc, (step, _loc, depth) => visited.push({ id: step.id, depth }));
    expect(visited).toEqual([
      { id: "loadContact", depth: 0 },
      { id: "checkVip", depth: 0 },
      { id: "sendVipEmail", depth: 1 },
      { id: "sendRegularEmail", depth: 1 },
    ]);
  });

  test("allStepIds collects every step id", () => {
    const doc = frozenClone(baseDoc());
    expect(allStepIds(doc)).toEqual(
      new Set(["loadContact", "checkVip", "sendVipEmail", "sendRegularEmail"]),
    );
  });
});

describe("insertStep", () => {
  test("inserts into a nested branch immutably", () => {
    const original = baseDoc();
    const doc = frozenClone(original);
    const newStep: Step = { id: "logStep", type: "log.write", config: {} };
    const next = insertStep(doc, { parentId: "checkVip", branch: "ifTrue", index: 1 }, newStep);

    expect(next).not.toBe(doc);
    expect(findStep(next, "logStep")?.location).toEqual({
      parentId: "checkVip",
      branch: "ifTrue",
      index: 1,
    });
    // original untouched
    expect(findStep(doc, "logStep")).toBeUndefined();
    expect(doc).toEqual(original);
  });

  test("inserts at the top level", () => {
    const doc = frozenClone(baseDoc());
    const newStep: Step = { id: "topStep", type: "log.write", config: {} };
    const next = insertStep(doc, { parentId: null, index: 0 }, newStep);
    expect(next.steps[0]?.id).toBe("topStep");
  });

  test("throws when parent does not exist", () => {
    const doc = frozenClone(baseDoc());
    const newStep: Step = { id: "x", type: "log.write", config: {} };
    expect(() =>
      insertStep(doc, { parentId: "nope", branch: "ifTrue", index: 0 }, newStep),
    ).toThrow(FlowkitTreeError);
  });

  test("throws when branch does not exist on parent", () => {
    const doc = frozenClone(baseDoc());
    const newStep: Step = { id: "x", type: "log.write", config: {} };
    expect(() =>
      insertStep(doc, { parentId: "checkVip", branch: "nope", index: 0 }, newStep),
    ).toThrow(FlowkitTreeError);
  });

  test("throws when index is out of range", () => {
    const doc = frozenClone(baseDoc());
    const newStep: Step = { id: "x", type: "log.write", config: {} };
    expect(() => insertStep(doc, { parentId: null, index: 99 }, newStep)).toThrow(FlowkitTreeError);
    expect(() => insertStep(doc, { parentId: null, index: -1 }, newStep)).toThrow(FlowkitTreeError);
  });

  test("throws when step id already exists in doc", () => {
    const doc = frozenClone(baseDoc());
    const dup: Step = { id: "loadContact", type: "log.write", config: {} };
    expect(() => insertStep(doc, { parentId: null, index: 0 }, dup)).toThrow(FlowkitTreeError);
  });
});

describe("removeStep", () => {
  test("removes a nested step immutably", () => {
    const original = baseDoc();
    const doc = frozenClone(original);
    const next = removeStep(doc, "sendVipEmail");
    expect(findStep(next, "sendVipEmail")).toBeUndefined();
    expect(doc).toEqual(original);
    expect(next).not.toBe(doc);
  });

  test("throws for unknown id", () => {
    const doc = frozenClone(baseDoc());
    expect(() => removeStep(doc, "nope")).toThrow(FlowkitTreeError);
  });
});

describe("moveStep", () => {
  test("moves a step to the top level", () => {
    const doc = frozenClone(baseDoc());
    const next = moveStep(doc, "sendVipEmail", { parentId: null, index: 0 });
    expect(next.steps[0]?.id).toBe("sendVipEmail");
    expect(findStep(next, "sendVipEmail")?.location.parentId).toBeNull();
  });

  test("throws when moving a step into its own subtree", () => {
    const doc = frozenClone(baseDoc());
    expect(() =>
      moveStep(doc, "checkVip", { parentId: "checkVip", branch: "ifTrue", index: 0 }),
    ).toThrow(FlowkitTreeError);
  });
});

describe("updateStep", () => {
  test("applies fn immutably", () => {
    const original = baseDoc();
    const doc = frozenClone(original);
    const next = updateStep(doc, "loadContact", (s) => ({ ...s, name: "Load the contact" }));
    expect(findStep(next, "loadContact")?.step.name).toBe("Load the contact");
    expect(doc).toEqual(original);
  });

  test("throws for unknown id", () => {
    const doc = frozenClone(baseDoc());
    expect(() => updateStep(doc, "nope", (s) => s)).toThrow(FlowkitTreeError);
  });
});

describe("generateStepId", () => {
  test("derives id from node type and increments on collision", () => {
    const doc = frozenClone(baseDoc());
    expect(generateStepId(doc, "crm.loadContact")).toBe("loadContact_2");
    expect(generateStepId(doc, "crm.brandNewThing")).toBe("brandNewThing");
  });

  test("sanitizes non-identifier characters and leading digits", () => {
    const doc = frozenClone(baseDoc());
    expect(generateStepId(doc, "crm.load-contact!")).toBe("load_contact_");
    expect(generateStepId(doc, "9lives")).toBe("_9lives");
  });
});

describe("duplicateStep", () => {
  test("duplicates a leaf step right after the original with a fresh id", () => {
    const doc = frozenClone(baseDoc());
    const { doc: next, newId } = duplicateStep(doc, "loadContact");
    expect(newId).not.toBe("loadContact");
    expect(next.steps[0]?.id).toBe("loadContact");
    expect(next.steps[1]?.id).toBe(newId);
    expect(next.steps).toHaveLength(3);
  });

  test("duplicates a branching subtree, renaming every nested step and rewriting internal refs", () => {
    const doc = frozenClone(baseDoc());
    const { doc: next, newId } = duplicateStep(doc, "checkVip");

    const originalIndex = next.steps.findIndex((s) => s.id === "checkVip");
    const copy = next.steps[originalIndex + 1] as Step;
    expect(copy.id).toBe(newId);
    expect(copy.id).not.toBe("checkVip");

    const copiedThen = copy.branches?.ifTrue as Step[];
    const copiedElse = copy.branches?.ifFalse as Step[];
    expect(copiedThen[0]?.id).not.toBe("sendVipEmail");
    expect(copiedElse[0]?.id).not.toBe("sendRegularEmail");

    // internal ref (sendVipEmail -> its own ancestor checkVip) rewritten to point at the copy's own id.
    expect(copiedThen[0]?.config.note).toEqual({ $ref: `steps.${copy.id}.tier` });

    // ref to a step OUTSIDE the duplicated subtree (loadContact) must be left untouched.
    expect(copiedThen[0]?.config.to).toEqual({ $ref: "steps.loadContact.email" });
    expect(copiedElse[0]?.config.to).toEqual({ $tpl: "Hi {{steps.loadContact.name}}" });
    expect(copy.config.expr).toEqual({ $ref: "steps.loadContact.tier" });

    // all ids in the copy are unique and don't collide with the original doc
    const allIds = allStepIds(next);
    expect(allIds.size).toBe(7);
  });

  test("throws for unknown id", () => {
    const doc = frozenClone(baseDoc());
    expect(() => duplicateStep(doc, "nope")).toThrow(FlowkitTreeError);
  });
});
