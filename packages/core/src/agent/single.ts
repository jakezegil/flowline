/**
 * Single-step command handlers: `addStep`, `removeStep`, `moveStep`, `setConfig`,
 * `duplicateStep`, `renameStep`, `renameStepId`, `setType`, `setDisabled`, `setNote`,
 * `setColor`, plus the trigger, output and workflow-name commands.
 *
 * @module
 */
import { ANNOTATION_COLORS, isAnnotationColor, NOTE_MAX_CHARS } from "../annotations";
import { isValidStepId, RESERVED_STEP_IDS, STEP_ID_PATTERN } from "../ids";
import { branchesFor } from "../json-schema";
import {
  copyName,
  createStep,
  defaultConfig,
  jsonEqual,
  replaceStepType,
  syncBranches,
} from "../step-factory";
import {
  allStepIds,
  branchList,
  codeBlocksRename,
  duplicateStep,
  findStep,
  generateStepId,
  insertStep,
  isGeneratedStepId,
  moveStep,
  removeStep,
  renameStepId,
  type StepLocation,
  updateStep,
  walkSteps,
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
  type PlaceholderKind,
  type StepRef,
} from "./commands";
import { resolveStepRef, resolveValuePlaceholders } from "./placeholders";

type Cmd<Op extends Command["op"]> = Extract<Command, { op: Op }>;

/** @internal Whether `v` is a plain (non-array) object. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `a.b` joined for handler paths (`at.in.branch`, `config.to`, `config["a-b"]`). */
function join(base: string, seg: string | number): string {
  return base === "" ? formatPath([seg]) : `${base}${formatPath(["x", seg]).slice(1)}`;
}

/** Every placeholder defined so far, of both kinds, in batch order. */
function definedPlaceholders(ctx: HandlerContext): string[] {
  const all = [...ctx.placeholders.keys(), ...ctx.sectionPlaceholders.keys()];
  const n = (p: string) => (/^\$[0-9]+$/.test(p) ? Number(p.slice(1)) : Number.POSITIVE_INFINITY);
  return all.sort((a, b) => n(a) - n(b));
}

/** @internal The `placeholder.unknown` failure for `ref`. */
export function unknownPlaceholder(ctx: HandlerContext, ref: string, path: string): CommandFailure {
  return new CommandFailure("placeholder.unknown", `Unknown placeholder "${ref}"`, path, {
    defined: definedPlaceholders(ctx),
    note: "$n is the result of commands[n-1]",
  });
}

/** @internal The `placeholder.kind` failure: `ref` names a `got` where a `want` ID goes. */
export function wrongKind(
  ref: string,
  got: PlaceholderKind,
  want: PlaceholderKind,
  path: string,
): CommandFailure {
  const by = /^\$[0-9]+$/.test(ref) ? ` (created by commands[${Number(ref.slice(1)) - 1}])` : "";
  return new CommandFailure(
    "placeholder.kind",
    `Placeholder "${ref}" names a ${got}, but this argument takes a ${want} ID`,
    path,
    {
      expected: want,
      got,
      note: `${ref} names a ${got}${by}; this argument takes a ${want} ID`,
    },
  );
}

/**
 * @internal The real step ID a step argument names (a placeholder resolved, and recorded as
 * used); throws `placeholder.unknown`, or `placeholder.kind` for a section's placeholder.
 */
export function placeholderId(ctx: HandlerContext, ref: StepRef, path: string): string {
  if (typeof ref !== "string") {
    throw new CommandFailure("command.invalid", "A step ID must be a string", path);
  }
  const id = resolveStepRef(ref, ctx.placeholders);
  if (id === undefined) {
    if (ctx.sectionPlaceholders.has(ref)) throw wrongKind(ref, "section", "step", path);
    throw unknownPlaceholder(ctx, ref, path);
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

/**
 * @internal `v` with its placeholders resolved; throws `placeholder.unknown`, or
 * `placeholder.kind` for a section's placeholder in a `steps.$n` reference.
 */
export function resolvedValue(ctx: HandlerContext, v: ValueExpr, path: string): ValueExpr {
  const r = resolveValuePlaceholders(v, ctx.placeholders, ctx.used);
  if (r.unknown !== undefined) {
    // `steps.$n` is a step reference: a section's placeholder has no output to read.
    if (ctx.sectionPlaceholders.has(r.unknown)) throw wrongKind(r.unknown, "section", "step", path);
    throw unknownPlaceholder(ctx, r.unknown, path);
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

/** Throws `id.invalid` or `id.taken` unless `id` can name a new step in `doc`. */
function checkNewStepId(doc: WorkflowDoc, id: unknown, path: string): void {
  if (!isValidStepId(id as string)) {
    throw new CommandFailure(
      "id.invalid",
      `Step ID "${String(id)}" must start with a letter or underscore and contain only letters, digits and underscores`,
      path,
      {
        rule: ID_RULE,
        pattern: STEP_ID_PATTERN.source,
        suggested: generateStepId(doc, String(id)),
      },
    );
  }
  if (allStepIds(doc).has(id as string)) {
    throw new CommandFailure("id.taken", `Step ID "${String(id)}" is already used`, path, {
      suggested: generateStepId(doc, id as string),
    });
  }
}

/** @internal Every step ID in `step`'s subtree, `step` included. */
export function subtree(step: Step, into = new Set<string>()): Set<string> {
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
    checkNewStepId(doc, cmd.id, "id");
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

/** The two forms of a config edit (setConfig, setTriggerConfig, setOutput). */
type ConfigEdit =
  | { key: string; value: ValueExpr | null; nullIsValue?: boolean }
  | { config: Record<string, ValueExpr | null> };

/**
 * @internal Whether the batch runs in trusted mode (`apply(…, { trusted: true })`), which `apply`
 * records as `trusted` on the handler context.
 */
export function isTrustedBatch(ctx: HandlerContext): boolean {
  return ctx.trusted === true;
}

/**
 * @internal A config, trigger-config or output value with its placeholders resolved. In trusted
 * mode (the editor's setters) a `steps.$x` that no placeholder of the batch defines stays as it
 * is, as a verbatim paste keeps it, so these setters accept any value; otherwise it fails with
 * `placeholder.unknown`. A section's placeholder in a step reference fails in both modes.
 */
function configValue(ctx: HandlerContext, v: ValueExpr, path: string): ValueExpr {
  if (!isTrustedBatch(ctx)) return resolvedValue(ctx, v, path);
  const r = resolveValuePlaceholders(v, ctx.placeholders, ctx.used);
  if (r.unknown !== undefined && ctx.sectionPlaceholders.has(r.unknown)) {
    throw wrongKind(r.unknown, "section", "step", path);
  }
  return r.value;
}

/**
 * @internal `config` with `edit` applied (placeholders resolved, see {@link configValue}), or
 * `undefined` when nothing changes. The key form sets one key: `null` removes it unless
 * `nullIsValue`, and `undefined` (only reachable in trusted mode) removes it, as the editor's
 * setters do. The `config` form merges, and `null` removes.
 */
export function patchConfig(
  ctx: HandlerContext,
  config: Record<string, ValueExpr>,
  edit: ConfigEdit,
): Record<string, ValueExpr> | undefined {
  let next: Record<string, ValueExpr> | undefined;
  const set = (key: string, value: ValueExpr | null, remove: boolean, path: string) => {
    const cur = next ?? config;
    if (remove) {
      if (!Object.hasOwn(cur, key)) return;
      const { [key]: _, ...rest } = cur;
      next = rest;
      return;
    }
    const v = configValue(ctx, value as ValueExpr, path);
    if (Object.hasOwn(cur, key) && jsonEqual(cur[key], v)) return;
    next = { ...cur, [key]: v };
  };
  if ("config" in edit) {
    if (!isObject(edit.config)) {
      throw new CommandFailure("command.invalid", "config must be an object", "config");
    }
    for (const [key, value] of Object.entries(edit.config)) {
      set(key, value, value === null, join("config", key));
    }
  } else {
    if (typeof edit.key !== "string" || edit.key === "") {
      throw new CommandFailure("command.invalid", "key must be a non-empty string", "key");
    }
    const remove =
      (edit.value === null && edit.nullIsValue !== true) || (edit.value as unknown) === undefined;
    set(edit.key, edit.value, remove, "value");
  }
  return next;
}

const setConfig: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setConfig">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  const next = patchConfig(ctx, step.config, cmd);
  if (next === undefined) return { doc };
  const node = ctx.nodes.get(step.type);
  const updated: Step = { ...step, config: next };
  const synced = node ? syncBranches(updated, node) : updated;
  return { doc: updateStep(doc, id, () => synced) };
};

/**
 * @internal Records that step `from` is now `to`: `renamed` keeps one old → new entry per step
 * of the input doc (dropped when a step is renamed back), and step placeholders (and their
 * `ids` entries) that named `from` now name `to`. Section placeholders are left alone, even when
 * a section has the same ID as the step.
 */
export function recordRename(ctx: HandlerContext, from: string, to: string): void {
  if (from === to) return;
  let chained = false;
  for (const [old, now] of ctx.renamed) {
    if (now !== from) continue;
    chained = true;
    if (old === to) ctx.renamed.delete(old);
    else ctx.renamed.set(old, to);
  }
  if (!chained) ctx.renamed.set(from, to);
  for (const [k, v] of ctx.placeholders) {
    if (v !== from) continue;
    ctx.placeholders.set(k, to);
    if (ctx.used.has(k)) ctx.used.set(k, to);
  }
}

/** @internal A step's display name: its own name, else its node's, else its ID. */
export function displayName(step: Step, ctx: HandlerContext): string {
  return step.name ?? ctx.nodes.get(step.type)?.name ?? step.id;
}

const duplicateStepHandler: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"duplicateStep">;
  const { id } = existingStep(doc, ctx, cmd.id, "id");
  const { doc: copied, newId } = duplicateStep(doc, id);
  const copy = findStep(copied, newId)?.step as Step;
  const taken = new Set<string>();
  walkSteps(copied, (s) => taken.add(displayName(s, ctx)));
  const name = copyName(displayName(copy, ctx), taken);
  return { doc: updateStep(copied, newId, (s) => ({ ...s, name })), created: newId };
};

const renameStepHandler: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"renameStep">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  if (typeof cmd.name !== "string") {
    throw new CommandFailure("command.invalid", "name must be a string", "name");
  }
  const name = cmd.name.trim();
  if ((step.name ?? "") === name) return { doc };
  const { name: _, ...rest } = step;
  return { doc: updateStep(doc, id, () => (name === "" ? rest : { ...rest, name })) };
};

const renameStepIdHandler: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"renameStepId">;
  const { id } = existingStep(doc, ctx, cmd.id, "id");
  if (cmd.newId === id) return { doc, created: id };
  checkNewStepId(doc, cmd.newId, "newId");
  const next = renameStepId(doc, id, cmd.newId, ctx.manifest);
  recordRename(ctx, id, cmd.newId);
  return { doc: next, created: cmd.newId };
};

const setType: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setType">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  const node = nodeOf(ctx, cmd.type, "type");
  if (step.type === node.type) return { doc, created: id };
  const replaced = replaceStepType(doc, id, node);
  // As the editor's Replace: an ID generated from the old type would misname the step, so it is
  // regenerated (and references follow), unless code reads the step in a way a rename breaks.
  if (
    !isGeneratedStepId(id, step.type) ||
    isGeneratedStepId(id, node.type) ||
    codeBlocksRename(replaced, id, ctx.manifest)
  ) {
    return { doc: replaced, created: id };
  }
  const free = generateStepId(replaced, node.type);
  const next = renameStepId(replaced, id, free, ctx.manifest);
  recordRename(ctx, id, free);
  return { doc: next, created: free };
};

const setDisabled: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setDisabled">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  const disabled = cmd.disabled === true;
  if ((step.disabled === true) === disabled) return { doc };
  const { disabled: _, ...rest } = step;
  return { doc: updateStep(doc, id, () => (disabled ? { ...rest, disabled: true } : rest)) };
};

const setNote: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setNote">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  const note = cmd.note ?? "";
  if (typeof note !== "string" || note.length > NOTE_MAX_CHARS) {
    throw new CommandFailure(
      "command.invalid",
      `A note is a string of at most ${NOTE_MAX_CHARS} characters, or null`,
      "note",
      { expected: { type: ["string", "null"], maxLength: NOTE_MAX_CHARS } },
    );
  }
  if ((step.note ?? "") === note) return { doc };
  const { note: _, ...rest } = step;
  return { doc: updateStep(doc, id, () => (note === "" ? rest : { ...rest, note })) };
};

const setColor: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setColor">;
  const { id, step } = existingStep(doc, ctx, cmd.id, "id");
  const color = cmd.color ?? undefined;
  if (color !== undefined && !isAnnotationColor(color)) {
    throw new CommandFailure(
      "command.invalid",
      `A colour is one of ${ANNOTATION_COLORS.join(", ")}, or null`,
      "color",
      { expected: { enum: [...ANNOTATION_COLORS, null] } },
    );
  }
  if (step.color === color) return { doc };
  const { color: _, ...rest } = step;
  return { doc: updateStep(doc, id, () => (color === undefined ? rest : { ...rest, color })) };
};

const setTrigger: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"setTrigger">;
  const t = ctx.manifest.triggers.find((x) => x.type === cmd.type);
  if (!t) {
    throw new CommandFailure(
      "trigger.unknown",
      `Unknown trigger type "${String(cmd.type)}"`,
      "type",
      {
        closest: closest(
          String(cmd.type),
          ctx.manifest.triggers.map((x) => x.type),
          10,
        ),
      },
    );
  }
  const same = doc.trigger.type === t.type;
  if (same && cmd.config === undefined) return { doc };
  const start = same ? doc.trigger.config : defaultConfig(t.config);
  const merged = cmd.config === undefined ? undefined : patchConfig(ctx, start, cmd as ConfigEdit);
  if (same && merged === undefined) return { doc };
  return { doc: { ...doc, trigger: { type: t.type, config: merged ?? start } } };
};

const setTriggerConfig: Handler = (doc, command, ctx) => {
  const next = patchConfig(ctx, doc.trigger.config, command as ConfigEdit);
  if (next === undefined) return { doc };
  return { doc: { ...doc, trigger: { ...doc.trigger, config: next } } };
};

const setOutput: Handler = (doc, command, ctx) => {
  const next = patchConfig(ctx, doc.output ?? {}, command as ConfigEdit);
  if (next === undefined) return { doc };
  const { output: _, ...rest } = doc;
  return { doc: Object.keys(next).length > 0 ? { ...rest, output: next } : rest };
};

const renameWorkflow: Handler = (doc, command) => {
  const cmd = command as Cmd<"renameWorkflow">;
  if (typeof cmd.name !== "string") {
    throw new CommandFailure("command.invalid", "name must be a string", "name");
  }
  const name = cmd.name.trim();
  // A blank name is refused by the shape check; trusted callers get the editor's no-op.
  if (name === "" || name === doc.name) return { doc };
  return { doc: { ...doc, name } };
};

/** @internal The single-step handlers by op. */
export const singleHandlers: Record<string, Handler> = {
  addStep,
  removeStep: removeStepHandler,
  moveStep: moveStepHandler,
  setConfig,
  duplicateStep: duplicateStepHandler,
  renameStep: renameStepHandler,
  renameStepId: renameStepIdHandler,
  setType,
  setDisabled,
  setNote,
  setColor,
  setTrigger,
  setTriggerConfig,
  setOutput,
  renameWorkflow,
};
