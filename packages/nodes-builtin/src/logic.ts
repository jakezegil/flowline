/**
 * Logic nodes: `core.condition`, `core.switch`, `core.forEach` and `core.stop`.
 *
 * @module
 */
import { branch, defineNode, loop, stop, ui } from "@flowlinejs/core";
import { z } from "zod";
import { ConditionRulesSchema, evaluateRules, looseEquals } from "./rules";

/** Branch IDs are part of step paths, so they must not contain `/`, `[` or `]`. */
const BRANCH_ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_BRANCH = "default";

/** If / else on a rule group: takes `if` when the rules match, `else` otherwise. */
export const conditionNode = defineNode({
  type: "core.condition",
  name: "If / else",
  description: "Take the If path when the conditions match, and the Else path when they don't.",
  icon: "split",
  category: "Logic",
  keywords: ["if", "else", "condition", "branch", "filter"],
  summary: "If {{rules}}",
  input: z.object({
    rules: ui(ConditionRulesSchema, { label: "Conditions", widget: "rules" }).describe(
      'Text compares ignoring case unless Match case is on. Dates and times are UTC unless they include an offset. "Is one of" takes a list or comma-separated text.',
    ),
  }),
  output: z.object({ matched: z.boolean() }),
  branches: {
    kind: "static",
    branches: [
      { id: "if", label: "If" },
      { id: "else", label: "Else" },
    ],
  },
  run: ({ input }) => {
    const matched = evaluateRules(input.rules);
    return branch(matched ? "if" : "else", { matched });
  },
});

const SwitchCase = z.object({
  id: ui(z.string().regex(BRANCH_ID, "Use letters, digits, - and _ only"), { label: "ID" }),
  // Labelled as the cases editor shows them, so messages name what the user sees.
  label: ui(z.string(), { label: "Case name", placeholder: "Gold customers" }),
  value: ui(z.unknown(), { label: "Matches", placeholder: "gold" }),
});

/**
 * Routes to the first case whose value equals the input value (loosely, see `looseEquals`;
 * ignoring case unless `caseSensitive` is set), or to `default`.
 */
export const switchNode = defineNode({
  type: "core.switch",
  name: "Switch",
  description:
    "Compare a value with each case in order and take the path of the first match, or Default when none match.",
  icon: "route",
  category: "Logic",
  keywords: ["case", "route", "branch", "match"],
  summary: "Route by {{value}}",
  input: z.object({
    value: ui(z.unknown(), { label: "Value to match" }).describe(
      'Compared with each case. Numbers and text compare loosely, so "5" matches 5 and "EMEA" matches "emea".',
    ),
    caseSensitive: ui(z.boolean(), { label: "Match case" })
      .describe('Off by default, so "EMEA" matches "emea".')
      .optional(),
    cases: ui(
      z.array(SwitchCase).superRefine((cases, check) => {
        const seen = new Set<string>();
        cases.forEach((c, i) => {
          if (c.id === DEFAULT_BRANCH) {
            check.addIssue({
              code: "custom",
              path: [i, "id"],
              message: `Case ID "${DEFAULT_BRANCH}" is reserved for the Default branch`,
            });
          } else if (seen.has(c.id)) {
            check.addIssue({
              code: "custom",
              path: [i, "id"],
              message: `Case ID "${c.id}" is used twice`,
            });
          }
          seen.add(c.id);
        });
      }),
      { label: "Cases", widget: "cases" },
    ),
  }),
  output: z.object({ matched: z.string() }),
  branches: {
    kind: "fromConfig",
    configPath: "cases",
    idKey: "id",
    labelKey: "label",
    append: [{ id: DEFAULT_BRANCH, label: "Default" }],
  },
  run: ({ input }) => {
    const caseSensitive = input.caseSensitive ?? false;
    const hit = input.cases.find((c) => looseEquals(input.value, c.value, { caseSensitive }));
    const matched = hit ? hit.id : DEFAULT_BRANCH;
    return branch(matched, { matched });
  },
});

/**
 * Runs the `body` branch once per item, in order. The engine does the iterating: body steps see
 * `loop.item` and `loop.index`, and the step's output is `{ count, results }` where `results`
 * holds each iteration's last body step output.
 */
export const forEachNode = defineNode({
  type: "core.forEach",
  name: "For each",
  description:
    "Run the steps inside the loop once for every item in a list, one item at a time. Inside, use Loop item and Loop index.",
  icon: "repeat",
  category: "Logic",
  keywords: ["loop", "iterate", "each", "list"],
  summary: "For each item in {{items}}",
  input: z.object({
    items: ui(z.array(z.unknown()), { label: "List", refOnly: true }).describe(
      "A list from the trigger or an earlier step.",
    ),
  }),
  output: z.object({
    count: z.number().describe("How many items were processed."),
    results: z.array(z.unknown()).describe("The last step's output of each iteration."),
  }),
  branches: { kind: "loop", itemsField: "items", branch: "body" },
  // The engine iterates the items and builds `{ count, results }` itself.
  run: ({ input }) => loop(input.items),
});

/** Ends the run successfully; no further steps run. */
export const stopNode = defineNode({
  type: "core.stop",
  name: "Stop",
  description: "End the run here as a success. No later steps run.",
  icon: "circle-stop",
  category: "Logic",
  keywords: ["end", "exit", "halt", "finish"],
  endsRun: true,
  summary: "Stop the run",
  input: z.object({
    reason: ui(z.string(), {
      label: "Reason",
      placeholder: "Deal was not won",
    })
      .describe("Shown in the run history.")
      .optional(),
  }),
  run: ({ input }) => stop(input.reason),
});
