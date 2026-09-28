import { describe, expect, test } from "vitest";
import {
  allStepIds,
  codeBlocksRename,
  duplicateStep,
  FlowkitTreeError,
  findStep,
  generateStepId,
  insertStep,
  isGeneratedStepId,
  moveStep,
  removeStep,
  renameStepId,
  updateStep,
  walkSteps,
} from "./tree";
import type { Manifest, Step, WorkflowDoc } from "./types";

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

  test("never generates reserved object-property ids", () => {
    const doc = frozenClone(baseDoc());
    expect(generateStepId(doc, "x.constructor")).toBe("constructor_2");
    expect(generateStepId(doc, "__proto__")).toBe("__proto___2");
    expect(generateStepId(doc, "__trigger")).toBe("__trigger_2");
    expect(generateStepId(doc, "prototype")).toBe("prototype_2");
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

describe("renameStepId / isGeneratedStepId (L25)", () => {
  test("renames a step and every reference to it, leaving the input untouched", () => {
    const doc = frozenClone({
      ...baseDoc(),
      output: { email: { $ref: "steps.loadContact.email" } },
    });
    const next = renameStepId(doc, "loadContact", "getContact");
    expect(findStep(next, "loadContact")).toBeUndefined();
    expect(findStep(next, "getContact")?.step.type).toBe("crm.loadContact");
    expect(findStep(next, "checkVip")?.step.config.expr).toEqual({ $ref: "steps.getContact.tier" });
    expect(findStep(next, "sendVipEmail")?.step.config.to).toEqual({
      $ref: "steps.getContact.email",
    });
    expect(findStep(next, "sendRegularEmail")?.step.config.to).toEqual({
      $tpl: "Hi {{ steps.getContact.name }}",
    });
    expect(next.output).toEqual({ email: { $ref: "steps.getContact.email" } });
    expect(renameStepId(doc, "checkVip", "checkVip")).toBe(doc);
    expect(() => renameStepId(doc, "checkVip", "loadContact")).toThrow(FlowkitTreeError);
    expect(() => renameStepId(doc, "nope", "x")).toThrow(FlowkitTreeError);
  });

  test("I2: rewrites steps.<id> and steps['<id>'] in code, leaving strings and comments", () => {
    const code = [
      "// steps.httpRequest is the call",
      "const s = 'steps.httpRequest';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the code holds a template literal
      "const t = `${steps.httpRequest.output.status} steps.httpRequest`;",
      "const r = /steps.httpRequest/;",
      "return { n: steps.httpRequest.output.status, m: steps['httpRequest'].body,",
      '  o: steps?.httpRequest, p: steps["httpRequest"], q: input.steps.httpRequest,',
      "  x: other.steps.httpRequest, y: steps.httpRequestOld };",
    ].join("\n");
    const doc: WorkflowDoc = {
      ...baseDoc(),
      steps: [
        { id: "httpRequest", type: "core.httpRequest", config: {} },
        { id: "calc", type: "core.transform", config: { code, label: "steps.httpRequest" } },
      ],
    };
    const manifest = {
      nodes: [
        {
          type: "core.transform",
          input: {
            properties: { code: { "x-flowkit": { widget: "code" } }, label: { type: "string" } },
          },
        },
      ],
    } as unknown as Manifest;
    const next = renameStepId(doc, "httpRequest", "sendEmail", manifest);
    const config = findStep(next, "calc")?.step.config;
    expect(config?.code).toBe(
      [
        "// steps.httpRequest is the call",
        "const s = 'steps.httpRequest';",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the code holds a template literal
        "const t = `${steps.sendEmail.output.status} steps.httpRequest`;",
        "const r = /steps.httpRequest/;",
        "return { n: steps.sendEmail.output.status, m: steps['sendEmail'].body,",
        '  o: steps?.sendEmail, p: steps["sendEmail"], q: input.steps.sendEmail,',
        "  x: other.steps.httpRequest, y: steps.httpRequestOld };",
      ].join("\n"),
    );
    // Not a code field: left alone.
    expect(config?.label).toBe("steps.httpRequest");
    // The review's case, without a manifest.
    const plain = renameStepId(
      {
        ...baseDoc(),
        steps: [
          { id: "httpRequest", type: "core.httpRequest", config: {} },
          {
            id: "calc",
            type: "core.transform",
            config: {
              code: "return { n: steps.httpRequest.output.status, m: steps['httpRequest'].body }",
            },
          },
        ],
      },
      "httpRequest",
      "sendEmail",
    );
    expect(findStep(plain, "calc")?.step.config.code).toBe(
      "return { n: steps.sendEmail.output.status, m: steps['sendEmail'].body }",
    );
  });

  test("I2: code that reads steps dynamically blocks a rename of a step it names", () => {
    const withCode = (code: string): WorkflowDoc => ({
      ...baseDoc(),
      steps: [
        { id: "httpRequest", type: "core.httpRequest", config: {} },
        { id: "calc", type: "core.transform", config: { code } },
      ],
    });
    expect(
      codeBlocksRename(withCode("const k = 'httpRequest'; return steps[k];"), "httpRequest"),
    ).toBe(true);
    expect(
      codeBlocksRename(
        withCode("const { httpRequest } = steps; return httpRequest;"),
        "httpRequest",
      ),
    ).toBe(true);
    // Dynamic, but the ID isn't written anywhere: nothing to break by name.
    expect(codeBlocksRename(withCode("return Object.keys(steps);"), "httpRequest")).toBe(false);
    // Static accesses are rewritten, not blocking.
    expect(codeBlocksRename(withCode("return steps.httpRequest;"), "httpRequest")).toBe(false);
  });

  test("tells generated IDs from chosen ones", () => {
    expect(isGeneratedStepId("httpRequest", "core.httpRequest")).toBe(true);
    expect(isGeneratedStepId("httpRequest_3", "core.httpRequest")).toBe(true);
    expect(isGeneratedStepId("httpRequest_x", "core.httpRequest")).toBe(false);
    expect(isGeneratedStepId("callBilling", "core.httpRequest")).toBe(false);
  });
});

describe("structural sharing", () => {
  function twoBlocksDoc(): WorkflowDoc {
    const leaf = (id: string): Step => ({ id, type: "crm.sendEmail", config: {} });
    return frozenClone({
      id: "wf-share",
      name: "Sharing",
      trigger: { type: "crm.dealUpdated", config: {} },
      steps: [
        {
          id: "outer",
          type: "logic.condition",
          config: {},
          branches: {
            if: [
              { id: "left", type: "logic.condition", config: {}, branches: { if: [leaf("a")] } },
              { id: "right", type: "logic.condition", config: {}, branches: { if: [leaf("b")] } },
            ],
            else: [leaf("c")],
          },
        },
        { id: "sibling", type: "logic.condition", config: {}, branches: { if: [leaf("d")] } },
      ],
    });
  }

  test("editing a nested step keeps untouched steps and branches referentially equal", () => {
    const doc = twoBlocksDoc();
    const next = updateStep(doc, "a", (s) => ({ ...s, name: "Renamed" }));
    const before = (id: string) => findStep(doc, id)?.step;
    const after = (id: string) => findStep(next, id)?.step;
    expect(after("a")?.name).toBe("Renamed");
    // Untouched branching steps, anywhere in the tree, are the same objects.
    expect(after("right")).toBe(before("right"));
    expect(after("sibling")).toBe(before("sibling"));
    expect(after("c")).toBe(before("c"));
    expect(after("outer")?.branches?.else).toBe(before("outer")?.branches?.else);
    // Only the path to the edit is copied.
    expect(after("left")).not.toBe(before("left"));
    expect(after("outer")).not.toBe(before("outer"));
    expect(Object.keys(after("outer")?.branches ?? {})).toEqual(["if", "else"]);
  });

  test("insert and remove share every step they don't change", () => {
    const doc = twoBlocksDoc();
    const step: Step = { id: "new", type: "crm.sendEmail", config: {} };
    const inserted = insertStep(doc, { parentId: "right", branch: "if", index: 1 }, step);
    expect(findStep(inserted, "left")?.step).toBe(findStep(doc, "left")?.step);
    expect(findStep(inserted, "sibling")?.step).toBe(findStep(doc, "sibling")?.step);
    const removed = removeStep(inserted, "new");
    expect(findStep(removed, "left")?.step).toBe(findStep(doc, "left")?.step);
    expect(findStep(removed, "right")?.step).toEqual(findStep(doc, "right")?.step);
  });

  test("move shares every step off the source and target paths, and the moved step itself", () => {
    const doc = twoBlocksDoc();
    const before = (id: string) => findStep(doc, id)?.step;
    // a: outer › if › left › if  →  sibling › if (index 0)
    const next = moveStep(doc, "a", { parentId: "sibling", branch: "if", index: 0 });
    const after = (id: string) => findStep(next, id)?.step;
    expect(after("sibling")?.branches?.if?.map((s) => s.id)).toEqual(["a", "d"]);
    expect(after("a")).toBe(before("a"));
    expect(after("d")).toBe(before("d"));
    expect(after("right")).toBe(before("right"));
    expect(after("c")).toBe(before("c"));
    expect(after("outer")?.branches?.else).toBe(before("outer")?.branches?.else);
    // Only the source and target paths are copied.
    expect(after("left")).not.toBe(before("left"));
    expect(after("sibling")).not.toBe(before("sibling"));
  });

  test("duplicate shares every step except the copy's parent path", () => {
    const doc = twoBlocksDoc();
    const before = (id: string) => findStep(doc, id)?.step;
    const { doc: next, newId } = duplicateStep(doc, "b");
    const after = (id: string) => findStep(next, id)?.step;
    expect(after("right")?.branches?.if?.map((s) => s.id)).toEqual(["b", newId]);
    expect(after("b")).toBe(before("b"));
    expect(after("left")).toBe(before("left"));
    expect(after("sibling")).toBe(before("sibling"));
    expect(after("c")).toBe(before("c"));
    expect(after("right")).not.toBe(before("right"));
    expect(after("outer")).not.toBe(before("outer"));
  });
});
