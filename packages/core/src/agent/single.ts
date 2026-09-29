/**
 * Single-step command handlers: `addStep`, `removeStep`, `moveStep`, `setConfig`.
 *
 * @module
 */
import { isValidStepId, RESERVED_STEP_IDS, STEP_ID_PATTERN } from "../ids";
import { branchesFor } from "../json-schema";
import { createStep, jsonEqual, syncBranches } from "../step-factory";
import {
  allStepIds,
  branchList,
  findStep,
  generateStepId,
  insertStep,
  moveStep,
  removeStep,
  type StepLocation,
  updateStep,
} from "../tree";
import type { NodeManifest, Step, ValueExpr, WorkflowDoc } from "../types";
import { formatPath } from "./command-schema";
import {
  type At,
  type Command,
  CommandFailure,
  closest,
  type Handler,
  type HandlerContext,
  type StepRef,
} from "./commands";
import { resolveStepRef, resolveValuePlaceholders } from "./placeholders";

type Cmd<Op extends Command["op"]> = Extract<Command, { op: Op }>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `a.b` joined for handler paths (`at.in.branch`, `config.to`, `config["a-b"]`). */
function join(base: string, seg: string | number): string {
  return base === "" ? formatPath([seg]) : `${base}${formatPath(["x", seg]).slice(1)}`;
}

/** @internal The real ID a placeholder names, recorded as used; throws `placeholder.unknown`. */
export function placeholderId(ctx: HandlerContext, ref: StepRef, path: string): string {
  if (typeof ref !== "string") {
    throw new CommandFailure("command.invalid", "A step ID must be a string", path);
  }
  const id = resolveStepRef(ref, ctx.placeholders);
  if (id === undefined) {
    throw new CommandFailure("placeholder.unknown", `Unknown placeholder "${ref}"`, path, {
      defined: [...ctx.placeholders.keys()],
      note: "$n is the result of commands[n-1]",
    });
  }
  if (ref !== id) ctx.used.set(ref, id);
  return id;
}

/** @internal An existing step's ID for `ref`; throws `placeholder.unknown` or `step.notFound`. */
export function existingStep(
  doc: WorkflowDoc,
  ctx: HandlerContext,
  ref: StepRef,
  path: string,
): { id: string; step: Step; location: StepLocation } {
  const id = placeholderId(ctx, ref, path);
  const found = findStep(doc, id);
  if (!found) {
    throw new CommandFailure("step.notFound", `Step "${id}" not found`, path, {
      closest: closest(id, allStepIds(doc), 5),
    });
  }
  return { id, step: found.step, location: found.location };
}

/** @internal `v` with its placeholders resolved; throws `placeholder.unknown`. */
export function resolvedValue(ctx: HandlerContext, v: ValueExpr, path: string): ValueExpr {
  const r = resolveValuePlaceholders(v, ctx.placeholders, ctx.used);
  if (r.unknown !== undefined) {
    throw new CommandFailure("placeholder.unknown", `Unknown placeholder "${r.unknown}"`, path, {
      defined: [...ctx.placeholders.keys()],
      note: "$n is the result of commands[n-1]",
    });
  }
  return r.value;
}

/** @internal The node manifest of `type`; throws `node.unknown` with the closest types. */
export function nodeOf(ctx: HandlerContext, type: unknown, path: string): NodeManifest {
  const node = typeof type === "string" ? ctx.nodes.get(type) : undefined;
  if (!node) {
    throw new CommandFailure("node.unknown", `Unknown node type "${String(type)}"`, path, {
      closest: closest(String(type), ctx.nodes.keys(), 10),
    });
  }
  return node;
}

/** The valid `At` forms, as a hint. */
export const AT_HINT = {
  expected: [
    "{ after: stepId }",
    "{ before: stepId }",
    "{ in: { stepId, branch }, index? }",
    "{ start: true }",
  ],
};

/** The step ID rule, as a hint. */
const ID_RULE = `Start with a letter or underscore, then letters, digits and underscores only; not ${[...RESERVED_STEP_IDS].join(", ")}`;

/** Every step ID in `step`'s subtree, `step` included. */
function subtree(step: Step, into = new Set<string>()): Set<string> {
  into.add(step.id);
  for (const list of Object.values(step.branches ?? {})) for (const s of list) subtree(s, into);
  return into;
}

/**
 * @internal Resolves `at` to a location in `doc`, creating a declared branch the owner doesn't
 * hold yet (so the returned doc may differ). `exclude` is a moved step's subtree: anchors in it
 * fail with `move.intoSelf`.
 */
export function locate(
  doc: WorkflowDoc,
  ctx: HandlerContext,
  at: At,
  path: string,
  exclude?: Set<string>,
): { doc: WorkflowDoc; loc: StepLocation } {
  if (!isObject(at)) {
    throw new CommandFailure("location.invalid", "Missing location", path, AT_HINT);
  }
  const intoSelf = (p: string) =>
    new CommandFailure(
      "move.intoSelf",
      "A step can't be moved next to or into a step inside itself",
      p,
      {
        expected: "a location outside the moved step's subtree",
        subtree: [...(exclude ?? [])].slice(0, 20),
      },
    );
  if ("after" in at || "before" in at) {
    const key = "after" in at ? "after" : "before";
    const p = join(path, key);
    const ref = (at as Record<string, StepRef>)[key] as StepRef;
    const anchor = placeholderId(ctx, ref, p);
    if (exclude?.has(anchor)) throw intoSelf(p);
    const found = existingStep(doc, ctx, ref, p);
    const { parentId, branch, index } = found.location;
    return {
      doc,
      loc: {
        parentId,
        ...(branch !== undefined ? { branch } : {}),
        index: index + (key === "after" ? 1 : 0),
      },
    };
  }
  if ("in" in at) {
    const target = at.in as unknown;
    if (!isObject(target)) {
      throw new CommandFailure(
        "location.invalid",
        "`in` needs a stepId and a branch",
        path,
        AT_HINT,
      );
    }
    const ownerPath = join(join(path, "in"), "stepId");
    const ownerId = placeholderId(ctx, target.stepId as StepRef, ownerPath);
    if (exclude?.has(ownerId)) throw intoSelf(ownerPath);
    const owner = existingStep(doc, ctx, target.stepId as StepRef, ownerPath);
    const branch = target.branch;
    const node = ctx.nodes.get(owner.step.type);
    const held = typeof branch === "string" ? branchList(owner.step, branch) : undefined;
    const declared = node ? branchesFor(node, owner.step).map((b) => b.id) : [];
    if (!held && !(typeof branch === "string" && declared.includes(branch))) {
      const branches = [...new Set([...declared, ...Object.keys(owner.step.branches ?? {})])];
      throw new CommandFailure(
        "branch.unknown",
        `Step "${owner.id}" has no branch "${String(branch)}"`,
        join(join(path, "in"), "branch"),
        { branches },
      );
    }
    const b = branch as string;
    const list = held ?? [];
    const index = at.index ?? list.length;
    if (!Number.isInteger(index) || index < 0 || index > list.length) {
      throw new CommandFailure(
        "location.invalid",
        `Index ${String(index)} is out of range [0, ${list.length}] for branch "${b}" of "${owner.id}"`,
        join(path, "index"),
        { expected: `an integer from 0 to ${list.length}`, min: 0, max: list.length },
      );
    }
    const next = held
      ? doc
      : updateStep(doc, owner.id, (s) => ({ ...s, branches: { ...s.branches, [b]: [] } }));
    return { doc: next, loc: { parentId: owner.id, branch: b, index } };
  }
  if ("start" in at && at.start === true) return { doc, loc: { parentId: null, index: 0 } };
  throw new CommandFailure(
    "location.invalid",
    "A location is { after }, { before }, { in: { stepId, branch }, index? } or { start: true }",
    path,
    AT_HINT,
  );
}

const addStep: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"addStep">;
  const node = nodeOf(ctx, cmd.type, "type");
  let id: string;
  if (cmd.id !== undefined) {
    if (!isValidStepId(cmd.id)) {
      throw new CommandFailure(
        "id.invalid",
        `Step ID "${String(cmd.id)}" must start with a letter or underscore and contain only letters, digits and underscores`,
        "id",
        {
          rule: ID_RULE,
          pattern: STEP_ID_PATTERN.source,
          suggested: generateStepId(doc, String(cmd.id)),
        },
      );
    }
    if (allStepIds(doc).has(cmd.id)) {
      throw new CommandFailure("id.taken", `Step ID "${cmd.id}" is already used`, "id", {
        suggested: generateStepId(doc, cmd.id),
      });
    }
    id = cmd.id;
  } else {
    id = generateStepId(doc, node.type);
  }
  if (cmd.config !== undefined && !isObject(cmd.config)) {
    throw new CommandFailure("command.invalid", "config must be an object", "config");
  }
  const config = cmd.config
    ? (resolvedValue(ctx, cmd.config, "config") as Record<string, ValueExpr>)
    : {};
  const created = createStep(id, node);
  let step: Step = syncBranches({ ...created, config: { ...created.config, ...config } }, node);
  if (cmd.name !== undefined) step = { ...step, name: cmd.name };
  if (cmd.disabled === true) step = { ...step, disabled: true };
  if (cmd.note !== undefined) step = { ...step, note: cmd.note };
  if (cmd.color !== undefined) step = { ...step, color: cmd.color };
  const { doc: placed, loc } = locate(doc, ctx, cmd.at, "at");
  return { doc: insertStep(placed, loc, step), created: id };
};

const removeStepHandler: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"removeStep">;
  const { id } = existingStep(doc, ctx, cmd.id, "id");
  return { doc: removeStep(doc, id) };
};

const moveStepHandler: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"moveStep">;
  const { id, step, location: from } = existingStep(doc, ctx, cmd.id, "id");
  const inside = subtree(step);
  const to = cmd.to as unknown;
  // Next to itself: its own position.
  if (isObject(to) && (to.after !== undefined || to.before !== undefined)) {
    const ref = (to.after ?? to.before) as StepRef;
    if (placeholderId(ctx, ref, join("to", to.after !== undefined ? "after" : "before")) === id) {
      return { doc };
    }
  }
  // Check the anchor on the full doc (and create a declared branch the owner lacks), then
  // resolve it against the doc without the moved step.
  const { doc: prepared } = locate(doc, ctx, cmd.to, "to", inside);
  const { loc } = locate(removeStep(prepared, id), ctx, cmd.to, "to", inside);
  const same =
    loc.parentId === from.parentId &&
    (loc.parentId === null || loc.branch === from.branch) &&
    loc.index === from.index;
  if (same) return { doc };
  return { doc: moveStep(prepared, id, loc) };
};

const setConfig: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setConfig">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  const config = step.config;
  let next: Record<string, ValueExpr> | undefined;
  const set = (key: string, value: ValueExpr | null, remove: boolean, path: string) => {
    const cur = next ?? config;
    if (remove) {
      if (!Object.hasOwn(cur, key)) return;
      const { [key]: _, ...rest } = cur;
      next = rest;
      return;
    }
    const v = resolvedValue(ctx, value as ValueExpr, path);
    if (Object.hasOwn(cur, key) && jsonEqual(cur[key], v)) return;
    next = { ...cur, [key]: v };
  };
  if ("config" in cmd) {
    if (!isObject(cmd.config)) {
      throw new CommandFailure("command.invalid", "config must be an object", "config");
    }
    for (const [key, value] of Object.entries(cmd.config)) {
      set(key, value, value === null, join("config", key));
    }
  } else {
    if (typeof cmd.key !== "string" || cmd.key === "") {
      throw new CommandFailure("command.invalid", "key must be a non-empty string", "key");
    }
    // `undefined` (only reachable in trusted mode) removes, as the editor's setConfig does.
    const remove =
      (cmd.value === null && cmd.nullIsValue !== true) || (cmd.value as unknown) === undefined;
    set(cmd.key, cmd.value, remove, "value");
  }
  if (next === undefined) return { doc };
  const node = ctx.nodes.get(step.type);
  const updated: Step = { ...step, config: next };
  const synced = node ? syncBranches(updated, node) : updated;
  return { doc: updateStep(doc, id, () => synced) };
};

/** @internal The single-step handlers by op. */
export const singleHandlers: Record<string, Handler> = {
  addStep,
  removeStep: removeStepHandler,
  moveStep: moveStepHandler,
  setConfig,
};
