import { commandCatalog, runTool, type WorkflowDoc } from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { createCrmRegistry } from "./app";

describe("the mini-crm tool catalog", () => {
  const manifest = createCrmRegistry().manifest();
  const catalog = commandCatalog(manifest);

  test("snapshot", () => {
    expect(catalog).toMatchSnapshot();
  });

  test("fits the size budget", () => {
    expect(JSON.stringify(catalog).length).toBeLessThan(40_000);
  });

  test("the apply examples run on an empty workflow with the first trigger", () => {
    const apply = catalog.find((t) => t.name === "apply");
    const examples = [...(apply?.description ?? "").matchAll(/^Example: (.+)$/gm)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(examples.length).toBeGreaterThan(0);
    let doc: WorkflowDoc = {
      id: "w",
      name: "W",
      trigger: { type: manifest.triggers[0]?.type as string, config: {} },
      steps: [],
    };
    for (const ex of examples) {
      const r = runTool({ doc, manifest }, "apply", ex);
      expect(r.ok && r.result, JSON.stringify(r)).toMatchObject({ ok: true });
      if (r.ok && r.doc) doc = r.doc;
    }
  });
});
