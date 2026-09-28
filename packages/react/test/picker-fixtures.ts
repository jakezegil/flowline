import type { ScopeEntry } from "@flowkit/core";

/** A scope in document order: the trigger, two steps (one without a schema), a loop. */
export const scope: ScopeEntry[] = [
  {
    refBase: "trigger",
    kind: "trigger",
    label: "Deal updated",
    icon: "handshake",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, amount: { type: "number" } },
    },
  },
  {
    refBase: "steps.load",
    kind: "step",
    stepId: "load",
    label: "Load contact",
    icon: "user",
    schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        score: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        company: { type: "object", properties: { domain: { type: "string" } } },
      },
    },
  },
  { refBase: "steps.fetch", kind: "step", stepId: "fetch", label: "Fetch orders", schema: {} },
];

export const loopEntry: ScopeEntry = {
  refBase: "loop",
  kind: "loop",
  stepId: "each",
  label: "For each tag",
  schema: { type: "object", properties: { item: { type: "string" }, index: { type: "number" } } },
};

export const samples: Record<string, unknown> = {
  __trigger: { name: "Ada", amount: 12 },
  load: { email: "ada@example.com", score: 9, tags: ["a"], company: { domain: "x.io" } },
  fetch: { status: 200, body: { total: 3 } },
};
