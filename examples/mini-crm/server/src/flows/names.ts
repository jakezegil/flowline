/**
 * Step display names for the demo workflows. The builder sets IDs only, so the flows name their
 * steps afterwards: the canvas then reads "Route by source" rather than "Switch".
 *
 * @module
 */
import type { Step, WorkflowDoc } from "@flowkit/core";

/**
 * A copy of `doc` with `names[stepId]` set as each step's `name`, at any depth.
 *
 * @throws Error if `names` has an ID that is not a step of `doc` (a typo would go unnoticed).
 */
export function withStepNames(doc: WorkflowDoc, names: Record<string, string>): WorkflowDoc {
  const unused = new Set(Object.keys(names));
  const visit = (steps: Step[]): Step[] =>
    steps.map((step) => {
      const name = names[step.id];
      unused.delete(step.id);
      const out: Step = { ...step, ...(name ? { name } : {}) };
      if (step.branches) {
        out.branches = Object.fromEntries(
          Object.entries(step.branches).map(([id, branch]) => [id, visit(branch)]),
        );
      }
      return out;
    });
  const steps = visit(doc.steps);
  if (unused.size > 0) {
    throw new Error(`${doc.id} has no steps ${[...unused].join(", ")}`);
  }
  return { ...doc, steps };
}
