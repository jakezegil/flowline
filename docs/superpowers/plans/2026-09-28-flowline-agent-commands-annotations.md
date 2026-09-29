# Flowline Agent Commands, Reads & Canvas Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `0.3.0`: step notes, step colours and sections as optional doc fields that the tree ops keep intact; budgeted reads for agents; one atomic `apply(doc, commands, manifest)` command API (single-step, bulk add, bulk edit, bulk restructure, sections) with a manifest-derived tool catalog; the React editor rebuilt on `apply` with a host agent bridge; sections and notes drawn on the canvas with range selection and menus; and Backspace/Delete that works while the config panel has focus.

**Architecture:** Everything new in the model, reads and commands lives in `@flowlinejs/core` as pure, isomorphic functions (a new `src/agent/` folder, plus `src/annotations.ts` for the model and section upkeep). `@flowlinejs/react` re-implements `EditorActions` as thin wrappers over a store-level `apply`, adds `useWorkflowAgentBridge`, reserves layout space for sections and notes in `layoutTree`, and renders them as extra xyflow nodes. The engine does not change behaviour: it ignores the new fields, which a test pins.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.9 strict, Zod 4 (peer dependency), Vitest 5, tsup, Biome 2, React 19, @xyflow/react 12, Zustand 5, Radix menus, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-flowline-agent-commands-annotations-design.md` (binding; read it in full first; § numbers below refer to it). Format reference: `docs/superpowers/plans/2026-09-28-flowline-triggers-conditions.md`.

## Global Constraints

- **Precondition:** the triggers/conditions batch (0.2.0) is fully merged on `flowkit-v1`, including its Task 11 (mini-crm `dealStuckInStage` poll trigger, `crm.getDeal`, `crm.getUser`, `flows/deal-stuck.ts` exporting `dealStuckFlow`) and Task 12 (docs). If `examples/mini-crm/server/src/flows/deal-stuck.ts` does not exist when Task 6 starts, stop and report to the controller; do not recreate it here.
- Integration branch `flowkit-v1`. Package scope `@flowlinejs/*`; never introduce a `flowkit` identifier.
- All packages ESM-only, `"type": "module"`, TS `strict: true`, `noUncheckedIndexedAccess: true`. Zod 4 is a **peer dependency** of core (import `{ z } from "zod"`, never `zod/v3`); do not add runtime dependencies to any package.
- Dev resolution: package `exports` resolve to `./src` only under the `flowline-source` condition. Every new dev entry point (vitest/vite config, `tsx --conditions=flowline-source`, Playwright webServer) sets it.
- `@flowlinejs/core` and `@flowlinejs/react` never import from `@flowlinejs/engine`, `nodes-builtin`, Node built-ins, or anything server-only.
- Biome formats and lints everything (`lineWidth: 100`, double quotes). Vitest for all tests; run one file with `pnpm vitest run --project <core|react|engine|mini-crm> <path>`.
- **Gate order**, run in this order before a task is done: `pnpm install`, `pnpm build` (must run before tests), `pnpm test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm --filter @flowlinejs/example-mini-crm e2e` (Playwright on ports 8921/5421; required for Tasks 9–12, recommended otherwise), `pnpm test:scripts`.
- Every new piece of UI text goes through `packages/react/src/labels.ts` (`FlowlineLabels` + `defaultLabels`, overridable via `<FlowlineProvider labels>`); no hard-coded UI strings. Core issue and error messages stay English, as today.
- CSS lives in `packages/react/src/styles.css` inside `@layer flowline`, uses `fl-` class names and `--fl-` tokens only, no hard-coded colours outside the token blocks; every new colour token has light and dark values and is duplicated identically in the `[data-fl-theme="dark"]` block and the `prefers-color-scheme` block.
- Every public export has TSDoc. New public names are exported from the package `index.ts`.
- **No changesets until Task 13.** Task 13 adds one `minor` changeset naming all six packages (the Changesets `fixed` group in `.changeset/config.json` keeps them on one version).
- Any task that changes a public API documented in `README.md`, `packages/*/README.md` or `docs/guides/writing-a-plugin.md` updates those snippets in the same task (the `examples/docs-check` suite typechecks them).
- Commits: conventional commits, one per task (review fixes may add more), each message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Existing behaviour is the regression baseline: `packages/react/src/store/editor-store.test.ts`, `canvas/canvas.test.tsx`, `layout/layout-tree.test.ts` (including its snapshot file) and the existing mini-crm e2e specs must pass **unchanged** after every task.

## Review Focus

1. **Section endpoints under edits and undo.** Deleting, moving, renaming the ID of, retyping, duplicating, wrapping or unwrapping the `first` or `last` step of a section, then undoing: the section never names a missing step or spans two lists; it shrinks to the nearest remaining member or is removed; undo restores the exact previous `sections` array. (Tests in Tasks 1, 5, 7.)
2. **A batch that fails half-way.** A batch whose third command fails after two commands that generated IDs and used `$1` inside a `{{steps.$1.…}}` template in a nested fragment branch: `ok: false`, the error names `commands[2]…` with a hint, and the caller's doc object is returned untouched (`toBe` the input, deep-equal to a pre-call clone). In the editor, nothing is added to history and nothing is flashed. (Tests in Tasks 3, 4, 7.)
3. **Hand-edited and legacy docs.** A doc with no `sections`, `sections: []`, a section whose `first` is missing, whose `first`/`last` are in different lists or reversed, two overlapping sections, a colour outside the six (`"red"`), and a 5000-char note: it loads, validates with warnings only, reads and lays out without throwing, the canvas renders the unknown colour as `gray`, and the editor's Fix action repairs each. (Tests in Tasks 1, 2, 8, 9, 10.)
4. **Huge and deep workflows.** 500 flat top-level steps, 12 levels of nested conditions, a 20 000-char config string and 4000-char notes: `overview`/`outline` stay within `budget` characters, every collapse marker's structured follow-up, when executed, returns the hidden steps, and `focus`/`getSteps` cut long strings with `…(+N chars)` unless `full: true`. (Tests in Task 2.)
5. **Backspace while typing.** Backspace or Delete in the inline rename input, the panel name input, a config text field, a CodeMirror editor, the data-picker search, the note textarea and the section title input never deletes a step; in the panel on a non-text control it deletes the selection exactly once with the undo toast. (Tests in Task 11, e2e in Task 12.)

Also exercised: selector with `expect: 0` that matches nothing succeeds as a no-op; `apply([])` returns `ok: true` with the same doc; a read-only editor rejects `apply` with `code: "readOnly"`; a doc from before 0.3.0 runs identically on the engine.

## Decisions the spec leaves open (binding for this plan)

These close gaps in the spec. Each is repeated in the task that owns it.

- **Placeholders.** `$n` is **1-based**: `$1` is the step (or section) created by `commands[0]`. A fragment step with `ref: "deal"` is addressed as `$deal`. Placeholders are accepted in every step-ID and section-ID argument and inside `$ref` paths and `$tpl` strings as `steps.$1…` / `steps.$deal…`. `$` never appears in a real step ID, so there is no ambiguity. `ids` maps every placeholder used or created (`"$1"`, `"$deal"`) to the real ID.
- **What `apply` rejects vs. reports.** `apply` rejects (`ok: false`) structural problems: unknown step/section/node/trigger types, invalid locations, unknown branches, taken or invalid IDs, invalid runs, overlap on `addSection`, `expect` mismatches, command shape errors, and, **for fragments only**, validation issues with codes `node.unknown`, `branch.unknown`, `config.invalid`, `ref.syntax`, `ref.unresolved`, `ref.outOfScope`, `step.invalidId`, `step.duplicateId`. Everything else (`config.required`, all warnings) is reported in `issues.added`. `setConfig` never rejects a value: the editor must keep accepting half-typed input.
- **`setConfig` and `null`.** Per spec, `null` removes a key. To store a literal `null`, pass `nullIsValue: true` on the command (the editor store does this when its `setConfig` receives `null`; `undefined` maps to removal).
- **Extra commands.** `setType { id, type }` (the editor's Replace; config resets, children kept, generated IDs regenerated exactly like today's `replaceStep`) is added, because `EditorActions.replaceStep` has no spec command. `insertSteps`' `at` accepts every `At` form.
- **`At` forms.** `{ after: id }`, `{ before: id }`, `{ in: { stepId, branch }, index? }`, `{ start: true }` (top of the top-level list). For `moveStep`/`moveSteps` the anchor is resolved **after** the moved steps are removed, like today's `moveStep`.
- **Reads signatures.** All doc reads take `(doc, manifest, …)` in that order, including `getSteps(doc, manifest, ids, opts)` (the spec's `getSteps(doc, ids, …)` has no manifest, but `include: ["schema", "refs"]` needs one). Every read's last options argument also accepts `ctx?: ValidationContext`.
- **`outline` on the top level.** `outline` takes `stepId?` (omitted = the top-level list) and `after?` (start after this step ID in that list), so a flat 500-step list can be paged; collapse markers for long lists point at `outline({ after })`.
- **Host glue.** Core adds `runTool(state, name, args)`, which executes one catalog tool call against `{ doc, manifest, ctx? }`; the bridge exposes the same. Without it a host cannot map catalog tool calls to reads and `apply`.
- **Bridge shape.** `useWorkflowAgentBridge(store?)` returns `{ read: BoundReads; apply; runTool }`, where `BoundReads` is `reads` with `doc`/`manifest`/`ctx` bound to the live editor (a host has no doc to pass). `<WorkflowEditor>` gains `onStoreReady?(store)` so a host can reach the store it creates internally.
- **Change highlight.** No change-highlight token exists today. Task 9 adds `--fl-changed` (derived from `--fl-accent`) and the `fl-flash` animation, honouring `prefers-reduced-motion`.
- **Range "move".** The canvas has no move UI today. Range (and single-step) move is **Move up / Move down** (⌥↑ / ⌥↓), which moves the run one position within its list.
- **Clipboard.** `EditorState.clipboard` becomes `Step[] | null` (a copied run). Listed as a breaking change in the changeset.
- **Section IDs.** Generated from the title (`"Check the deal"` → `check_the_deal`, max 32 chars, `section` when nothing usable remains, `_2`, `_3`… when taken); `addSection`/`insertSteps.section` accept an explicit `id?`.
- **Section issues** carry `stepId` = the section's `first` when that step exists (so the issues pill navigates to it) and a new optional `Issue.sectionId`.

## File structure (new or changed)

```
packages/core/src/
  types.ts                     AnnotationColor, Section, Step.note/color, WorkflowDoc.sections
  annotations.ts   (new)       ANNOTATION_COLORS, NOTE_MAX_CHARS, sectionRun, sectionOf, upkeepSections, sectionIssues, sectionIdFor
  tree.ts                      removeStep/moveStep/renameStepId/duplicateStep/updateStep keep sections intact
  validate.ts                  section.broken, section.overlap, note.tooLong; Issue.sectionId
  step-factory.ts  (new)       defaultConfig, syncBranches, createStep (moved from react/store/commands.ts)
  agent/
    format.ts      (new)       outline line format, budgets, truncation, collapse markers
    selectors.ts   (new)       Where, matchSteps
    reads.ts       (new)       overview, outline, focus, getSteps, findSteps, availableRefs, listNodeTypes, describeNodeTypes, getIssues, reads
    compact-schema.ts (new)    compactSchema (model-sized JSON Schema)
    commands.ts    (new)       Command union, At, Fragment, StepUpdate, ApplyResult, ApplyError, CommandErrorCode
    command-schema.ts (new)    Zod schemas of every command; commandSchema(manifest?)
    placeholders.ts (new)      placeholder resolution in IDs, $ref and $tpl
    apply.ts       (new)       apply, changedStepIds, issue delta, changed outline
    single.ts      (new)       single-step + section command handlers
    fragments.ts   (new)       insertSteps, replaceSteps, fragment build and validation
    bulk.ts        (new)       duplicateSteps, updateSteps, replaceInConfig, moveSteps, removeSteps, wrapSteps, unwrapStep
    repairs.ts     (new)       annotationRepairs
    catalog.ts     (new)       commandCatalog, ToolDefinition, runTool
  index.ts                     exports
packages/engine/src/annotations.test.ts (new)   annotated doc runs identically
packages/react/src/
  store/commands.ts            re-exports moved helpers; atFromLocation
  store/editor-store.ts        EditorActions on apply; range, readOnly, flash, clipboard: Step[]
  agent-bridge.ts  (new)       useWorkflowAgentBridge, BoundReads
  layout/constants.ts          NOTE_W, NOTE_GAP, SECTION_PAD, SECTION_HEADER_H
  layout/layout-tree.ts        asymmetric extents; sections[] and notes[] in the result
  canvas/geometry.ts           loop return routes outside section regions
  canvas/section-node.tsx (new) section region + header chip
  canvas/note-node.tsx (new)   sticky note card
  canvas/range-bar.tsx (new)   range toolbar
  canvas/step-card.tsx         data-color, data-flash, data-in-range, note in aria-label
  canvas/context-menu.tsx      Add note / Edit note, Color, range menu
  canvas/actions.ts            rangeActions, sectionActions, noteActions
  canvas/keyboard.ts           ⌘G, ⌥↑/⌥↓, ⇧↑/⇧↓, Delete matrix
  canvas/delete-key.ts (new)   editor-scope Delete/Backspace handler
  canvas/workflow-canvas.tsx   section/note nodes, shift-click
  editor/workflow-editor.tsx   onStoreReady, delete-key scope
  run/run-viewer.tsx           readOnly store
  labels.ts, theme.ts, styles.css, index.ts
  playground/fixtures.ts, playground/screenshot.mjs   annotated fixture, light/dark shots
examples/mini-crm/
  server/src/flows/deal-stuck.ts   sections and notes
  server/src/catalog.test.ts (new) commandCatalog snapshot
  server/src/agent-scenario.test.ts (new)
  e2e/annotations.spec.ts (new)
README.md, packages/core/README.md, packages/react/README.md, examples/mini-crm/README.md
.changeset/agent-commands-annotations.md (Task 13)
```

## Tasks and parallelism

| # | Task | Package(s) | Depends on | May run in parallel with |
|---|---|---|---|---|
| 1 | Doc model, section upkeep in tree ops, validation | core, engine (test only) | — | — |
| 2 | Reads and selectors | core | 1 | 8 |
| 3 | `apply`, single-step and section commands | core | 2 | 8 |
| 4 | Bulk add: `insertSteps`, `replaceSteps` | core | 3 | 8 |
| 5 | Bulk edit and restructure | core | 4 | 8 |
| 6 | Tool catalog and `runTool` | core, mini-crm (test) | 5 | 8 |
| 7 | Editor store on `apply` + agent bridge | react | 6 | — |
| 8 | Layout reserves space for sections and notes | react (`layout/` only) | 1 | 2–6 (disjoint packages) |
| 9 | Canvas rendering, palette, read-only, a11y | react | 7, 8 | — |
| 10 | Range selection and menus | react | 9 | — |
| 11 | Backspace/Delete everywhere | react | 10 | — |
| 12 | mini-crm annotations + e2e | mini-crm | 11 | — |
| 13 | Docs, agent scenario, changeset | docs, mini-crm, .changeset | 12 | — |

Task 8 touches only `packages/react/src/layout/*` and needs only Task 1's types, so it can run alongside Tasks 2–6 (core only). Tasks 2–6 all edit `packages/core/src/index.ts` and must run in order.

---

### Task 1: core — doc model, section upkeep in tree ops, validation issues

**Files:**
- Modify: `packages/core/src/types.ts` (Step, WorkflowDoc; new types)
- Create: `packages/core/src/annotations.ts`
- Modify: `packages/core/src/tree.ts` (`removeStep`, `moveStep`, `updateStep`, `renameStepId`, `duplicateStep`)
- Modify: `packages/core/src/validate.ts` (IssueCode, Issue.sectionId, WARNING_CODES, checks)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/annotations.test.ts` (new), `packages/core/src/tree.test.ts` (extend), `packages/core/src/validate.test.ts` (extend), `packages/engine/src/annotations.test.ts` (new)
- Docs: `README.md` "Tree model" (one paragraph: notes, colours and sections are optional, visual only, ignored by the engine)

**Interfaces**

Consumes: `findStep`, `walkSteps`, `StepLocation`, `isValidStepId`, `STEP_ID_PATTERN`.

Produces:
```ts
// types.ts
/** Colour of a note, step accent or section. */
export type AnnotationColor = "yellow" | "blue" | "green" | "pink" | "purple" | "gray";
interface Step {
  /** Sticky note pinned to this step. Plain text, ≤ 4000 chars. Visual only. */
  note?: string;
  /** Accent colour for the step card. Visual only. */
  color?: AnnotationColor;
}
/** A coloured region around a contiguous run of steps in one step list. Visual only. */
export interface Section {
  id: string;            // STEP_ID_PATTERN, unique among the doc's sections
  title: string;
  color: AnnotationColor;
  note?: string;
  first: string;         // step IDs in the same list, first at or before last
  last: string;
}
interface WorkflowDoc { sections?: Section[] }

// annotations.ts
export const ANNOTATION_COLORS: readonly AnnotationColor[]; // the six, in the order above
export const NOTE_MAX_CHARS = 4000;
export function isAnnotationColor(v: unknown): v is AnnotationColor;
/** The run a section covers, or undefined when it is broken (missing endpoint, two lists, reversed). */
export function sectionRun(doc: WorkflowDoc, section: Section):
  | { parentId: string | null; branch?: string; start: number; end: number; ids: string[] }
  | undefined;
/** The innermost section whose run contains step `id` in the step's own list, if any. */
export function sectionOf(doc: WorkflowDoc, id: string): Section | undefined;
/** How an edit relates old section members to the new doc (see below). */
export interface SectionEffect {
  /** Old member ID → the IDs that take its place (renames, wrap, replace, duplicate, unwrap). */
  subst?: ReadonlyMap<string, readonly string[]>;
  /** IDs the edit moved explicitly; they leave their section unless the whole run moved. */
  moved?: ReadonlySet<string>;
}
/** `after` with its `sections` updated for an edit from `before`; returns `after` itself when nothing changes. */
export function upkeepSections(before: WorkflowDoc, after: WorkflowDoc, effect?: SectionEffect): WorkflowDoc;
/** A fresh section ID from a title, unique among `doc.sections`. */
export function sectionIdFor(doc: WorkflowDoc, title: string): string;
/** @internal Validator checks: section.broken, section.overlap, note.tooLong. */
export function annotationIssues(doc: WorkflowDoc): Issue[];

// validate.ts
type IssueCode = /* existing */ | "section.broken" | "section.overlap" | "note.tooLong";
interface Issue { /** The section the issue belongs to. */ sectionId?: string }
```

`upkeepSections` algorithm (one function, used by every tree op and later by every command):
1. For each section in `before.sections`, take its members `M` = `sectionRun(before, s).ids` (a section already broken in `before` is left unchanged, so the validator keeps reporting it).
2. Replace each member by `effect.subst.get(id) ?? [id]`; drop IDs in `effect.moved` unless every member of `M` is in `moved` (the whole run moved); drop IDs that no longer exist in `after`.
3. Nothing left → the section is removed. Otherwise the survivors are grouped by the list they sit in (`findStep(after, id).location` parent + branch); keep the group containing the first survivor in `M` order; the section becomes `first` = lowest index, `last` = highest index of that group. Steps inserted between them are members by contiguity.
4. If two sections now overlap in one list, keep the one that appears earlier in `doc.sections` and drop the other.
5. Remove `sections` from the doc when it becomes empty and was absent before; keep `sections: []` if it was `[]`.

Tree ops wire it in: `removeStep` → `upkeepSections(doc, next)`; `moveStep(id)` → `{ moved: {id} }`; `renameStepId(id, newId)` → `{ subst: id → [newId] }` and it also rewrites `first`/`last`; `updateStep` whose `fn` changes the ID → same subst; `duplicateStep(id)` → `{ subst: id → [id, newId] }` (a copy of a member joins the section; a copy of `last` extends it). `insertStep` needs nothing. Step `note`/`color` travel with the step object, so move/copy/duplicate/delete carry them with no code.

Validation (`annotationIssues`, called at the end of `validateWorkflow`, all **warnings**):
- `section.broken` "Section “<title>” no longer covers a run of steps: <reason>" (reason: `step "x" is missing`, `its first and last steps are in different branches`, `its first step comes after its last`, `its colour "red" isn't one of yellow, blue, green, pink, purple, gray`, `its ID "…" is invalid or used twice`).
- `section.overlap` "Sections “A” and “B” overlap" (on the later section).
- `note.tooLong` "This note is 5000 characters; notes can be 4000 at most" (`stepId` for a step note, `sectionId` for a section note).
- A step `color` outside the six is not an issue (the canvas falls back to gray).

**Tests must pin**
- `sectionRun` for a top-level run, a run inside `else`, a one-step run, and each broken shape (missing, two lists, reversed) → `undefined`.
- Upkeep table (each row one `it`, doc `[a,b,c,d]` with section `s` = `b..c` unless stated):
  - remove `b` → `c..c`; remove `c` → `b..b`; remove `b` and `c` → section gone and `sections` omitted.
  - remove a branching step whose branch holds a whole section → that section gone, others untouched.
  - move `b` to the end → `c..c`; move `d` between `b` and `c` → `b..c` with `d` a member; moving both via two moves inside the run ordering keeps contiguity.
  - `renameStepId(b, "bee")` → `bee..c`; `duplicateStep(c)` → `b..c_copyId`; `duplicateStep(a)` (non-member) → unchanged.
  - `insertStep` between `b` and `c` → member; right before `b` or right after `c` → not a member.
  - A nested section inside `if` of a step that is inside an outer section: removing the outer section's steps outside the branch leaves the inner one untouched.
  - Referential identity: an edit that doesn't touch sections returns a doc whose `sections` array is `toBe` the old one.
- Validator: each broken shape, overlap, a 4001-char note on a step and on a section, and `color: "red"` on a section → the codes above, severity `warning`, `stepId`/`sectionId` as specified; a doc without `sections` and with `sections: []` → no new issues; `hasErrors` stays false.
- Engine (`packages/engine/src/annotations.test.ts`): the same workflow with and without `note`/`color`/`sections` publishes, runs on the memory storage and yields identical journals and final status; `saveWorkflow` → `getWorkflow` round-trips the three fields unchanged.

- [ ] **Step 1:** Write `annotations.test.ts`, the new `tree.test.ts` and `validate.test.ts` cases, and the engine test. Run `pnpm vitest run --project core packages/core/src/annotations.test.ts` → FAIL (`sectionRun` not exported).
- [ ] **Step 2:** Add the types; implement `annotations.ts`; wire `upkeepSections` into the tree ops; add the validator checks and `Issue.sectionId`; export everything from `index.ts` (`AnnotationColor`, `Section`, `ANNOTATION_COLORS`, `NOTE_MAX_CHARS`, `isAnnotationColor`, `sectionRun`, `sectionOf`, `upkeepSections`, `SectionEffect`, `sectionIdFor`).
- [ ] **Step 3:** Update the README "Tree model" paragraph. Run the gates (`pnpm build`, `pnpm test`, `pnpm -r typecheck`, `pnpm lint`).
- [ ] **Step 4:** Commit `feat(core): step notes, colours and sections kept intact by tree operations`.

---

### Task 2: core — reads and selectors

**Files:**
- Create: `packages/core/src/agent/format.ts`, `agent/selectors.ts`, `agent/compact-schema.ts`, `agent/reads.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/agent/reads.test.ts`, `agent/selectors.test.ts`, `agent/budget.test.ts`, `agent/fixtures.ts` (test-only doc and manifest builders: `flatDoc(n)`, `deepDoc(depth)`, `crmLikeManifest()`)

**Interfaces**

Consumes: Task 1 (`sectionRun`, `sectionOf`), `availableScope`, `schemaAtPath`, `describeType`, `derefSchema`, `branchesFor`, `validateWorkflow`, `configValueAt`, `findStep`, `walkSteps`.

Produces:
```ts
// selectors.ts
/** Steps to act on; fields are ANDed. `{}` matches every step. */
export interface Where {
  type?: string;                                  // exact node type
  section?: string;                               // section ID: its members and their subtrees
  within?: { stepId: string; branch?: string };   // descendants (any depth), optionally of one branch
  nameContains?: string;                          // case-insensitive, on the display name (name ?? node label ?? id)
  configHas?: string;                             // config path present (configValueAt !== undefined), e.g. "headers.replyTo"
}
/** Matching step IDs in pre-order. */
export function matchSteps(doc: WorkflowDoc, manifest: Manifest, where: Where): string[];

// format.ts
/** A follow-up call that fetches something a read left out. */
export interface FollowUp { tool: ReadToolName; args: Record<string, unknown> }
export type ReadToolName = "overview" | "outline" | "focus" | "getSteps" | "findSteps" | "availableRefs" | "listNodeTypes" | "describeNodeTypes" | "getIssues";
export interface Omission { what: "config" | "notes" | "branch" | "steps" | "string"; stepId?: string; branch?: string; count?: number; fetch: FollowUp }
/** `…(+1.2k chars)` style marker. */
export function cutString(s: string, max: number): { text: string; cut: boolean };
/** One outline line (without indentation): `getDeal  Get deal “Load it” [pink] · 1 issue: note "…"`. */
export function stepLine(step: Step, node: NodeManifest | undefined, issues: number, noteMax: number): string;
export function formatCall(f: FollowUp): string;   // outline({stepId:"recheck",branch:"else"})

// reads.ts
export interface ReadOptions { ctx?: ValidationContext }
export interface OutlineResult {
  text: string;
  /** What was left out, each with the exact call that returns it. Empty when nothing was. */
  omitted: Omission[];
  totals: { steps: number; sections: number; notes: number; errors: number; warnings: number };
}
export function overview(doc: WorkflowDoc, manifest: Manifest, opts?: ReadOptions & { budget?: number }): OutlineResult;
export function outline(doc: WorkflowDoc, manifest: Manifest, opts: ReadOptions & { stepId?: string; branch?: string; after?: string; budget?: number }): OutlineResult;
export interface RefInfo { ref: string; type: string; label: string; disabled?: boolean; children?: number }
export interface StepDetail {
  id: string; type: string; nodeLabel: string; name?: string; disabled?: boolean;
  note?: string; color?: AnnotationColor;
  section?: { id: string; title: string; color: AnnotationColor };
  location: { parentId: string | null; branch?: string; index: number };
  config?: Record<string, ValueExpr>;
  schema?: JSONSchema;            // compactSchema(node.input)
  refs?: RefInfo[];               // availableRefs top level
  issues: Issue[];
  branches?: { id: string; label: string; steps: number }[];
  /** Config/note paths whose strings were cut (pass full: true for the whole text). */
  cut?: string[];
}
export function focus(doc: WorkflowDoc, manifest: Manifest, stepId: string, opts?: ReadOptions & { full?: boolean }): StepDetail;   // include = config, schema, refs
export function getSteps(doc: WorkflowDoc, manifest: Manifest, ids: string[], opts?: ReadOptions & { include?: ("config" | "schema" | "refs")[]; full?: boolean }): { steps: StepDetail[]; missing: string[] };
export function findSteps(doc: WorkflowDoc, manifest: Manifest, where: Where): { count: number; matches: { id: string; line: string }[] };
export function availableRefs(doc: WorkflowDoc, manifest: Manifest, stepId: string, opts?: ReadOptions & { path?: string }): { refs: RefInfo[] };
export function listNodeTypes(manifest: Manifest, opts?: { query?: string; category?: string }): { types: { type: string; label: string; description?: string; category?: string }[] };
export function describeNodeTypes(manifest: Manifest, types: string[]): {
  types: { type: string; label: string; input: JSONSchema; branches: { kind: BranchSpec["kind"]; ids?: string[]; fromConfig?: string }; output: JSONSchema | { declaredBy: string }; operators?: RuleOperatorMeta[] }[];
  unknown: string[];
};
export function getIssues(doc: WorkflowDoc, manifest: Manifest, opts?: ReadOptions & { stepId?: string }): { issues: Issue[]; errors: number; warnings: number };
/** Every read, by tool name. */
export const reads: { overview: typeof overview; outline: typeof outline; focus: typeof focus; getSteps: typeof getSteps; findSteps: typeof findSteps; availableRefs: typeof availableRefs; listNodeTypes: typeof listNodeTypes; describeNodeTypes: typeof describeNodeTypes; getIssues: typeof getIssues };
// compact-schema.ts
/** JSON Schema trimmed for a model: $defs resolved inline (cycles become {"$ref": "#recursive"}), x-flowline reduced to {label, widget, enumLabels}, titles dropped. */
export function compactSchema(schema: JSONSchema): JSONSchema;
```

Line format (spec §3 example; `overview` first line is `trigger  <trigger name> (<kind>[, <caption>])`): indentation two spaces per depth; branch headers `├ <label>` / `└ <label>` with `│` continuation; section header `▣ section <id> "<title>" [<color>]` then `: note "<note>"`, members indented under it; steps `<id padded to the list's widest id + 2>  <node label>` then ` “<name>”` if set, ` [<color>]` if set, ` · N issue(s)` if any, `: note "<note>"` (notes cut to 120 chars, then 40). Under budget, each step with config gets a continuation line `<indent>    config <compact JSON>`. The last line is totals: `— 12 steps · 1 section · 2 notes · 0 errors · 1 warning`.

Budget (characters, default 4000 for `overview`/`outline`; `text.length <= budget` always):
1. Render with config. Over budget → drop every config line; add one `Omission { what: "config", fetch: getSteps({ ids: <all ids with config>, include: ["config"] }) }` and a text line `(config left out: getSteps({ids:[…],include:["config"]}))`.
2. Still over → cut notes to 40 chars; `Omission { what: "notes", fetch: getSteps({ ids, include: [] }) }` (StepDetail carries full notes).
3. Still over → collapse branches deepest first (ties: most steps, then last in pre-order) to `… 12 steps in branch else: outline({stepId:"recheck",branch:"else"})`, one `Omission { what: "branch" }` each.
4. Still over → collapse the tail of the longest remaining list to `… 380 more steps after step_120: outline({after:"step_120"})` (with `stepId`/`branch` for a branch list), `Omission { what: "steps" }`.
The tool description of `overview` (Task 6) says to start there.

**Tests must pin**
- `overview` of the spec §3 example doc reproduces the example lines exactly (golden string, including the section header, branch glyphs, the `· 1 issue` suffix and notes).
- A 5-step doc: one read includes every step's config; `omitted` is `[]`.
- Budget at 5, 50 and 500 steps (flat and 12-deep): `text.length <= 4000`; for 500 flat, executing every `omitted[i].fetch` through `reads[tool](doc, manifest, args)` (and paging `after` until no more `steps` omissions) returns every step ID exactly once across all results; for 12-deep, each `branch` follow-up returns that branch's steps.
- A custom `budget: 600` is respected; `budget` smaller than the header + totals still returns header + totals + one `steps` omission (never throws).
- `focus`: a config string of 20 000 chars comes back as 500 chars + `…(+19.5k chars)` and `cut: ["config.body"]`; `full: true` returns it whole; `section` is set for a member; `refs` lists `trigger` and earlier steps only (not later ones); `branches` for a condition lists `if`/`else` with counts.
- `getSteps` with an unknown ID → listed in `missing`, others returned; `include: []` returns no config/schema/refs.
- `availableRefs` top level vs `path: "steps.deal.deal"` → child properties with `describeType` types.
- `findSteps` for each `Where` field alone and combined; `section` includes members' subtrees; `{}` returns all steps.
- `listNodeTypes({ query: "mail" })` ranks by label/type/keywords match; `category` filters.
- `describeNodeTypes` for a static-branch node, a `fromConfig` node (switch), a loop and an unknown type (→ `unknown`); `input` has no `x-flowline` keys other than label/widget/enumLabels.
- A legacy doc with broken sections (Review Focus 3) reads without throwing; a broken section renders as `▣ section s "T" [gray] (broken)` with no members nested.

- [ ] **Step 1:** Write `fixtures.ts` and the failing tests. Run `pnpm vitest run --project core packages/core/src/agent` → FAIL.
- [ ] **Step 2:** Implement `selectors.ts`, `compact-schema.ts`, `format.ts`, `reads.ts`; export `reads`, each read, `matchSteps`, `compactSchema` and the result types from `index.ts`.
- [ ] **Step 3:** Gates. Commit `feat(core): budgeted reads for agents: overview, outline, focus and friends`.

---

### Task 3: core — `apply`, single-step and section commands

**Files:**
- Create: `packages/core/src/step-factory.ts` (move `defaultConfig`, `syncBranches`, `createStep` verbatim from `packages/react/src/store/commands.ts`, which now re-exports them from core)
- Create: `packages/core/src/agent/commands.ts`, `agent/command-schema.ts`, `agent/placeholders.ts`, `agent/apply.ts`, `agent/single.ts`, `agent/repairs.ts`
- Modify: `packages/core/src/index.ts`, `packages/react/src/store/commands.ts`
- Test: `packages/core/src/agent/apply.test.ts`, `agent/single.test.ts`, `agent/placeholders.test.ts`, `agent/repairs.test.ts`, `packages/core/src/step-factory.test.ts` (move the react tests of these helpers if any exist)

**Interfaces**

Consumes: Task 1 (`upkeepSections`, `sectionRun`, `sectionIdFor`, `NOTE_MAX_CHARS`), Task 2 (`stepLine`, `cutString`), tree ops, `generateStepId`, `renameStepId`, `codeBlocksRename`, `isGeneratedStepId`, `validateWorkflow`.

Produces:
```ts
// commands.ts
export type StepRef = string;   // a step ID, "$<n>" (1-based command index) or "$<fragment ref>"
export type At = { after: StepRef } | { before: StepRef } | { in: { stepId: StepRef; branch: string }; index?: number } | { start: true };
export interface SectionInput { title: string; color: AnnotationColor; note?: string; id?: string }
export type Command =
  | { op: "addStep"; at: At; type: string; id?: string; name?: string; config?: Record<string, ValueExpr>; note?: string; color?: AnnotationColor; disabled?: boolean }
  | { op: "moveStep"; id: StepRef; to: At }
  | { op: "removeStep"; id: StepRef }
  | { op: "duplicateStep"; id: StepRef }                    // copy named "<name> (copy)" like the editor
  | { op: "renameStep"; id: StepRef; name: string }         // "" clears
  | { op: "renameStepId"; id: StepRef; newId: string }
  | { op: "setType"; id: StepRef; type: string }             // plan addition, see Decisions
  | { op: "setConfig"; id: StepRef; key: string; value: ValueExpr | null; nullIsValue?: boolean }
  | { op: "setConfig"; id: StepRef; config: Record<string, ValueExpr | null> }
  | { op: "setDisabled"; id: StepRef; disabled: boolean }
  | { op: "setNote"; id: StepRef; note: string | null }
  | { op: "setColor"; id: StepRef; color: AnnotationColor | null }
  | { op: "setTrigger"; type: string; config?: Record<string, ValueExpr> }
  | { op: "setTriggerConfig"; key: string; value: ValueExpr | null; nullIsValue?: boolean }
  | { op: "setTriggerConfig"; config: Record<string, ValueExpr | null> }
  | { op: "setOutput"; key: string; value: ValueExpr | null; nullIsValue?: boolean }
  | { op: "setOutput"; config: Record<string, ValueExpr | null> }
  | { op: "renameWorkflow"; name: string }
  | { op: "addSection"; first: StepRef; last: StepRef } & SectionInput
  | { op: "updateSection"; id: string; title?: string; color?: AnnotationColor; note?: string | null; first?: StepRef; last?: StepRef }
  | { op: "removeSection"; id: string }
  | BulkCommand;   // Tasks 4–5 fill this union; in this task: `never`
export type CommandErrorCode =
  | "command.invalid" | "step.notFound" | "section.notFound" | "placeholder.unknown"
  | "node.unknown" | "trigger.unknown" | "branch.unknown" | "location.invalid"
  | "id.taken" | "id.invalid" | "run.invalid" | "section.overlap" | "move.intoSelf"
  | "expect.mismatch" | "readOnly"
  | "config.invalid" | "ref.syntax" | "ref.unresolved" | "ref.outOfScope" | "step.invalidId" | "step.duplicateId";  // fragment validation (Task 4)
export interface ApplyError { index: number; path: string; code: CommandErrorCode; message: string; hint?: unknown }
export type ApplyResult =
  | { ok: true; doc: WorkflowDoc; ids: Record<string, string>; changed: string; issues: { added: Issue[]; cleared: Issue[] } }
  | { ok: false; error: ApplyError };
export interface ApplyOptions { ctx?: ValidationContext }

// apply.ts
export function apply(doc: WorkflowDoc, commands: Command[], manifest: Manifest, opts?: ApplyOptions): ApplyResult;
/** Steps added, removed or whose own fields (not branches) changed, plus sections added/removed/changed. */
export function changedStepIds(before: WorkflowDoc, after: WorkflowDoc): { added: string[]; updated: string[]; removed: string[]; sections: { added: string[]; updated: string[]; removed: string[] } };
/** Thrown by wrappers (the editor store) that turn a failed ApplyResult into an exception. */
export class FlowlineCommandError extends Error { readonly name = "FlowlineCommandError"; constructor(readonly error: ApplyError) }
// command-schema.ts
/** Zod schema of one command; with a manifest, `type` fields are enums of its node/trigger types. */
export function commandSchema(manifest?: Manifest): z.ZodType<Command>;
// placeholders.ts (internal)
export function resolveStepRef(ref: StepRef, ids: Map<string, string>): string | undefined;   // "$1" → id; plain IDs unchanged
export function resolveValuePlaceholders(v: ValueExpr, ids: Map<string, string>): { value: ValueExpr; unknown?: string };
// step-factory.ts (public, used by react)
export function defaultConfig(schema: JSONSchema): Record<string, ValueExpr>;
export function syncBranches(step: Step, m: NodeManifest): Step;
export function createStep(id: string, m: NodeManifest): Step;
// repairs.ts
/** Commands that fix one section.broken / section.overlap / note.tooLong issue, or [] when it can't be fixed automatically. */
export function annotationRepairs(doc: WorkflowDoc, issue: Issue): Command[];
```

Behaviour:
- `apply` validates each command's shape with `commandSchema()` (no manifest: the enum-free schema), then runs handlers in order on a working copy. The first failure returns `{ ok: false }` and nothing else; the input doc is never mutated (all tree ops are immutable).
- Error `path` is `commands[<i>]` + the Zod issue path (`.key`, `[n]`), e.g. `commands[2].config.to`. `hint`: `step.notFound` → up to 5 closest existing IDs (Levenshtein); `node.unknown` → up to 10 closest node types; `branch.unknown` → the step's branch IDs; `placeholder.unknown` → the placeholders defined so far; `command.invalid` → `{ expected: <JSON Schema of that op from commandCatalog's generator> }`.
- Messages that existing editor tests rely on: `Unknown node type "<t>"`, `Unknown trigger type "<t>"`, `Step "<id>" not found`.
- Section upkeep happens inside the tree ops and handlers (each calls `upkeepSections` with its `SectionEffect`). After all commands, compute `changedStepIds`, issue delta (`validateWorkflow` before vs after, keyed by `code`, `stepId`, `sectionId`, `field`, `message`), and `changed`: one line per added (`+`), updated (`~`), removed (`- <id>`) step and section (`▣`), in after-doc pre-order, using `stepLine`; capped at 2000 chars with `… N more changes: getSteps({ids:[…]})`.
- `setNote` with more than `NOTE_MAX_CHARS` → `command.invalid` (shape). `addStep` with `config` merges over `defaultConfig`; with `id` uses it (`id.invalid`/`id.taken` otherwise), else `generateStepId`.
- `setType` reproduces `EditorActions.replaceStep` exactly (same-type no-op; `replaceStepType` semantics; generated ID regenerated with `renameStepId` unless `codeBlocksRename`) and sets `ids["$n"]` to the resulting ID.
- `setConfig` on a node with `branches.kind === "fromConfig"` runs `syncBranches`, as the editor does today.
- `addSection`: `first`/`last` in one list and ordered (`run.invalid` otherwise, hint `{ first: location, last: location }`); overlapping an existing section in the same list → `section.overlap` with hint `{ section: id }`; nested in a branch inside an outer section's step is fine. `updateSection` with `first`/`last` re-checks both rules. `removeSection` keeps the steps.
- `annotationRepairs`: `section.broken` with one surviving endpoint → `updateSection` shrinking to it, with none → `removeSection`; reversed → `updateSection` swapping; bad colour → `updateSection { color: "gray" }`; `section.overlap` → `removeSection` of the later one; `note.tooLong` → `setNote` cut to 4000 chars.

**Tests must pin**
- Table test, one row per command: normal case (resulting doc shape), unknown step → `step.notFound` with a hint containing the near-miss ID, and the input doc `toBe`-unchanged in the failure result path (the caller still holds it; assert `structuredClone` equality before/after).
- `$n` and `$ref`: `[addStep crm.getDeal, addStep crm.sendEmail with config.subject { $tpl: "Deal {{ steps.$1.deal.name }}" }, setNote { id: "$2" }]` → the template names the generated ID, `ids` is `{ "$1": "getDeal", "$2": "sendEmail" }`; `$9` → `placeholder.unknown` at `commands[0].id` with hint `["$1"]`; a placeholder inside a `$ref` path resolves too.
- Atomicity (Review Focus 2): two good commands then a failing third → `ok: false`, `error.index === 2`, `error.path` starts `commands[2]`, and no ID from commands 0–1 appears anywhere.
- `apply(doc, [], m)` → `ok: true`, `doc` `toBe` input, `changed === ""`, empty delta.
- Issue delta: adding a step with a missing required field lists that `config.required` in `added`; filling it lists it in `cleared`.
- `changed` for add, update, remove and addSection contains `+ `, `~ `, `- ` and `▣` lines; 300 changes cap at 2000 chars with the `getSteps` marker.
- `setConfig` `null` removes; `nullIsValue: true` stores `null`; `config: { a: 1, b: null }` merges and removes; a switch `cases` change syncs branches.
- `setType` rows copied from the existing `replaceStep` store tests (generated ID regenerated and refs rewritten; chosen ID kept; code-blocked rename kept).
- Sections: `addSection` normal, reversed, two lists, overlap, nested-in-branch allowed; `updateSection` retargeting; `removeSection`; `moveStep` of a section's `first` via `apply` shrinks it (upkeep through commands).
- `annotationRepairs` fixes each issue so `validateWorkflow` no longer reports it.
- `commandSchema()` parses every command in the table; rejects `{ op: "setNote", note: "x".repeat(4001) }`.

- [ ] **Step 1:** Move `defaultConfig`/`syncBranches`/`createStep` to core with their tests; make `packages/react/src/store/commands.ts` import and re-export them; run `pnpm vitest run --project react packages/react/src/store` → PASS (pure move).
- [ ] **Step 2:** Write the failing command tests above. Run `pnpm vitest run --project core packages/core/src/agent/apply.test.ts` → FAIL.
- [ ] **Step 3:** Implement `commands.ts`, `command-schema.ts`, `placeholders.ts`, `single.ts`, `apply.ts`, `repairs.ts`; export `apply`, `Command`, `At`, `StepRef`, `SectionInput`, `ApplyResult`, `ApplyError`, `ApplyOptions`, `CommandErrorCode`, `FlowlineCommandError`, `changedStepIds`, `commandSchema`, `annotationRepairs`, `defaultConfig`, `syncBranches`, `createStep`.
- [ ] **Step 4:** Gates. Commit `feat(core): atomic apply with single-step and section commands`.

---

### Task 4: core — bulk add: `insertSteps` and `replaceSteps`

**Files:**
- Create: `packages/core/src/agent/fragments.ts`
- Modify: `agent/commands.ts` (BulkCommand members), `agent/command-schema.ts`, `agent/apply.ts` (dispatch)
- Test: `packages/core/src/agent/fragments.test.ts`

**Interfaces**

Consumes: Task 3 (`apply` internals, placeholders, error helpers), `createStep`, `syncBranches`, `branchesFor`, `validateWorkflow`, `upkeepSections`, `sectionIdFor`.

Produces:
```ts
export interface Fragment {
  ref?: string;                 // STEP_ID_PATTERN; addressed as "$<ref>" later in the fragment and the batch
  id?: string;
  type: string;
  name?: string;
  config?: Record<string, ValueExpr>;
  note?: string;
  color?: AnnotationColor;
  disabled?: boolean;
  branches?: Record<string, Fragment[]>;
}
type BulkCommand =
  | { op: "insertSteps"; at: At; steps: Fragment[]; section?: SectionInput }
  | { op: "replaceSteps"; first: StepRef; last: StepRef; steps: Fragment[] }
  | /* Task 5 members */ never;
// fragments.ts (internal)
export function buildFragments(doc: WorkflowDoc, frags: Fragment[], manifest: Manifest, ids: Map<string, string>, path: string): { steps: Step[] } | { error: ApplyError };
```

Behaviour:
- Build all steps first: IDs from `id` or `generateStepId` against the doc plus already-built steps; register `$<ref>` for each `ref` (duplicate `ref` in the batch → `command.invalid`); config = `defaultConfig` merged with `config`, placeholders resolved after all IDs exist (so a fragment step may reference a later sibling's `$ref`, which then fails reachability, as it should); branches must be declared by the node (`branchesFor` on the built step; `branch.unknown` at `…steps[0].branches.<key>` with hint = declared IDs); `syncBranches` fills missing declared branches.
- Insert the run at `at`, then validate the candidate doc once and reject on the first issue among the inserted steps whose code is in the fragment-reject list (see Decisions); map the issue back to its fragment path (`commands[i].steps[0].branches.else[1].config.to`); hint for `ref.*` = valid refs at that position (from `availableRefs(…).refs.map(r => r.ref)`), for `config.invalid` = `compactSchema` of that field.
- `section` wraps the inserted top-level run: `{ id: section.id ?? sectionIdFor(title), first, last }`; overlap with an existing section in that list → `section.overlap`.
- `replaceSteps`: `first..last` must be a run (`run.invalid`); remove it, insert the fragments at its position; `upkeepSections` with `subst` mapping every replaced member to the new top-level IDs, so a section that contained the run keeps them. Refs elsewhere to removed steps show up as `ref.unresolved` in `issues.added` (not rejected: only inserted steps are gated).
- `ids["$n"]` = the first top-level inserted step.

**Tests must pin**
- The spec §3 example flow built in one `insertSteps` (condition with `then`/`else` fragments, a `ref` used as `{{steps.$deal.deal.stage}}` in a nested branch) → exact doc; `ids` has `$1` and every `$ref`.
- Unknown type deep in a branch → `node.unknown`, path `commands[0].steps[1].branches.else[0].type`, hint contains the closest type.
- Undeclared branch key → `branch.unknown` with declared IDs; a loop's `body` accepted.
- A ref to a step that comes later / inside a sibling branch → `ref.outOfScope` with the valid refs as hint; a literal of the wrong type → `config.invalid` with the field schema; a missing required field → accepted, listed in `issues.added`.
- `section` wrapping; `section` overlapping an existing one → rejected, doc untouched.
- `replaceSteps` of `b..c` inside section `a..d` → section still `a..d`; of exactly a section's run → section now spans the new steps; `run.invalid` for reversed or two-list runs.
- Atomicity: a failing fragment after a successful `insertSteps` in the same batch leaves the input doc untouched and `ids` absent.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Gates. Commit `feat(core): insertSteps and replaceSteps with whole-fragment validation`.

---

### Task 5: core — bulk edit and restructure

**Files:**
- Create: `packages/core/src/agent/bulk.ts`
- Modify: `agent/commands.ts`, `agent/command-schema.ts`, `agent/apply.ts`
- Test: `packages/core/src/agent/bulk.test.ts`, `agent/sections-upkeep.test.ts` (the §8 upkeep matrix through commands)

**Interfaces**

Consumes: Task 2 (`matchSteps`, `Where`), Tasks 3–4 internals, `duplicateStep` internals (`assignFreshIds`/`rewriteRefs` via `cloneWithFreshIds`-style helper; move a `cloneRunWithFreshIds(doc, steps)` into core `tree.ts` as `@internal` export).

Produces (BulkCommand members):
```ts
export interface StepUpdate { id: StepRef; set?: { name?: string; disabled?: boolean; note?: string | null; color?: AnnotationColor | null }; config?: Record<string, ValueExpr | null> }
  | { op: "duplicateSteps"; first: StepRef; last: StepRef; at?: At }      // default: right after last
  | { op: "updateSteps"; updates: StepUpdate[] }
  | { op: "updateSteps"; where: Where; set?: StepUpdate["set"]; config?: StepUpdate["config"]; expect: number }
  | { op: "replaceInConfig"; find: string; replace: string; where?: Where; expect: number }
  | { op: "moveSteps"; first: StepRef; last: StepRef; to: At }
  | { op: "removeSteps"; ids: StepRef[] } | { op: "removeSteps"; first: StepRef; last: StepRef } | { op: "removeSteps"; where: Where; expect: number }
  | { op: "wrapSteps"; first: StepRef; last: StepRef; in: { type: string; branch: string; config?: Record<string, ValueExpr> } }
  | { op: "unwrapStep"; id: StepRef; keep: string }
```

Behaviour:
- Every selector command requires `expect`; a different match count → `expect.mismatch`, hint `{ matched: [ids] }`. `expect: 0` with no matches → no-op success.
- `duplicateSteps`: fresh IDs for the whole run and subtrees; refs inside the copy to steps of the copied run are remapped to the copies; names get " (copy)" like `duplicateStep`; `upkeepSections` subst `last → [last, copyLast…]` when inserted right after `last` (copies of a section's run join it); `ids["$n"]` = first copy.
- `updateSteps` list form: each update applied in order; unknown ID → `step.notFound` at `commands[i].updates[k].id`. `set.name: ""` clears; `note: null`/`color: null` removes.
- `replaceInConfig`: replaces every occurrence of `find` (plain substring, case-sensitive) in string literals and in `$tpl` strings of config (not `$ref` paths, not trigger config); `expect` counts steps with at least one replacement; the result `changed` lists them.
- `moveSteps`: run check (`run.invalid`); `to` resolved after removal; target inside the run's own subtree → `move.intoSelf`; `upkeepSections` with `moved` = run IDs (a section equal to or inside the run moves with it; a partially covered section shrinks).
- `removeSteps`: `ids` form dedupes descendants of other removed IDs; `where` form same; dangling refs appear in `issues.added`.
- `wrapSteps`: `in.type` must declare `in.branch` for the built wrapper (`branch.unknown`); the wrapper takes the run's place; `upkeepSections` subst every run member → `[wrapperId]` (the wrapper replaces the run inside any enclosing section) while sections inside the run move into the branch unchanged; `ids["$n"]` = wrapper ID.
- `unwrapStep`: the step must have branches (`command.invalid` otherwise); `keep` must be one of them (`branch.unknown`); other branches' steps are removed (listed in `changed`); `upkeepSections` subst `id → kept IDs`; a section that was inside the kept branch now overlapping an outer section in the lifted list is dropped by upkeep rule 4 and listed as `- ▣ <id>` in `changed`.

**Tests must pin**
- Each command: normal case, `expect.mismatch` (with matched IDs), `expect: 0` no-op.
- The spec §8 section-upkeep matrix through commands, one row each: delete (`removeSteps` of first, last, all), move (`moveSteps` of the whole run, of a part, of one member out), duplicate (`duplicateSteps` of the section run, of its last member), wrap (whole section run, a run inside a section, a run overlapping a section's start), unwrap (inside a section; kept branch containing its own section), replace (from Task 4, re-run here for completeness). Each asserts the final `sections` and that `validateWorkflow` reports no `section.*` issue.
- `duplicateSteps` of `[load, email(uses {{steps.load.x}})]` → the copy of `email` references the copy of `load`; an outside ref stays.
- `replaceInConfig` over literals and templates, not `$ref`s; `find: ""` → `command.invalid`.
- `moveSteps` into its own subtree → `move.intoSelf`.
- `unwrapStep` keeping `else` lifts `else` steps in order; removed `if` steps listed in `changed`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Gates. Commit `feat(core): bulk edit and restructure commands with section upkeep`.

---

### Task 6: core — tool catalog and `runTool`

**Files:**
- Create: `packages/core/src/agent/catalog.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/agent/catalog.test.ts` (fixture manifest), `examples/mini-crm/server/src/catalog.test.ts` + `__snapshots__/catalog.test.ts.snap` (snapshot against the mini-crm manifest)
- Possibly modify: `examples/mini-crm/server/src/app.ts` (export `createCrmRegistry()` building the same registry the app uses, if not already exported)

**Interfaces**

Consumes: Task 2 `reads`, Tasks 3–5 `apply` and `commandSchema(manifest)`.

Produces:
```ts
export interface ToolDefinition { name: string; description: string; inputSchema: JSONSchema }
export function commandCatalog(manifest: Manifest, opts?: { include?: ("reads" | "commands")[] }): ToolDefinition[];
export type ToolState = { doc: WorkflowDoc; manifest: Manifest; ctx?: ValidationContext };
/** Runs one catalog tool call. `apply` returns the ApplyResult and, on success, the new doc to keep. */
export function runTool(state: ToolState, name: string, args: unknown):
  | { ok: true; result: unknown; doc?: WorkflowDoc }
  | { ok: false; error: { code: "tool.unknown" | "command.invalid"; message: string; path?: string } };
```

Catalog contents: one `apply` tool, input `{ commands: Command[] }` (JSON Schema from `z.toJSONSchema(z.object({ commands: z.array(commandSchema(manifest)) }), { target: "draft-2020-12", io: "input" })`), then one tool per read, names equal to the read names, inputs without `doc`/`manifest`/`ctx`. Manifest enums: every node `type` (`addStep.type`, `setType.type`, `Fragment.type`, `wrapSteps.in.type`, `Where.type`), trigger `type` in `setTrigger`, `listNodeTypes.category` from manifest categories, and `branch` fields as enums where every node's branches are static (the union of static branch IDs plus `body`; left free text when any `fromConfig` node exists, with a description saying so). Descriptions are written for a model, each with one short JSON example: `overview` says "Start here."; `apply` explains atomicity, `$1`/`$ref` placeholders, `expect`, and templates (`{ "$tpl": "Hi {{ trigger.contact.name }}" }`). The output is plain JSON Schema with no `$schema` key and no `x-flowline` keys.

**Tests must pin**
- Fixture manifest: `commandCatalog(m)` names are `["apply", "overview", "outline", "focus", "getSteps", "findSteps", "availableRefs", "listNodeTypes", "describeNodeTypes", "getIssues"]`; `include: ["reads"]` omits `apply`; `include: ["commands"]` has only `apply`.
- Every JSON example embedded in a description parses with `commandSchema(m)` (for `apply`) or the read's argument schema.
- `addStep.type` enum equals `m.nodes.map(n => n.type)`; `setTrigger.type` enum equals trigger types.
- `JSON.stringify(catalog)` has no `x-flowline` and no `"$schema"`.
- `runTool` round trip: `overview` then `apply` then `getIssues` on a fixture; unknown tool → `tool.unknown`; bad args → `command.invalid` with a path.
- mini-crm snapshot: `expect(commandCatalog(createCrmRegistry().manifest())).toMatchSnapshot()`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement; export `commandCatalog`, `ToolDefinition`, `runTool`, `ToolState`. **Step 3:** Write the snapshot (`pnpm vitest run --project mini-crm examples/mini-crm/server/src/catalog.test.ts -u` once, then review the snapshot by eye for enums and descriptions). **Step 4:** Gates. Commit `feat(core): manifest-derived tool catalog and runTool`.

---

### Task 7: react — editor store on `apply` + agent bridge

**Files:**
- Modify: `packages/react/src/store/editor-store.ts`, `store/commands.ts` (`atFromLocation`)
- Create: `packages/react/src/agent-bridge.ts`
- Modify: `packages/react/src/editor/workflow-editor.tsx` (`onStoreReady`), `packages/react/src/run/run-viewer.tsx` (`readOnly: true` store), `packages/react/src/canvas/keyboard.ts` and `canvas/actions.ts` (clipboard is now a run), `packages/react/src/index.ts`
- Test: `packages/react/src/store/editor-store.test.ts` (unchanged cases must pass; add new `describe`s), `packages/react/src/agent-bridge.test.tsx` (new)

**Interfaces**

Consumes: core `apply`, `ApplyResult`, `Command`, `At`, `FlowlineCommandError`, `changedStepIds`, `reads`, `runTool`, `upkeepSections`.

Produces:
```ts
// store/commands.ts
/** The command anchor for a StepLocation (`after` the previous sibling, else `start`/`in` at 0). Throws FlowlineTreeError for a missing parent or out-of-range index. */
export function atFromLocation(doc: WorkflowDoc, loc: StepLocation): At;
// editor-store.ts
interface EditorState {
  /** A contiguous run of steps in one list, or null. Pruned on every doc change like `selection`. */
  range: { first: string; last: string } | null;
  /** Doc-changing actions throw and `apply` returns code "readOnly". */
  readOnly: boolean;
  /** Steps and sections changed by the last bridge apply, for a brief canvas highlight. */
  flash: { ids: string[]; sections: string[]; token: number } | null;
  clipboard: Step[] | null;   // was Step | null
}
interface EditorActions {
  /** Runs commands as one undo step (a burst with the same coalesceKey joins the previous step). Never throws. */
  apply(commands: Command[], opts?: { coalesceKey?: string; flash?: boolean }): ApplyResult;
  /** Selects the run between two steps of one list; returns false (and changes nothing) when they are in different lists. */
  selectRange(first: string, last: string): boolean;
  clearRange(): void;
  setReadOnly(readOnly: boolean): void;
  copy(id: string): void;                                  // clipboard = [step]
  copyRange(first: string, last: string): void;
  paste(loc: StepLocation, opts?: InsertOptions): string | null;   // inserts the whole run; returns the first new ID
  removeRange(first: string, last: string): void;
  duplicateRange(first: string, last: string, opts?: InsertOptions): string;
  moveBy(first: string, last: string, delta: -1 | 1): void;
  addSection(first: string, last: string, input: SectionInput): string;
  updateSection(id: string, patch: { title?: string; color?: AnnotationColor; note?: string | null }): void;
  removeSection(id: string): void;
  setNote(id: string, note: string | null): void;           // coalesces `note\0<id>`
  setColor(id: string, color: AnnotationColor | null): void;
}
createEditorStore(init: { doc; manifest; ctx?; readOnly?: boolean })
// agent-bridge.ts
export type BoundReads = {
  overview(opts?: { budget?: number }): OutlineResult;
  outline(opts: { stepId?: string; branch?: string; after?: string; budget?: number }): OutlineResult;
  focus(stepId: string, opts?: { full?: boolean }): StepDetail;
  getSteps(ids: string[], opts?: { include?: ("config" | "schema" | "refs")[]; full?: boolean }): ReturnType<typeof getSteps>;
  findSteps(where: Where): ReturnType<typeof findSteps>;
  availableRefs(stepId: string, opts?: { path?: string }): ReturnType<typeof availableRefs>;
  listNodeTypes(opts?: { query?: string; category?: string }): ReturnType<typeof listNodeTypes>;
  describeNodeTypes(types: string[]): ReturnType<typeof describeNodeTypes>;
  getIssues(opts?: { stepId?: string }): ReturnType<typeof getIssues>;
};
export interface WorkflowAgentBridge {
  read: BoundReads;
  apply(commands: Command[]): ApplyResult;                 // flashes changed steps
  runTool(name: string, args: unknown): ReturnType<typeof runTool>;
}
/** Wires an agent into a mounted editor. `store` defaults to the enclosing editor's. */
export function useWorkflowAgentBridge(store?: EditorStore): WorkflowAgentBridge;
// WorkflowEditor props
onStoreReady?(store: EditorStore): void;
```

Every existing `EditorActions` method becomes: translate to `Command[]` → `apply` → on `ok: false` throw `new FlowlineCommandError(error)` (message = `error.message`) → apply the local side effects the method has today, computed from the result: selection of the new step (`result.ids["$1"]`), `needsTest` for every step whose `config` or `type` reference changed and the trigger if its config/type changed, resetting local samples under newly created IDs, keeping `selection` on a renamed/regenerated ID. Mapping: `insertStep` → `addStep` with `atFromLocation`; `replaceStep` → `setType`; `removeStep`; `duplicateStep`; `moveStep` → `moveStep` with the anchor computed on the doc after removal; `renameStep` (coalesce `name\0<id>`); `toggleDisabled` → `setDisabled`; `setConfig` (coalesce `config\0<id>\0<key>`, `undefined` → remove, `null` → `nullIsValue`, unchanged value → no command and no history); `setTrigger`; `setTriggerConfig`; `setOutput`; `renameWorkflow` (coalesce `workflowName`); `paste` → `insertSteps` with fragments built from `cloneWithFreshIds` output (keeping IDs via `Fragment.id`). `select`, `setServerIssues`, samples, `hydrateLocal`, `undo`, `redo`, `markSaved`, `markPublished`, `replaceDoc` are not doc commands and stay as they are. The bridge's `apply` sets `flash` from `changedStepIds` (added + updated) with an incrementing `token`; human actions don't flash.

**Tests must pin**
- The whole existing `editor-store.test.ts` passes without edits.
- Each `apply` is one undo step: a three-command batch, then `undo()` → the pre-batch doc (`toBe`); `redo()` → the batch result.
- A failed `apply` (Review Focus 2): state (`doc`, history, `canUndo`, `flash`) unchanged; the method form throws `FlowlineCommandError` with `Unknown node type "nope.x"`.
- `setConfig` null vs undefined; coalescing still merges typing bursts (existing timers test).
- Range: `selectRange` in one list sets it; across lists returns false; deleting a range member prunes or clears `range`; undo restores sections removed with a range (Review Focus 1).
- Clipboard run: `copyRange` + `paste` inserts the run with fresh IDs and remapped internal refs.
- `readOnly: true`: every doc action throws; `apply` returns `{ ok: false, error: { code: "readOnly", index: 0, path: "" } }`; the run viewer creates its store read-only.
- Bridge (render a `WorkflowCanvas` with a store and a test component calling the hook): `bridge.read.overview()` reflects the live doc; `bridge.apply(...)` changes the doc, the changed step cards get `data-flash` (Task 9 renders it; here assert `store.getState().flash.ids`), one undo step; read-only store → `readOnly` code; `runTool("apply", …)` updates the store doc; `onStoreReady` fires once with the loaded store.

- [ ] **Step 1:** Run the existing store suite to capture the baseline (`pnpm vitest run --project react packages/react/src/store`) → PASS.
- [ ] **Step 2:** Write the new failing tests. **Step 3:** Re-implement the actions on `apply`; add range/readOnly/flash/clipboard; write the bridge; export `useWorkflowAgentBridge`, `WorkflowAgentBridge`, `BoundReads` from `index.ts`.
- [ ] **Step 4:** Existing and new suites green; gates. Commit `feat(react): editor actions on apply and a host agent bridge`.

---

### Task 8: react — layout reserves space for sections and notes

May run in parallel with Tasks 2–6 (it touches only `packages/react/src/layout/*` and needs only Task 1's types).

**Files:**
- Modify: `packages/react/src/layout/constants.ts`, `packages/react/src/layout/layout-tree.ts`
- Test: `packages/react/src/layout/layout-tree.test.ts` (extend; the existing snapshot must not change)

**Interfaces**

Consumes: `Section`, `sectionRun` (Task 1).

Produces:
```ts
// constants.ts
export const NOTE_W = 180;          // sticky note width
export const NOTE_GAP = 12;         // gap between a card and its note
export const SECTION_PAD = 16;      // padding inside a section region (sides and bottom)
export const SECTION_HEADER_H = 32; // header band above a section's first member
// layout-tree.ts
export interface LayoutSection { id: string /* "section:<id>" */; sectionId: string; x: number; y: number; w: number; h: number; depth: number }
export interface LayoutNote { id: string /* "note:<stepId>" */; stepId: string; x: number; y: number; w: number; h: number }
export function layoutTree(doc, manifest): { nodes: LayoutNode[]; edges: LayoutEdge[]; sections: LayoutSection[]; notes: LayoutNote[]; width: number; height: number };
```

Layout rules:
- Sizes become extents around the column centre: `{ l, r, h }` (card: `l = r = CARD_W / 2`; a card with a note: `r = CARD_W / 2 + NOTE_GAP + NOTE_W`). A column's extents are the maximum `l` and `r` of its items (plus `SECTION_PAD` for items inside a section of that column). Branch columns are placed left to right by `l + r` widths with `BRANCH_GAP` between; a block's extents are `max(card extent, inner span / 2 (+ LOOP_GUTTER for loops))` on each side, so a note never covers a neighbouring column.
- In a list, the first member of a section starts `SECTION_HEADER_H` lower; after the last member the next item starts `SECTION_PAD` lower. Broken sections (`sectionRun` undefined) reserve nothing and produce no `LayoutSection`.
- `LayoutSection` rect: from the column centre minus the members' max `l` minus `SECTION_PAD` to centre plus max `r` plus `SECTION_PAD`; top = first member's top − `SECTION_HEADER_H`; bottom = bottom of the last member's item (its join node for a block) + `SECTION_PAD`. `depth` = list depth (for z-order of nested regions).
- `LayoutNote` rect: `x = card.x + CARD_W + NOTE_GAP`, `y = card.y`, `w = NOTE_W`, `h = CARD_H`.
- `width` = `2 * max(l, r)` of the root column so `fitViewport` stays centred on the trigger.
- `nodes` and `edges` keep their existing IDs and order; notes and sections are **not** in `nodes` (keyboard tree order and edge geometry read `nodes`).

**Tests must pin**
- A doc without annotations produces exactly the old `nodes`/`edges`/`width`/`height` (existing snapshot unchanged) and empty `sections`/`notes`.
- A note on a step in the left column of a two-branch condition: the right column's leftmost card `x` is ≥ note `x + w + BRANCH_GAP`.
- A section around two top-level steps: region contains both cards with `SECTION_PAD` on the sides and the header band above; the step after the section is pushed down by `SECTION_PAD`, the first member by `SECTION_HEADER_H`.
- A section inside an `else` branch stays within the `else` column extents (region `x ≥ column left`, `x + w ≤ column right`) and does not overlap the `if` column.
- Nested: a section in a branch of a step that is itself in an outer section → inner rect inside outer rect; `depth` inner > outer.
- A section whose member is a condition block → rect bottom below the block's join node.
- Broken section and unknown colour → no region, no throw.
- Deterministic: the same doc twice → deep-equal results.

- [ ] **Step 1:** Failing tests. **Step 2:** Refactor sizes to extents (keep existing outputs byte-identical), then add sections and notes. **Step 3:** `pnpm vitest run --project react packages/react/src/layout` and gates. Commit `feat(react): layout reserves space for sections and notes`.

---

### Task 9: react — canvas rendering, palette, read-only, accessibility

**Files:**
- Create: `packages/react/src/canvas/section-node.tsx`, `canvas/note-node.tsx`
- Modify: `canvas/workflow-canvas.tsx` (node types `section`, `sectionHeader`, `note`; flow nodes from `layout.sections`/`layout.notes`), `canvas/step-card.tsx` (`data-color`, `data-flash`, note in `ariaLabel`), `canvas/geometry.ts` (`edgeGeometries(nodes, edges, gutter, obstacles?: CanvasRect[])`, loop return passes left of section rects inside the loop body), `labels.ts`, `theme.ts`, `styles.css`, `playground/fixtures.ts`, `playground/main.tsx`, `playground/screenshot.mjs`
- Test: `packages/react/src/canvas/annotations.test.tsx` (new), `packages/react/src/theme.test.ts` (new: token contrast), `labels.test.ts` (extend), `canvas/geometry.test.ts` or `fit.test.ts` (extend)
- Docs: `packages/react/README.md` "Theming" (the annotation tokens)

**Interfaces**

Consumes: Task 8 layout, Task 7 `flash`/`readOnly`.

Produces:
```ts
// theme.ts
export type AnnotationToken = `annot${"Yellow" | "Blue" | "Green" | "Pink" | "Purple" | "Gray"}${"Bg" | "Border" | "Text"}`;
export type ThemeToken = /* existing */ | AnnotationToken;     // tokenVar("annotYellowBg") === "--fl-annot-yellow-bg"
// labels.ts (new keys)
colorNames: Record<AnnotationColor, string>;         // "Yellow", …
sectionRegion(title: string): string;                // aria-label of the region: the title
sectionHeader(title: string, hasNote: boolean): string;
noteLabel(text: string): string;                     // "Note: …"
stepWithNote(name: string, note: string): string;    // "<name>. Note: <first 120 chars>"
editNote: string; sectionBroken: string;
// section-node.tsx / note-node.tsx
export function SectionRegion(props: NodeProps<Node<{ sectionId: string }, "section">>): JSX.Element;
export function SectionHeader(props: NodeProps<Node<{ sectionId: string }, "sectionHeader">>): JSX.Element;
export function NoteCard(props: NodeProps<Node<{ stepId: string }, "note">>): JSX.Element;
```

Rendering:
- Section region: xyflow node `section:<id>` with `zIndex: -1`, not selectable/focusable, `role="group"`, `aria-label={labels.sectionRegion(title)}`, background `var(--fl-annot-<c>-bg)`, 1.5px border `var(--fl-annot-<c>-border)`, radius `calc(var(--fl-radius) * 1.5)`. Header chip: separate focusable node `sectionHeader:<id>` at the region's top-left (`x + SECTION_PAD`, `y + 6`), a button showing a colour swatch, the title (text colour `--fl-annot-<c>-text`) and a note icon when the section has a note (note text as its tooltip); left-aligned so it never sits under the centred "+" of the edge above. If a real browser check (Step 4 screenshots) shows edges hidden by the region, move the regions into a `<ViewportPortal>` layer below the edges instead of `zIndex: -1`.
- Note: xyflow node `note:<stepId>`, focusable, `aria-label={labels.noteLabel(note)}`, background `--fl-annot-<step color ?? yellow>-bg`, first ~3 lines (`-webkit-line-clamp: 3`), full text in `title`. Click opens the editor (Task 10); in this task, render only.
- Step card: `data-color={color}` draws a 3px left accent `--fl-annot-<c>-border`; the step's flow-node `ariaLabel` becomes `labels.stepWithNote(name, note)` when it has a note. `data-flash` set while `flash.token` is new and the step ID is in `flash.ids`, cleared on `animationend`.
- Unknown colour value → treated as `gray` everywhere (Review Focus 3).
- Read-only canvas (`readOnly` prop or store `readOnly`) and run viewer: `.fl-canvas[data-readonly] .fl-section, .fl-note { opacity: 0.72 }`; header chip and note are not buttons (no menu, no edit); still in the a11y tree.
- CSS: 18 tokens (`--fl-annot-<c>-{bg,border,text}`) in the light `.fl-root` block and identically in both dark blocks; `--fl-changed: color-mix(in srgb, var(--fl-accent) 45%, transparent)` in the derived block; `@keyframes fl-flash` (box-shadow ring of `--fl-changed`, 900ms) disabled under `prefers-reduced-motion: reduce`.
- Playground: fixture `?fixture=annotations` (two sections incl. one in a branch, three notes, two coloured cards); `screenshot.mjs` shoots it in `light` and `dark` colour schemes to `annotations-light.png` / `annotations-dark.png`.

**Tests must pin**
- `theme.test.ts`: parse `styles.css`, and for each of the 6 colours in light and dark, contrast of `-text` on `-bg` ≥ 4.5 and of `--fl-text` on `-bg` ≥ 4.5 (WCAG AA); the two dark blocks declare identical annotation values; `tokenVar("annotPurpleBorder") === "--fl-annot-purple-border"`; `themeStyle({ annotYellowBg: "#fff" })` sets the variable.
- `annotations.test.tsx`: a doc with a section renders a `role="group"` named by the title containing (geometrically) its member nodes; the header chip is focusable and has the title; a step note renders a node named "Note: …" and the step's accessible name includes the note; `color: "pink"` sets `data-color="pink"` on the card; `color: "red"` renders as gray; read-only canvas renders the annotations with `data-readonly` and no buttons in the chip or note.
- A bridge `apply` sets `data-flash` on changed cards only.
- Geometry: a loop whose body contains a section → the `loopReturn` path's x is left of the section rect.
- The existing `canvas.test.tsx` passes unchanged.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement tokens, labels, nodes, card attributes, geometry obstacle. **Step 3:** Playground fixture + `node packages/react/playground/screenshot.mjs /tmp/fl-shots` and inspect `annotations-light.png` / `annotations-dark.png` (edges visible over regions, notes not overlapping columns, text legible). **Step 4:** README tokens paragraph; gates including e2e. Commit `feat(react): draw sections, notes and step colours on the canvas`.

---

### Task 10: react — range selection and annotation menus

**Files:**
- Create: `packages/react/src/canvas/range-bar.tsx`
- Modify: `canvas/workflow-canvas.tsx` (shift-click), `canvas/actions.ts` (`rangeActions`, `sectionActions`, `noteActions`), `canvas/context-menu.tsx` (step "…"/right-click: Add note / Edit note, Color submenu; range menu), `canvas/section-node.tsx` (header menu, inline rename, repair "Fix"), `canvas/note-node.tsx` (click-to-edit textarea, "Shorten" fix for `note.tooLong`), `canvas/keyboard.ts` (⌘G, ⌥↑/⌥↓, ⇧↑/⇧↓), `canvas/step-card.tsx` (`data-in-range`), `labels.ts`, `styles.css`
- Test: `packages/react/src/canvas/range.test.tsx` (new), `canvas/annotation-menus.test.tsx` (new), `labels.test.ts`

**Interfaces**

Consumes: Task 7 store actions (`selectRange`, `addSection`, `updateSection`, `removeSection`, `setNote`, `setColor`, `copyRange`, `duplicateRange`, `removeRange`, `moveBy`), `annotationRepairs`.

Produces:
```ts
// actions.ts
export interface RangeActions { group(): void; remove(): void; copy(): void; duplicate(): void; moveUp(): void; moveDown(): void; clear(): void }
export function rangeActions(store: EditorStore, ui: CanvasUiStore, root: () => HTMLElement | null): RangeActions | undefined;  // undefined without a range
export interface SectionActions { rename(): void; setColor(c: AnnotationColor): void; editNote(): void; ungroup(): void; remove(): void; repair(): void }
export function sectionActions(store: EditorStore, ui: CanvasUiStore, root: () => HTMLElement | null, sectionId: string): SectionActions;
export interface NoteActions { edit(): void; remove(): void; shorten(): void }
export function noteActions(store: EditorStore, ui: CanvasUiStore, root: () => HTMLElement | null, stepId: string): NoteActions;
// canvas-context.ts UI state
editingNote: string | null;             // step ID or "section:<id>"
renamingSection: string | null;
// labels.ts (new keys)
groupIntoSection: string; ungroup: string; renameSection: string; sectionNote: string; color: string; noColor: string;
addNote: string; removeNote: string; defaultSectionTitle: string;    // "Section"
rangeSelected(n: number): string;       // "3 steps selected"
rangeOtherList: string;                 // "A range must stay in one branch. Shift-click a step in the same list."
stepsDeleted(n: number): string; sectionDeleted(title: string): string; noteDeleted: string;
moveUp: string; moveDown: string; clearRange: string; fixIssue: string; shortenNote: string;
sectionMenu(title: string): string;
```

Behaviour:
- Shift-click on a step with a selection or range in the same list → `selectRange(anchor, clicked)`; different list → refused, the existing selection kept, and a toast `labels.rangeOtherList`. ⇧↑/⇧↓ extend the range from the focused card within its list. Plain click or Esc clears the range.
- With a range: cards in it get `data-in-range`; the `RangeBar` (xyflow `<Panel position="top-center">`, `role="toolbar"`, `aria-label={labels.rangeSelected(n)}`) offers Group (⌘G), Duplicate (⌘D), Copy (⌘C), Move up (⌥↑), Move down (⌥↓), Delete (Delete/Backspace — wired in Task 11), Clear. Right-click on a range card shows the same items.
- Group → `addSection(first, last, { title: labels.defaultSectionTitle, color: "blue" })`, then starts inline rename of the new section's title. ⌘G on a single focused/selected step groups that step (keyboard path). Grouping over an existing section in the same list → the command's `section.overlap` error becomes a toast.
- Step "…" and right-click menus gain **Add note** (or **Edit note** + **Remove note** when it has one) and **Color** (submenu: six colours with swatch + `labels.colorNames[c]`, then **No color**).
- Section header chip: click or Enter opens its menu: **Rename**, **Color**, **Note** (edit the section note), **Ungroup** (`removeSection`, toast `sectionDeleted` with Undo). When the section has a `section.*` issue, the chip shows a warning badge and a **Fix** item that applies `annotationRepairs`.
- Note editing: click the note (or Add/Edit note) → an inline `<textarea>` in the note node (autofocus, `maxLength={NOTE_MAX_CHARS}`); ⌘Enter or blur saves (`setNote`, coalesced), Esc cancels; empty text removes the note. A note with `note.tooLong` shows a **Shorten** action.
- ⌥↑/⌥↓ on a single focused step moves it one position in its list (`moveBy(id, id, ±1)`); at an edge nothing happens.

**Tests must pin**
- Shift-click in the same list selects the run (cards `data-in-range`, bar shows "3 steps selected"); shift-click into another branch is refused with the hint and leaves the range unchanged.
- ⌘G on a range creates a section titled "Section" and opens the title input; Enter saves the typed title; Esc keeps "Section".
- Color submenu sets `color` on a step and on a section; **No color** removes the step colour.
- Add note → textarea → type → blur saves; empty + blur removes; Esc cancels.
- Ungroup removes the section, keeps the steps, toast Undo restores it.
- Range Duplicate/Copy+Paste/Move up/Move down produce the expected docs.
- **Fix** on a broken section and **Shorten** on a long note clear the issue (Review Focus 3).
- Every new string comes from labels: rendering with `labels={{ groupIntoSection: "Grouper" }}` shows "Grouper".

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Gates including e2e. Commit `feat(react): range selection, grouping, colours and notes in canvas menus`.

---

### Task 11: react — Backspace/Delete from the canvas, the panel and annotations

**Files:**
- Create: `packages/react/src/canvas/delete-key.ts`
- Modify: `canvas/keyboard.ts` (Delete/Backspace no longer blocked by `ownsKey` on non-text controls; range delete), `canvas/workflow-canvas.tsx` (register the editor-scope handler), `editor/workflow-editor.tsx` (`EditorBody` provides its body element through a new internal `DeleteScopeContext`), `canvas/section-node.tsx`, `canvas/note-node.tsx` (Delete/Backspace on focused chip/note)
- Test: `packages/react/src/editor/delete-key.test.tsx` (new), `canvas/canvas.test.tsx` (unchanged), `canvas/keyboard.test.ts` if present

**Interfaces**

Consumes: `isEditableTarget`, `stepActions().remove`, `rangeActions().remove`, `sectionActions().remove`, `noteActions().remove`.

Produces:
```ts
// delete-key.ts
/** What a Delete/Backspace keydown should delete, or null when the key belongs to a text control or nothing is selected. */
export function deleteTarget(e: { key: string; target: EventTarget | null; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  state: { selection: string | null; range: { first: string; last: string } | null; readOnly: boolean }):
  | { kind: "step"; id: string } | { kind: "range"; first: string; last: string }
  | { kind: "section"; id: string } | { kind: "note"; stepId: string } | null;
/** Internal: the element (editor body) whose keydowns outside the canvas root the canvas also handles. */
export const DeleteScopeContext: React.Context<HTMLElement | null>;
```

Rules (spec §7): Delete or Backspace without modifiers; `isEditableTarget(target)` → not handled (inputs, textareas, selects, contenteditable, CodeMirror, open menus/dialogs/listboxes, the step picker); focus on a section header chip → delete that section (`removeSection` + Undo toast); focus on a note → remove that note (Undo toast); else a range → `removeRange` (toast `stepsDeleted(n)` + Undo); else a selected step (not the trigger) → the existing `stepActions.remove()` (toast + Undo, focus to neighbour). This applies to keydowns inside the canvas root **and** inside the editor body outside the canvas (the config panel header, tabs, buttons and other non-text controls), and to keydowns whose target is `document.body` when the last `pointerdown` in the document was inside this editor. Read-only: nothing.

**Tests must pin**
- **Step 1 reproduces the reported bug first**: in `delete-key.test.tsx`, render `<WorkflowEditor>` (mock client as in `workflow-editor.test.tsx`), click the step card "Send email" with `userEvent`, move focus to the panel (focus `.fl-cp__name-btn`, as the panel's autofocus does), press Backspace → expect the step removed and the "Deleted “Send email”" toast. On the current code this test FAILS; keep it as the regression test.
- Matrix (each one `it`): canvas card focus → deletes; panel name button → deletes; panel tab button → deletes; panel config text input → does **not** delete and the character is removed from the input; panel name input (rename mode) → not; CodeMirror editor → not; data-picker search → not; note textarea → not; section title input → not; section chip focus → deletes the section only; note focus → deletes the note only; range selected + panel focus → deletes the range; trigger selected → nothing; read-only editor → nothing; `document.body` target after clicking in the editor → deletes; `document.body` target after clicking outside the editor → nothing.
- Exactly one deletion per keypress (no double handling between the canvas root and the scope handler): after one Backspace, `canUndo` history grows by one.
- Existing canvas keyboard tests pass unchanged.

- [ ] **Step 1:** Write the reproduction test; run `pnpm vitest run --project react packages/react/src/editor/delete-key.test.tsx` → FAIL (step not removed). Commit nothing yet.
- [ ] **Step 2:** Write the rest of the matrix (failing where expected).
- [ ] **Step 3:** Implement `deleteTarget`, the scope context and listener (attach on the scope element in `WorkflowCanvas` via effect; ignore events whose target is inside the canvas root, which the root handler already covers), chip/note handlers, and range delete in `handleCanvasKey`.
- [ ] **Step 4:** Gates including e2e. Commit `fix(react): Backspace and Delete delete the selection while the panel has focus`.

---

### Task 12: mini-crm — annotated seeded flow and e2e

**Files:**
- Modify: `examples/mini-crm/server/src/flows/deal-stuck.ts` (sections and notes), `examples/mini-crm/server/src/app.test.ts` (seeded doc keeps its annotations through save/publish/load)
- Create: `examples/mini-crm/e2e/annotations.spec.ts`
- Modify: `examples/mini-crm/README.md` (the annotated demo)

**Interfaces**

Consumes: everything above. Produces: `dealStuckFlow` with
```ts
sections: [
  { id: "check_deal", title: "Check the deal is still stuck", color: "blue", note: "Every side effect is preceded by a fresh load", first: "deal", last: "still_there" },
  { id: "escalate_block", title: "Escalate", color: "pink", first: "recheck", last: "escalate" },
]
// notes: `nudge.note = "Owner, not assignee"`, `wait.note = "1m in the demo, 1d in production"`; `escalate.color = "pink"`
```
(Adjust the `first`/`last` IDs to the real top-level IDs of `deal-stuck.ts`; both runs must be contiguous in one list, verified by `validateWorkflow` returning no `section.*` issue.)

**Tests must pin**
- `app.test.ts`: after seeding, `GET /flowline/workflows/deal-stuck-in-stage` returns the doc with both sections and both notes; publishing it has no errors.
- `e2e/annotations.spec.ts`:
  1. "groups two steps into a section, colours it, adds a note, ungroups and deletes through the UI": open the deal-stuck workflow, click one card, shift-click the next, press ⌘G/Ctrl+G, type "Owner loop" + Enter, expect a group named "Owner loop"; open its chip menu → Color → Green, expect the region's `data-color`; open a step's "…" → Add note, type "Check the owner", click the canvas, expect a note "Note: Check the owner"; chip menu → Ungroup, expect no group "Owner loop"; select a step, click into the panel header, press Backspace, expect the step gone and the Undo toast; Save; reload; expect the note to persist.
  2. "seeded sections and notes render in light and dark": open the deal-stuck workflow, expect groups "Check the deal is still stuck" and "Escalate", save `page.screenshot` to `test-results/annotations-light.png`, emulate `colorScheme: "dark"`, save `annotations-dark.png` (artifacts for review; no pixel comparison).

- [ ] **Step 1:** Failing server test and e2e spec. **Step 2:** Annotate the flow; README. **Step 3:** Gates including `pnpm --filter @flowlinejs/example-mini-crm e2e`. Commit `feat(mini-crm): annotated deal-stuck flow and annotation e2e`.

---

### Task 13: docs, agent scenario, changeset

**Files:**
- Create: `examples/mini-crm/server/src/agent-scenario.test.ts`
- Modify: `README.md` (new "Agents: reads, commands and the tool catalog" section after "Editor"; "Editor" gains notes/sections/range/Backspace and `useWorkflowAgentBridge`/`onStoreReady`; Roadmap: MCP server and copilot UI), `packages/core/README.md` (reads/apply/catalog usage), `packages/react/README.md` (bridge hook), `examples/docs-check/stubs/*` if a snippet needs a stub
- Create: `.changeset/agent-commands-annotations.md`

**Interfaces**

Consumes: all public APIs. Produces: docs whose TypeScript blocks typecheck under `examples/docs-check`, and:
```md
---
"@flowlinejs/core": minor
"@flowlinejs/engine": minor
"@flowlinejs/nodes-builtin": minor
"@flowlinejs/react": minor
"@flowlinejs/storage-memory": minor
"@flowlinejs/storage-postgres": minor
---

Agent commands, reads and canvas annotations. … (summary; breaking: `EditorState.clipboard` is `Step[] | null`; `EditorActions` throw `FlowlineCommandError`; `layoutTree` returns `sections` and `notes`)
```

**Tests must pin**
- Agent scenario (success criterion 1): starting from a blank manual-trigger doc and holding only `commandCatalog(manifest)` and `runTool`, a scripted agent makes **at most 4** `runTool` calls — `describeNodeTypes` for the types it needs; one `apply` with `setTrigger` (`crm.dealStuckInStage`, `{ stage: "proposal", days: 3 }`), `renameWorkflow`, one `insertSteps` building the whole flow of the 0.2.0 spec §7.5 with `ref`s used in `{{ steps.$deal… }}` templates and a `section`, a second `addSection`, and two `setNote`s; `getIssues` — and the final doc has `errors === 0`. Every tool name used is in the catalog; every `apply` input validates against the catalog's `apply.inputSchema` (use `commandSchema(manifest).parse`).
- `examples/docs-check` passes: every new block is annotated and typechecks; the core README snippet runs `apply` and `overview` on a small doc.
- The changeset lists all six packages as `minor`; `pnpm changeset status` reports one release at the next minor for the group.

- [ ] **Step 1:** Write the agent scenario; run it → it should PASS against the finished code (if it needs more than four calls, fix the catalog or reads, not the test).
- [ ] **Step 2:** Write the docs; run `pnpm vitest run --project docs-check`.
- [ ] **Step 3:** Add the changeset.
- [ ] **Step 4:** Full gates in order: `pnpm install`, `pnpm build`, `pnpm test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm --filter @flowlinejs/example-mini-crm e2e`, `pnpm test:scripts`. Commit `docs: agent commands, reads and canvas annotations; changeset for 0.3.0`.

---

## Done when

- Every Review Focus item has a green test naming it.
- The four spec success criteria hold: the scripted agent builds the flow in ≤ 4 calls with no errors (Task 13); bridge edits appear live as one undo step each (Task 7/9); reads on 500 steps stay in budget with executable follow-ups (Task 2); pre-0.3.0 docs load and run unchanged (Task 1).
- The full gate sequence passes on `flowkit-v1`, and the only changeset is Task 13's.
