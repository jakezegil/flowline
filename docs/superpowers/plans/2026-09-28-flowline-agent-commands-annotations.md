# Flowline Agent Commands, Reads & Canvas Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `0.3.0`, which adds:
- **Annotations:** step notes, step colours and sections, as optional doc fields that the tree operations keep intact.
- **Reads:** budgeted reads for agents.
- **Commands:** one atomic command API, `apply(doc, commands, manifest)`, covering single-step edits, bulk add, bulk edit, bulk restructure and sections, with a tool catalog derived from the manifest.
- **Editor:** the React editor rebuilt on `apply`, plus an agent bridge for hosts.
- **Canvas:** sections and notes drawn on the canvas, with range selection and menus.
- **Delete keys:** Backspace/Delete that works while the config panel has focus.

**Architecture:**
- **Core:** the model, reads and commands live in `@flowlinejs/core` as pure, isomorphic functions. They go in a new `src/agent/` folder, plus `src/annotations.ts` for the model and section upkeep.
- **React:** `@flowlinejs/react` re-implements `EditorActions` as thin wrappers over `apply`. The wrappers use a trusted, report-free mode, so typing costs what it costs today.
- **React extras:** the React package also adds `createAgentBridge` and `useWorkflowAgentBridge`, reserves layout space for sections and notes in `layoutTree`, and renders them as extra xyflow nodes.
- **Engine:** no behaviour change. It ignores the new fields, and a test pins that.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.9 strict, Zod 4 (peer dependency), Vitest 5, tsup, Biome 2, React 19, @xyflow/react 12, Zustand 5, Radix menus, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-flowline-agent-commands-annotations-design.md`.
- It is binding; read it in full first. § numbers below refer to it.
- §10 of the spec records the decisions this plan adds.
- Format reference: `docs/superpowers/plans/2026-09-28-flowline-triggers-conditions.md`.

## Global Constraints

- **Preconditions:**
  - The triggers/conditions batch (0.2.0) is merged on `flowkit-v1`, including its Task 11 (`3224bfa`) and its Task 12 (`c9ed2b7`, docs plus the 0.2.0 changeset). So these exist:
    - `examples/mini-crm/server/src/flows/deal-stuck.ts`, exporting `dealStuckFlow`, `DEAL_STUCK_WORKFLOW_ID` and `STUCK_DEAL_MANAGER_ID`
    - `crm.dealStuckInStage`, `crm.getDeal` and `crm.getUser`
    - `e2e/triggers.spec.ts`
  - **Before Task 17 only**, 0.2.0 must already be versioned and released on `main`: `.changeset/triggers-conditions.md` has been consumed, and every package's `package.json` reads `0.2.0`. Before Task 17 starts, the controller does the branch merge that brings that release into the integration branch. If either condition fails when Task 17 starts, stop and report to the controller.
- **Branch and naming:** the integration branch is `flowkit-v1`. The package scope is `@flowlinejs/*`; never introduce a `flowkit` identifier.
- **TypeScript and modules:**
  - All packages are ESM-only, with `"type": "module"`.
  - TS runs with `strict: true` and `noUncheckedIndexedAccess: true`.
  - Zod 4 is a **peer dependency** of core. Import `{ z } from "zod"`, never `zod/v3`.
  - Do not add runtime dependencies to any package.
- **Dev resolution:** package `exports` resolve to `./src` only under the `flowline-source` condition. Every new dev entry point sets it: vitest/vite config, `tsx --conditions=flowline-source`, and the Playwright webServer.
- **Import boundaries:** `@flowlinejs/core` and `@flowlinejs/react` never import from `@flowlinejs/engine`, `nodes-builtin`, Node built-ins, or anything server-only.
- **Formatting and tests:** Biome formats and lints everything (`lineWidth: 100`, double quotes). Vitest runs all tests; run one file with `pnpm vitest run --project <core|react|engine|mini-crm|docs-check> <path>`.
- **Gate order.** Run these in this order before a task is done:
  1. `pnpm install`
  2. `pnpm build` (must run before tests)
  3. `pnpm test`
  4. `pnpm -r typecheck`
  5. `pnpm lint`
  6. `pnpm --filter @flowlinejs/example-mini-crm e2e`: Playwright on ports 8921/5421. Required for Tasks 12–17, recommended otherwise.
  7. `pnpm test:scripts`
- **Labels:** every new piece of UI text goes through `packages/react/src/labels.ts` (`FlowlineLabels` + `defaultLabels`), overridable via `<FlowlineProvider labels>`. No hard-coded UI strings. Core issue and error messages stay in English, as today.
- **CSS:**
  - CSS lives in `packages/react/src/styles.css` inside `@layer flowline`.
  - Use only `fl-` class names and `--fl-` tokens. No hard-coded colours outside the token blocks.
  - Every new colour token has a light and a dark value. The dark value appears identically in the `[data-fl-theme="dark"]` block and the `prefers-color-scheme` block.
- **Public API:** every public export has TSDoc. New public names are exported from the package's `index.ts`.
- **Changesets:** none until Task 17. Task 17 adds one `minor` changeset naming all six packages; the Changesets `fixed` group in `.changeset/config.json` keeps them on one version.
- **Docs in the same task:** any task that changes a public API documented in `README.md`, `packages/*/README.md` or `docs/guides/writing-a-plugin.md` updates those snippets in the same task. The `examples/docs-check` suite typechecks them.
- **Commits:**
  - Use conventional commits, one per task; review fixes may add more.
  - Each message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - The commit names in each task's last step are suggestions. The controller commits.
- **Regression baseline:** existing behaviour must hold. These must pass **unchanged** after every task:
  - `packages/react/src/store/editor-store.test.ts`, including `revalidating a 200-step doc on a command takes < 20ms`, the clipboard assertions at lines 289/291, and `an unchanged value adds no history`
  - `canvas/canvas.test.tsx`
  - `layout/layout-tree.test.ts` and its snapshot file
  - the existing mini-crm e2e specs

  The only allowed behaviour change is Task 15's. Backspace/Delete on the card "…" trigger, on the "+" insert buttons, and on editor-body controls outside the canvas deletes the selection, and new tests pin this. Toast buttons and menus keep today's behaviour: `canvas.test.tsx` "Backspace on the toast's Undo button doesn't delete the selected step" stays green.
- **No-op identity:** a command that changes nothing leaves the doc object identical. When every command in a batch is a no-op, `apply` returns the **input doc object** (`toBe`). The editor's history relies on this, through `commit`'s `next === prev` check.
- **Derived colour tokens:** `color-mix` tokens such as `--fl-changed` are exempt from the light/dark rule. They inherit the light and dark values of the tokens they mix (`--fl-accent`), so they are declared once, in the derived block.

### Cross-task contracts (every task; binding)

These rules span tasks. Each task also restates the parts it owns.

- **Placeholders.**
  - `$n` is **1-based**: `$n` is the result of `commands[n-1]`, and error paths stay 0-based.
  - A fragment step with `ref: "deal"` is `$deal`.
  - Placeholders are accepted in every step-ID and section-ID argument (typed `StepRef`), and inside `$ref` paths and `$tpl` strings as `steps.$1…` / `steps.$deal…`.
  - `ids` maps every placeholder used or created to the real ID.
- **Rejected vs. reported.**
  - `apply` rejects (`ok: false`):
    - unknown steps, sections, node types and trigger types
    - invalid locations, unknown branches, taken or invalid IDs and invalid runs
    - overlap on `addSection`
    - `expect` mismatches
    - command shape errors
  - For **non-verbatim fragments only**, it also rejects these validation codes (the **fragment reject list**): `node.unknown`, `branch.unknown`, `config.invalid`, `ref.syntax`, `ref.unresolved`, `ref.outOfScope`, `step.invalidId`, `step.duplicateId`.
  - Everything else, including `config.required` and all warnings, goes to `issues.added`.
  - `setConfig`, `setTriggerConfig` and `setOutput` accept any JSON value, and never reject it for its content.
- **`null` in config patches** removes the key. `nullIsValue: true` (on `setConfig`, `setTriggerConfig` and `setOutput`) stores a literal `null`.
- **Internal fields.** `nullIsValue` and `insertSteps.verbatim` are accepted only by `commandSchema(m, { internal: true })`, the default inside `apply`. They are absent from `commandSchema(m, { internal: false })`, from the catalog and from every example.
- **Strict schemas.** Every command object schema is a `z.strictObject`, so an unknown key fails with `command.invalid` and the error names the key.
- **Verbatim insert (paste):**
  - The given IDs are used as-is.
  - Config is taken as-is, with no defaults merged.
  - Branches are kept as-is, including undeclared ones, and unknown node types are allowed.
  - It only reports issues; it never rejects on validation.
- **Trusted mode.** `apply(doc, cmds, m, { trusted: true, report: false })` skips the shape parse, the issue delta, `changedStepIds` and `changed`. `ids` and `renamed` are still filled. The editor's method wrappers use this mode, and `commandSchema` is cached per manifest object.
- **`setType { id, type }`** is the editor's Replace. It follows `replaceStepType` semantics, and a generated ID is regenerated unless `codeBlocksRename`.
- **`setTrigger`:**
  - Same type with no `config`: a no-op.
  - Same type with `config`: merges it.
  - Different type: resets to the defaults, then merges.
- **`At`** forms: `{ after }`, `{ before }`, `{ in: { stepId, branch }, index? }`, `{ start: true }`. For moves, the anchor is resolved after the moved steps are removed.
- **Duplicate names** use `copyName` from core: `(copy)`, then `(copy 2)`, and so on, stripping an existing `(copy N)` suffix first.
- **Read signatures.** Every read is `(doc, manifest, args, opts?)`, where `args` is exactly the tool input and `opts` is `{ ctx? }`. The node-type reads accept `doc: WorkflowDoc | null`. `FollowUp.args`, `runTool` and `BoundReads` pass `args` through unchanged.
- **Host glue.**
  - Bridge reads call `store.getState()` at call time.
  - Bridge `apply` and `runTool("apply")` go through `store.apply`.
  - `onStoreReady` fires for every store the editor creates. The cleanup it returns runs when that store is replaced or the editor unmounts.
- **Read-only.** `EditorState.readOnly` is the single source of truth. `<WorkflowCanvas readOnly>` sets it while mounted, and `CanvasUiState.readOnly` is removed.
- **Errors.** `FlowlineCommandError extends FlowlineTreeError`, and `FlowlineTreeError.name` is widened to `string`.
- **Clipboard.** `EditorState.clipboard` stays `Step | null`, holding the first copied step. `clipboardRun: Step[] | null` holds the whole run.
- **Section issues** carry `sectionId`, plus `stepId` = `first` when that step exists.
- **Result caps:**
  - `issues.added` holds at most 20 issues. The rest are counted in `issues.more`, with a `getIssues` follow-up.
  - The `command.invalid` hint is the compact JSON Schema at the failing path, at most 1500 chars.
  - Shape errors are all found before any command runs: `error` is the first, and `more` holds up to 9 others.

## Review Focus

1. **Section endpoints under edits and undo.** The edits to check: deleting, moving (including ⌥↑/⌥↓ of an interior member), renaming the ID of, retyping, duplicating, wrapping and unwrapping the `first` or `last` step of a section, then undoing.
   - The section never names a missing step and never spans two lists.
   - It shrinks to the nearest remaining member, or is removed.
   - Undo restores the exact previous `sections` array.

   (Tests in Tasks 1, 5, 7 and 10.)
2. **A batch that fails half-way.** Take a batch whose third command fails, after two commands that generated IDs and used `$1` inside a `{{steps.$1.…}}` template in a nested fragment branch.
   - `apply` returns `ok: false`, and the error names `commands[2]…` with a hint.
   - The caller's doc object is untouched: it deep-equals a clone taken before the call.
   - In the editor, nothing is added to history and nothing is flashed.

   (Tests in Tasks 4, 6 and 10.)
3. **Hand-edited and legacy docs.** The inputs:
   - no `sections`, or `sections: []`
   - a section whose `first` is missing
   - a section whose `first`/`last` are in different lists, or reversed
   - two overlapping sections
   - a colour outside the six (`"red"`)
   - a 5000-char note

   The doc must load, validate with warnings only, and read and lay out without throwing. The canvas draws a `"red"` section as a gray region. The issues pill's **Fix** repairs each issue, including broken sections that have no region to click. (Tests in Tasks 1, 3, 11, 12 and 14.)
4. **Huge and deep workflows.** The inputs: 500 flat top-level steps, 12 levels of nested conditions, a 20 000-char config string and 4000-char notes.
   - `overview`/`outline` keep the whole serialized result within `budget` characters: `text` plus `omitted`.
   - Every structured follow-up in `omitted`, when executed (paging where offered), returns the hidden content in full.
   - `focus`/`getSteps` cut long strings with `…(+N chars)` unless `full: true`.

   (Tests in Tasks 2 and 3.)
5. **Backspace while typing.** Backspace or Delete never deletes a step in any of these:
   - the inline rename input
   - the panel name input
   - a config text field
   - a CodeMirror editor
   - the data-picker search
   - the note textarea
   - the section title input

   In the panel, on a non-text control, Backspace deletes the selection exactly once, with the undo toast. (Tests in Task 15, e2e in Task 16.)

Also exercised:
- a selector with `expect: 0` that matches nothing succeeds as a no-op
- `apply([])` returns `ok: true` with the input doc
- a read-only editor rejects `apply` with `code: "readOnly"`
- a doc from before 0.3.0 runs identically on the engine

## Decisions: rationale only (not needed to implement; recorded in spec §10)

- `setType` exists because `EditorActions.replaceStep` has no spec command, and §5 needs one code path.
- 1-based `$n` matches the spec's `$1, $2` example. Refs can't start with a digit, so `$1` and `$ref` never collide.
- Paste is verbatim so that it keeps today's behaviour: it always succeeds, and the validator flags problems afterwards.
- Trusted mode exists so a keystroke costs what it costs today. The 200-step `< 20ms` test pins this.
- Reads take one `args` object so that follow-ups, `runTool` and the bridge share one call shape.
- `outline({ after })` paging exists because collapsing branches alone can't fit a flat 500-step list into 4000 chars.
- A single read-only flag exists so that a bridge on a `<WorkflowCanvas readOnly>` is rejected too.
- The branch-enum limit trades schema precision in manifests with `fromConfig` nodes, such as mini-crm's switch, for a simple rule.
- The §3 example in the spec is illustrative in its spacing. The Task 2 snapshot is the source of truth for exact bytes.
- Moved members stay in their section so that ⌥↑/⌥↓ reorders inside a section without leaving it.

## File structure (new or changed)

```
packages/core/src/
  types.ts                     AnnotationColor, Section, Step.note/color, WorkflowDoc.sections
  annotations.ts   (new)       ANNOTATION_COLORS, NOTE_MAX_CHARS, sectionRun, sectionOf, upkeepSections, sectionIdFor, annotationIssues
  tree.ts                      tree ops keep sections intact; FlowlineTreeError.name widened; cloneRunWithFreshIds
  validate.ts                  section.broken, section.overlap, note.tooLong; Issue.sectionId
  step-factory.ts  (new)       defaultConfig, syncBranches, createStep, jsonEqual (T4), replaceStepType, copyName (T5)
  json-schema.ts               export derefSchema (T3)
  agent/
    read-types.ts  (new)       Where, ReadArgs, ReadResults, ReadToolName, FollowUp, Omission, OutlineResult, StepDetail, RefInfo
    format.ts      (new)       outline line format, budgets, truncation, collapse markers
    outline.ts     (new)       overview, outline
    selectors.ts   (new)       matchSteps
    compact-schema.ts (new)    compactSchema
    reads.ts       (new)       focus, getSteps, findSteps, availableRefs, listNodeTypes, describeNodeTypes, getIssues, reads
    commands.ts    (new)       Command union, At, StepRef, Fragment, StepUpdate, ApplyResult, ApplyError, CommandErrorCode
    command-schema.ts (new)    strict Zod schemas; commandSchema(manifest?, opts?) cached per manifest; opJsonSchema; whereSchema
    placeholders.ts (new)      placeholder resolution in IDs, $ref and $tpl
    apply.ts       (new)       apply pipeline, changedStepIds, issue delta, changed outline, FlowlineCommandError
    single.ts      (new)       single-step handlers
    sections.ts    (new)       section handlers
    fragments.ts   (new)       insertSteps (incl. verbatim), replaceSteps
    bulk.ts        (new)       duplicateSteps, updateSteps, replaceInConfig, moveSteps, removeSteps, wrapSteps, unwrapStep
    repairs.ts     (new)       annotationRepairs
    catalog.ts     (new)       commandCatalog, ToolDefinition, runTool, readArgSchemas
  index.ts                     exports
packages/engine/src/annotations.test.ts (new)
packages/react/src/
  store/commands.ts            re-exports moved helpers; atFromLocation; stepToFragment
  store/editor-store.ts        EditorActions on apply; apply action; range, readOnly, flash, clipboardRun
  agent-bridge.ts  (new)       createAgentBridge, useWorkflowAgentBridge, BoundReads, WorkflowAgentBridge
  layout/constants.ts          NOTE_W, NOTE_GAP, SECTION_PAD, SECTION_HEADER_H
  layout/layout-tree.ts        asymmetric extents; sections[] and notes[]
  canvas/geometry.ts           loop return routes outside section regions
  canvas/section-node.tsx (new), canvas/note-node.tsx (new), canvas/range-bar.tsx (new)
  canvas/step-card.tsx, canvas/context-menu.tsx, canvas/actions.ts, canvas/keyboard.ts, canvas/workflow-canvas.tsx, canvas/canvas-context.ts
  canvas/delete-key.ts (new)
  editor/workflow-editor.tsx   onStoreReady, delete-key scope
  editor/editor-load.ts        store lifecycle callback
  editor/issues-pill.tsx       Fix action for annotation issues
  run/run-viewer.tsx           readOnly store
  labels.ts, theme.ts, styles.css, index.ts
  playground/fixtures.ts, playground/main.tsx, playground/screenshot.mjs
examples/mini-crm/
  server/src/app.ts (createCrmRegistry), server/src/flows/deal-stuck.ts, server/src/app.test.ts
  server/src/catalog.test.ts (new), server/src/agent-scenario.test.ts (new)
  e2e/annotations.spec.ts (new)
README.md, packages/core/README.md, packages/react/README.md, examples/mini-crm/README.md
docs/superpowers/specs/2026-09-28-flowline-agent-commands-annotations-design.md (§10, already written with this plan)
.changeset/agent-commands-annotations.md (Task 17)
```

## Tasks and parallelism

| # | Task | Package(s) | Depends on | May run in parallel with |
|---|---|---|---|---|
| 1 | Doc model, section upkeep in tree ops, validation | core, engine (test) | — | — |
| 2 | Read types, line format, `overview`/`outline` with budgets | core | 1 | 11 |
| 3 | Detail reads, selectors, compact schema | core | 2 | 11 |
| 4 | `apply` pipeline + addStep/removeStep/moveStep/setConfig | core | 3 | 11 |
| 5 | Remaining single-step and section commands, repairs | core | 4 | 11 |
| 6 | Bulk add: `insertSteps` (incl. verbatim), `replaceSteps` | core | 5 | 11 |
| 7 | Bulk edit and restructure, `cloneRunWithFreshIds` | core | 6 | 9, 11 |
| 8 | Tool catalog and `runTool` | core, mini-crm (test) | 7 | 9, 11 |
| 9 | EditorActions on `apply`, no new behaviour (regression gate) | react (`store/`) | 6 | 7, 8, 11 |
| 10 | Store state (range, readOnly, flash, clipboardRun), `apply` action, agent bridge, `onStoreReady` | react | 8, 9 | 11 |
| 11 | Layout reserves space for sections and notes; loop routing | react (`layout/`, `canvas/geometry.ts`) | 1 | 2–10 |
| 12 | Canvas rendering, palette, read-only, a11y | react | 10, 11 | — |
| 13 | Range selection, RangeBar, range keys | react | 12 | — |
| 14 | Annotation menus, note editing, Fix (chip + issues pill) | react | 13 | — |
| 15 | Backspace/Delete everywhere | react | 14 | — |
| 16 | mini-crm annotations + e2e | mini-crm | 15 | — |
| 17 | Docs, agent scenario, changeset | docs, mini-crm, .changeset | 16 | — |

Why the parallel pairs are safe:
- **Task 11** touches only `packages/react/src/layout/*` and `canvas/geometry.ts`. The one exception is `packages/react/src/index.ts`: it appends four constants and the `LayoutSection`/`LayoutNote` types there, which is a trivial merge. It needs only Task 1's types. Its `layoutTree` and `edgeGeometries` changes are additive: the existing return types stay, so `workflow-canvas.tsx` (edited by Task 10 at the same time) keeps compiling.
- **Task 9** touches only `packages/react/src/store/*` and uses only Tasks 4–6 core APIs, so it can run alongside the core-only Tasks 7 and 8.
- **Tasks 2–8** each edit `packages/core/src/index.ts` and must run in order.

---

### Task 1: core — doc model, section upkeep in tree ops, validation issues

**Files:**
- Modify: `packages/core/src/types.ts` (Step, WorkflowDoc; new types)
- Create: `packages/core/src/annotations.ts`
- Modify: `packages/core/src/tree.ts`: `removeStep`, `moveStep`, `updateStep`, `renameStepId`, `duplicateStep`; widen `FlowlineTreeError.name` to `string`.
- Modify: `packages/core/src/validate.ts` (IssueCode, Issue.sectionId, WARNING_CODES, checks)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/annotations.test.ts` (new), `packages/core/src/tree.test.ts` (extend), `packages/core/src/validate.test.ts` (extend), `packages/engine/src/annotations.test.ts` (new)
- Docs: `README.md` "Tree model". Add one paragraph: notes, colours and sections are optional and visual only, and the engine ignores them.

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

// tree.ts
export class FlowlineTreeError extends Error { override readonly name: string = "FlowlineTreeError" }

// annotations.ts
export const ANNOTATION_COLORS: readonly AnnotationColor[]; // the six, in the order above
export const NOTE_MAX_CHARS = 4000;
export function isAnnotationColor(v: unknown): v is AnnotationColor;
/** The run a section covers, or undefined when it is broken (missing endpoint, two lists, reversed). A bad colour or an invalid/duplicate section ID does not make the run undefined. */
export function sectionRun(doc: WorkflowDoc, section: Section):
  | { parentId: string | null; branch?: string; start: number; end: number; ids: string[] }
  | undefined;
/** The innermost section whose run contains step `id` in the step's own list, if any. */
export function sectionOf(doc: WorkflowDoc, id: string): Section | undefined;
/** How an edit relates old section members to the new doc. */
export interface SectionEffect {
  /** Old member ID → the IDs that take its place (renames, wrap, replace, duplicate, unwrap). */
  subst?: ReadonlyMap<string, readonly string[]>;
  /** IDs the edit moved explicitly (see rule 2). */
  moved?: ReadonlySet<string>;
}
/** `after` with its `sections` updated for an edit from `before`; returns `after` itself when nothing changes. */
export function upkeepSections(before: WorkflowDoc, after: WorkflowDoc, effect?: SectionEffect): WorkflowDoc;
/**
 * A fresh section ID from a title, unique among `doc.sections`.
 * Rule: lowercase the title, replace each run of characters outside [a-z0-9] with "_", and trim "_" from both ends.
 * Cut to 32 chars, prefix "section_" if the slug starts with a digit, and use "section" when nothing is left.
 * If the ID is taken, append "_2", "_3", … ("Check the deal" → "check_the_deal", then "check_the_deal_2").
 */
export function sectionIdFor(doc: WorkflowDoc, title: string): string;
/** @internal Validator checks: section.broken, section.overlap, note.tooLong. */
export function annotationIssues(doc: WorkflowDoc): Issue[];

// validate.ts
type IssueCode = /* existing */ | "section.broken" | "section.overlap" | "note.tooLong";
interface Issue { /** The section the issue belongs to. */ sectionId?: string }
```

`upkeepSections` is one algorithm, used by every tree op and later by every command:
1. **Old members.** For each section in `before.sections`, take its members `M` = `sectionRun(before, s).ids`. A section already broken in `before` is left unchanged, so the validator keeps reporting it.
2. **Substitute and filter.**
   1. Replace each member by `effect.subst.get(id) ?? [id]`, then drop IDs that no longer exist in `after`.
   2. Split the survivors into **anchors** (not in `effect.moved`) and **moved**.
   3. If every member of `M` is moved (the whole run moved), all survivors are anchors.
   4. Otherwise a moved member stays only if, in `after`, it sits in the same list as the anchors and lies within their span. Let `F`/`Z` be the indices of the first and last anchor in that list and `i` the moved member's index. It stays if any of these holds:
      - `F ≤ i ≤ Z`
      - `i < F` and every step strictly between `i` and `F` is a moved member of this section
      - `i > Z` and every step strictly between `Z` and `i` is a moved member of this section

   The effect: ⌥↑ on an interior member keeps it, and ⌥↑ on the first member moves it out.
3. **Recompute the span.** If nothing is left, the section is removed. Otherwise:
   1. Group the survivors by the list they sit in (the `findStep(after, id).location` parent + branch).
   2. Keep the group that contains the first survivor in `M` order.
   3. `first` becomes that group's lowest index and `last` its highest.
   4. Steps that end up between them are members by contiguity.
4. **Overlap.** If two sections now overlap in one list, keep the one that appears earlier in `doc.sections` and drop the other.
5. **Empty array.** Remove `sections` from the doc when it becomes empty and was absent before; keep `sections: []` if it was `[]`.
6. **Identity.** If no section changed, return `after` unchanged, so the `sections` array is the old array (`toBe`).

How the tree ops wire it in:
- `removeStep`: `upkeepSections(doc, next)`.
- `moveStep(id)`: `{ moved: {id} }`.
- `renameStepId(id, newId)`: `{ subst: id → [newId] }`. It also rewrites `first`/`last`.
- `updateStep`: if `fn` changes the ID, the same subst as `renameStepId`.
- `duplicateStep(id)`: `{ subst: id → [id, newId] }`. A copy of a member joins the section, and a copy of `last` extends it.
- `insertStep`: nothing.

Step `note`/`color` travel with the step object, so move, copy, duplicate and delete carry them with no extra code.

Validation (`annotationIssues`, called at the end of `validateWorkflow`, all **warnings**):
- `section.broken`: "Section “<title>” no longer covers a run of steps: <reason>". The reasons are:
  - `step "x" is missing`
  - `its first and last steps are in different branches`
  - `its first step comes after its last`
  - `its colour "red" isn't one of yellow, blue, green, pink, purple, gray`
  - `its ID "…" is invalid or used twice`
- `section.overlap`: "Sections “A” and “B” overlap". Reported on the later section.
- `note.tooLong`: "This note is 5000 characters; notes can be 4000 at most". It carries `stepId` for a step note and `sectionId` for a section note.
- Section issues carry `sectionId`, plus `stepId` = `first` when that step exists.
- A step `color` outside the six is not an issue; the canvas falls back to gray.

**Tests must pin**
- `sectionRun` for a top-level run, a run inside `else`, and a one-step run. Each broken shape (missing, two lists, reversed) returns `undefined`. `color: "red"` still returns the run.
- The upkeep table. Each row is one `it`, on doc `[a,b,c,d]` with section `s` = `b..c` unless stated:
  - Removal:
    - remove `b` → `c..c`
    - remove `c` → `b..b`
    - remove `b` and `c` → the section is gone and `sections` is omitted
    - remove a branching step whose branch holds a whole section → that section is gone and the others are untouched
  - Moves (section `b..d` on `[a,b,c,d,e]`):
    - move `c` above `b` (⌥↑ on an interior member) → `c..d`, and `c` is still a member
    - move `b` above `a` → `c..d`
    - move `d` below `e` → `b..c`
    - move `d` above `c` → `b..c`, with the order `b,d,c` and `d` still a member
    - move `b` to the end of the list → `c..d`
    - move `e` between `b` and `c` → `e` is a member by contiguity
  - Renames, duplicates and inserts:
    - `renameStepId(b, "bee")` → `bee..c`
    - `duplicateStep(c)` → `b..<copy of c>`
    - `duplicateStep(a)` (not a member) → unchanged
    - `insertStep` between `b` and `c` → a member
    - `insertStep` right before `b` or right after `c` → not a member
  - Nesting: a section inside the `if` of a step that is itself inside an outer section. Removing the outer section's steps outside the branch leaves the inner section untouched.
  - Identity: an edit that doesn't touch sections returns a doc whose `sections` array is `toBe` the old one.
- `sectionIdFor`: `"Check the deal"` → `check_the_deal`; taken → `check_the_deal_2`; `"!!!"` → `section`; `"2024 plan"` → `section_2024_plan`; a 50-char title is cut to 32 chars.
- Validator:
  - Each broken shape, an overlap, a 4001-char note on a step and on a section, and `color: "red"` on a section each produce the codes above, with severity `warning` and `stepId`/`sectionId` as specified.
  - A doc without `sections`, and one with `sections: []`, produce no new issues.
  - `hasErrors` stays false.
- Engine (`packages/engine/src/annotations.test.ts`):
  - The same workflow with and without `note`/`color`/`sections` publishes, runs on the memory storage, and yields identical journals and final status.
  - `saveWorkflow` → `getWorkflow` round-trips the three fields unchanged.

- [ ] **Step 1:** Write `annotations.test.ts`, the new `tree.test.ts` and `validate.test.ts` cases, and the engine test. Run `pnpm vitest run --project core packages/core/src/annotations.test.ts`. Expected: FAIL (`sectionRun` not exported).
- [ ] **Step 2:** Add the types. Implement `annotations.ts`, wire `upkeepSections` into the tree ops, and add the validator checks and `Issue.sectionId`. Export `AnnotationColor`, `Section`, `ANNOTATION_COLORS`, `NOTE_MAX_CHARS`, `isAnnotationColor`, `sectionRun`, `sectionOf`, `upkeepSections`, `SectionEffect` and `sectionIdFor` from `index.ts`.
- [ ] **Step 3:** Update the README "Tree model" paragraph. Run the gates.
- [ ] **Step 4:** Commit `feat(core): step notes, colours and sections kept intact by tree operations`.

---

### Task 2: core — read types, line format, `overview` and `outline` with budgets

**Files:**
- Create: `packages/core/src/agent/read-types.ts`, `agent/format.ts`, `agent/outline.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/agent/outline.test.ts`, `agent/budget.test.ts`, and `agent/fixtures.ts`. `fixtures.ts` is test-only; it holds the doc and manifest builders `flatDoc(n)`, `deepDoc(depth)`, `specExampleDoc()` and `crmLikeManifest()`.

**Interfaces**

Consumes: Task 1 (`sectionRun`, `ANNOTATION_COLORS`, `isAnnotationColor`), `validateWorkflow`, `walkSteps`, `findStep`, `branchesFor`.

Produces:
```ts
// read-types.ts
/** Steps to act on; fields are ANDed. `{}` matches every step. */
export interface Where {
  type?: string;                                  // exact node type
  section?: string;                               // section ID: its members and their subtrees
  within?: { stepId: string; branch?: string };   // descendants (any depth), optionally of one branch
  nameContains?: string;                          // case-insensitive, on the display name (name ?? node label ?? id)
  configHas?: string;                             // config path present (configValueAt !== undefined)
}
export type Include = "config" | "schema" | "refs";
/** Each read's input, exactly the tool's input schema. */
export interface ReadArgs {
  overview: { budget?: number };
  outline: { stepId?: string; branch?: string; after?: string; budget?: number };
  focus: { stepId: string; full?: boolean };
  getSteps: { ids: string[]; include?: Include[]; full?: boolean } | { where: Where; after?: string; limit?: number; include?: Include[]; full?: boolean };
  findSteps: { where: Where };
  availableRefs: { stepId: string; path?: string };
  listNodeTypes: { query?: string; category?: string };
  describeNodeTypes: { types: string[] };
  getIssues: { stepId?: string };
}
export type ReadToolName = keyof ReadArgs;
/** A follow-up call that fetches something a read left out. */
export type FollowUp = { [K in ReadToolName]: { tool: K; args: ReadArgs[K] } }[ReadToolName];
export interface Omission { what: "config" | "notes" | "branch" | "steps"; stepId?: string; branch?: string; count: number; fetch: FollowUp }
export interface OutlineResult {
  text: string;
  /** What was left out, each with the exact call that returns it. Empty when nothing was. */
  omitted: Omission[];
  totals: { steps: number; sections: number; notes: number; errors: number; warnings: number };
}
export interface ReadOptions { ctx?: ValidationContext }
// (Task 3 adds RefInfo, StepDetail and ReadResults to this file.)

// format.ts
/** `…(+1.2k chars)` style cut. */
export function cutString(s: string, max: number): { text: string; cut: boolean };
/** One outline line (without indentation), e.g. `getDeal  Get deal “Load it” [pink] · 1 issue: note "…"`. */
export function stepLine(step: Step, node: NodeManifest | undefined, issues: number, noteMax: number): string;
export function formatCall(f: FollowUp): string;   // outline({stepId:"recheck",branch:"else"})
/** Size of a result against a budget: text.length + JSON.stringify(omitted).length. */
export function resultSize(r: Pick<OutlineResult, "text" | "omitted">): number;

// outline.ts
export function overview(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["overview"], opts?: ReadOptions): OutlineResult;
export function outline(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["outline"], opts?: ReadOptions): OutlineResult;
```

Line format (the spec §3 example):
- **Header:** the first line of `overview` is `trigger  <trigger name> (<kind>[, <caption>])`.
- **Indentation:** two spaces per depth.
- **Branches:** headers are `├ <label>` / `└ <label>`, with `│` continuation.
- **Sections:** the header is `▣ section <id> "<title>" [<color>]`, followed by `: note "<note>"` when there is a note, with the members indented under it. A broken section renders as `▣ section <id> "<title>" [<color>] (broken)` with no members nested; an unknown colour renders as `[gray]`.
- **Steps:**
  - The line starts with `<id>` padded to the list's widest ID + 2, then `<node label>`.
  - Then, in order: ` “<name>”` if set, ` [<color>]` if set, ` · N issue(s)` if there are any, and `: note "<note>"`.
  - Notes are cut to 120 chars, then to 40 under budget pressure. **Any** cut, at 120 or at 40, adds the `notes` omission (budget step 2), whose `fetch` has `full: true`.
- **Config:** when there is room, each step with config gets a continuation line `<indent>    config <compact JSON>`.
- **Totals:** the last line, e.g. `— 12 steps · 1 section · 2 notes · 0 errors · 1 warning`.

Budget: characters, default 4000. The budget covers `text` plus serialized `omitted`. The **floor** is header + totals + one tail marker, with its omission. When `budget` ≥ the floor, `resultSize(result) <= budget`. Below the floor, the result is exactly the floor. Content is dropped in this order:
1. **Config.** Render with config. If over budget, drop every config line and add one `Omission { what: "config", count, fetch: { tool: "getSteps", args: { where: {} or { within }, include: ["config"], limit: 50 } } }`, plus a text line `(config left out: getSteps({where:{},include:["config"],limit:50}))`. For `outline` of a branch, `where` is `{ within: { stepId, branch } }`.
2. **Notes.** Still over: cut notes to 40 chars. Whenever any note was cut (at either length), add `Omission { what: "notes", fetch: { tool: "getSteps", args: { ids: <cut ids>, include: [], full: true } } }`. If that ID list alone would take more than 400 chars, use `{ where: {}, include: [], full: true, limit: 50 }` instead.
3. **Branches.** Still over: collapse branches deepest first. Ties go to the branch with the most steps, then the last in pre-order. A collapsed branch becomes `… 12 steps in branch else: outline({stepId:"recheck",branch:"else"})`, with one `Omission { what: "branch" }` each.
4. **List tail.** Still over, whether from the text or from the omissions list itself: collapse the tail of the longest remaining list to `… 380 more steps after step_120: outline({after:"step_120"})`, adding `stepId`/`branch` for a branch list, with one `Omission { what: "steps" }`. Collapsing a tail also drops the branch omissions inside it.
5. **Tiny budgets.** If the floor exceeds the budget, return exactly the floor, and don't throw.

**Tests must pin**
- The spec §3 example, which is illustrative in its spacing (spec §10):
  - `overview(specExampleDoc(), m, { budget: B })`, where `B` is the smallest budget that drops config but keeps everything else, is pinned as an inline snapshot of the rule-based output. The snapshot is the byte-level source of truth.
  - Separately, each line of the spec example, with runs of whitespace collapsed to one space, appears in order in the whitespace-collapsed output.
- Small docs:
  - A 5-step doc: one read includes every step's config, and `omitted` is `[]`.
  - An unknown-colour section renders `[gray]`.
  - A broken section renders `(broken)` without throwing.
- Budget, at 5, 50 and 500 steps, flat and 12-deep:
  - `resultSize <= 4000` (Review Focus 4). The floor is far below 4000 for these docs.
  - For 500 flat steps, paging `outline({ after })` through every `steps` omission until none remain returns every step ID exactly once across all pages.
  - For 12-deep, each `branch` follow-up (`outline` with that `stepId`/`branch`) returns that branch's steps.
- Custom budgets: `budget: 600` gives `resultSize <= 600`. `budget: 50` (below the floor) returns exactly the floor's shape: the header line, one tail marker line and the totals line in `text`, and one `steps` omission. It never throws, and its size is not asserted.
- An under-budget doc with a 300-char note: the note is cut to 120, and `omitted` holds one `notes` omission with `fetch.args.full === true`.
- The `config` omission's `fetch` is `{ tool: "getSteps", args: { where: {}, include: ["config"], limit: 50 } }`. The `notes` omission's `fetch.args.full` is `true`. Task 3 executes both.

- [ ] **Step 1:** Write `fixtures.ts` and the failing tests. Run `pnpm vitest run --project core packages/core/src/agent/outline.test.ts`. Expected: FAIL.
- [ ] **Step 2:** Implement `read-types.ts`, `format.ts` and `outline.ts`. Export `overview`, `outline`, the types in `read-types.ts`, `cutString`, `stepLine` and `formatCall`.
- [ ] **Step 3:** Gates. Commit `feat(core): overview and outline reads with character budgets`.

---

### Task 3: core — detail reads, selectors, compact schema

**Files:**
- Create: `packages/core/src/agent/selectors.ts`, `agent/compact-schema.ts`, `agent/reads.ts`
- Modify: `agent/read-types.ts` (add `RefInfo`, `StepDetail`, `ReadResults`), `packages/core/src/json-schema.ts` (export `derefSchema`), `packages/core/src/index.ts`
- Test: `packages/core/src/agent/reads.test.ts`, `agent/selectors.test.ts`, `agent/compact-schema.test.ts`, `agent/budget.test.ts` (extend: execute every omission)

**Interfaces**

Consumes: Task 2 types and `overview`/`outline`, `availableScope`, `schemaAtPath`, `describeType`, `branchesFor`, `validateWorkflow`, `configValueAt`, `sectionOf`, `cutString`.

Produces:
```ts
// read-types.ts (added)
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
  /** Paths whose strings were cut (pass full: true for the whole text), e.g. "config.body", "note". */
  cut?: string[];
}
export interface ReadResults {
  overview: OutlineResult;
  outline: OutlineResult;
  focus: StepDetail;
  getSteps: { steps: StepDetail[]; missing: string[]; next?: FollowUp };
  findSteps: { count: number; matches: { id: string; line: string }[] };
  availableRefs: { refs: RefInfo[] };
  listNodeTypes: { types: { type: string; label: string; description?: string; category?: string }[] };
  describeNodeTypes: {
    types: { type: string; label: string; input: JSONSchema; branches: { kind: BranchSpec["kind"]; ids?: string[]; fromConfig?: string }; output: JSONSchema | { declaredBy: string }; operators?: RuleOperatorMeta[] }[];
    unknown: string[];
  };
  getIssues: { issues: Issue[]; errors: number; warnings: number };
}
/** A read, callable uniformly as reads[name](doc, manifest, args). */
export type ReadFn<K extends ReadToolName> = (doc: WorkflowDoc, manifest: Manifest, args: ReadArgs[K], opts?: ReadOptions) => ReadResults[K];

// json-schema.ts (newly exported; wraps the existing private `deref(root, schema)`)
/** Resolves a local `$ref` in `schema` against `root` (one level), as the validator does. */
export function derefSchema(root: JSONSchema, schema: JSONSchema): JSONSchema;
// selectors.ts
/** Matching step IDs in pre-order. */
export function matchSteps(doc: WorkflowDoc, manifest: Manifest, where: Where): string[];
// compact-schema.ts
/** JSON Schema trimmed for a model: $defs resolved inline (cycles become {"$ref":"#recursive"}), x-flowline reduced to {label, widget, enumLabels}, titles dropped. */
export function compactSchema(schema: JSONSchema): JSONSchema;
// reads.ts
export function focus(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["focus"], opts?: ReadOptions): StepDetail;   // include = config, schema, refs
export function getSteps(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["getSteps"], opts?: ReadOptions): ReadResults["getSteps"];
export function findSteps(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["findSteps"], opts?: ReadOptions): ReadResults["findSteps"];
export function availableRefs(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["availableRefs"], opts?: ReadOptions): ReadResults["availableRefs"];
export function listNodeTypes(doc: WorkflowDoc | null, manifest: Manifest, args: ReadArgs["listNodeTypes"]): ReadResults["listNodeTypes"];
export function describeNodeTypes(doc: WorkflowDoc | null, manifest: Manifest, args: ReadArgs["describeNodeTypes"]): ReadResults["describeNodeTypes"];
export function getIssues(doc: WorkflowDoc, manifest: Manifest, args: ReadArgs["getIssues"], opts?: ReadOptions): ReadResults["getIssues"];
/** Every read, by tool name. */
export const reads: { [K in ReadToolName]: ReadFn<K> };
```
The node-type reads take `doc: WorkflowDoc | null`, a wider parameter that is still assignable to `ReadFn`, so they can be called without a doc.

What each read does:
- **`getSteps`:**
  - The `ids` form returns the given IDs in the given order; unknown IDs go to `missing`.
  - The `where` form returns matches in pre-order, starting after `after`. `limit` defaults to 50 and is capped at 200. `next` is set when more steps match.
  - Strings over 500 chars (config values and notes) are cut with `cutString` unless `full: true`, and `cut` lists their paths.
  - `include` defaults to `["config"]`.
- **`listNodeTypes`:** ranks results by a match on label, type or keywords, and `category` filters them.

**Tests must pin**
- Budget follow-ups (Review Focus 4): for 500 flat and 12-deep docs with 4000-char notes, execute every omission of `overview` through `reads[o.fetch.tool](doc, m, o.fetch.args)`. Follow `next` and `steps` omissions until none remain. Then:
  - the union of the returned steps covers every step
  - every step's full config and full note come back uncut
- `focus`:
  - A 20 000-char config string comes back as 500 chars + `…(+19.5k chars)`, with `cut: ["config.body"]`; `full: true` returns it whole.
  - `section` is set for a member.
  - `refs` lists `trigger` and earlier steps only, not later ones.
  - `branches` for a condition lists `if`/`else` with step counts.
- `getSteps`:
  - An unknown ID is listed in `missing`, and the other steps are returned.
  - `include: []` returns no config, schema or refs.
  - The `where` form pages correctly with `after`/`limit`/`next`.
- `availableRefs`: the top level vs `path: "steps.deal.deal"`, which returns child properties with `describeType` types.
- `findSteps`/`matchSteps`:
  - each `Where` field alone and combined
  - `section` includes the members' subtrees
  - `{}` returns all steps
- `listNodeTypes({ query: "mail" })` ranks results, and `category` filters them.
- `describeNodeTypes` for a static-branch node, a `fromConfig` node (switch), a loop and an unknown type (which lands in `unknown`). `input` has no `x-flowline` keys other than label, widget and enumLabels.
- `compactSchema`: a recursive `$defs` schema terminates.
- Uniform calls: loop over a `FollowUp[]` with one entry per read. Each `reads[f.tool](doc, m, f.args)` returns a result for which `expect(result).toBeDefined()` holds, and each has the expected top-level key (`text`, `id`, `steps`, `count`, `refs`, `types` or `issues`).
- A legacy doc with broken sections (Review Focus 3) reads through every read without throwing.

- [ ] **Step 1:** Write the failing tests. Run `pnpm vitest run --project core packages/core/src/agent/reads.test.ts`. Expected: FAIL.
- [ ] **Step 2:** Implement. Export `reads`, each read, `matchSteps`, `compactSchema`, `derefSchema`, `ReadFn`, `ReadResults`, `RefInfo` and `StepDetail`.
- [ ] **Step 3:** Gates. Commit `feat(core): focus, getSteps and the other agent reads`.

---

### Task 4: core — `apply` pipeline with addStep, removeStep, moveStep, setConfig

**Files:**
- Create: `packages/core/src/step-factory.ts`. Move `defaultConfig`, `syncBranches`, `createStep` and `jsonEqual` verbatim from `packages/react/src/store/commands.ts`, which now re-exports them from core.
- Create: `packages/core/src/agent/commands.ts`, `agent/command-schema.ts`, `agent/placeholders.ts`, `agent/apply.ts`, `agent/single.ts`
- Modify: `packages/core/src/index.ts`, `packages/react/src/store/commands.ts`
- Test: `packages/core/src/step-factory.test.ts` (move the React tests of these helpers here, if any exist), `agent/apply.test.ts`, `agent/placeholders.test.ts`, `agent/command-schema.test.ts`

**Interfaces**

Consumes:
- Task 1: `upkeepSections`
- Task 2: `stepLine`, `FollowUp`
- Task 3: `compactSchema`
- Tree ops: `insertStep`, `removeStep`, `moveStep`, `updateStep`, `findStep`
- Also: `generateStepId`, `validateWorkflow`, `checkJson`

Produces:
```ts
// commands.ts
export type StepRef = string;   // a real ID, "$<n>" (n = 1-based command index; $n is the result of commands[n-1]) or "$<fragment ref>"
export type At = { after: StepRef } | { before: StepRef } | { in: { stepId: StepRef; branch: string }; index?: number } | { start: true };
export interface SectionInput { title: string; color: AnnotationColor; note?: string; id?: string }
type ConfigPatch = Record<string, ValueExpr | null>;
export type Command =
  | { op: "addStep"; at: At; type: string; id?: string; name?: string; config?: Record<string, ValueExpr>; note?: string; color?: AnnotationColor; disabled?: boolean }
  | { op: "moveStep"; id: StepRef; to: At }
  | { op: "removeStep"; id: StepRef }
  | { op: "setConfig"; id: StepRef; key: string; value: ValueExpr | null; /** @internal */ nullIsValue?: boolean }
  | { op: "setConfig"; id: StepRef; config: ConfigPatch }
  | SingleCommand   // Task 5 appends members to this alias
  | SectionCommand  // Task 5
  | BulkCommand;    // Task 6 declares the alias, Task 7 appends members
// In this task, SingleCommand, SectionCommand and BulkCommand are declared as `never`. Later tasks replace each declaration with the union of its members.
export type CommandErrorCode =
  | "command.invalid" | "step.notFound" | "section.notFound" | "placeholder.unknown"
  | "node.unknown" | "trigger.unknown" | "branch.unknown" | "location.invalid"
  | "id.taken" | "id.invalid" | "run.invalid" | "section.overlap" | "move.intoSelf"
  | "expect.mismatch" | "readOnly"
  | "config.invalid" | "ref.syntax" | "ref.unresolved" | "ref.outOfScope" | "step.invalidId" | "step.duplicateId";
export interface ApplyError { index: number; path: string; code: CommandErrorCode; message: string; hint?: unknown }
export type ApplyResult =
  | {
      ok: true;
      doc: WorkflowDoc;
      /** Every placeholder used or created → real ID. */
      ids: Record<string, string>;
      /** Step IDs that changed identity in this batch (renameStepId, setType regeneration): old → new. */
      renamed: Record<string, string>;
      /** Outline of the changed region ("" with report: false). */
      changed: string;
      issues: { added: Issue[]; cleared: Issue[]; more?: { added: number; fetch: FollowUp } };
    }
  | { ok: false; error: ApplyError; /** Further shape errors, up to 9. */ more?: ApplyError[] };
export interface ApplyOptions {
  ctx?: ValidationContext;
  /** Skip the Zod shape parse (the caller builds commands from typed code). Default false. */
  trusted?: boolean;
  /** Compute changed, the issue delta and changedStepIds. Default true. */
  report?: boolean;
}

// apply.ts
export function apply(doc: WorkflowDoc, commands: Command[], manifest: Manifest, opts?: ApplyOptions): ApplyResult;
/** Steps added, removed, or whose own fields (not branches) changed, plus sections added/removed/changed. */
export function changedStepIds(before: WorkflowDoc, after: WorkflowDoc): { added: string[]; updated: string[]; removed: string[]; sections: { added: string[]; updated: string[]; removed: string[] } };
/** Thrown by wrappers (the editor store) that turn a failed ApplyResult into an exception. */
export class FlowlineCommandError extends FlowlineTreeError {
  override readonly name: string = "FlowlineCommandError";
  constructor(readonly error: ApplyError);   // message = error.message
}
// command-schema.ts
/**
 * Zod schema of one command; with a manifest, `type` fields are enums of its node/trigger types.
 * `internal: true` (the default for apply) also accepts store-only fields (nullIsValue, verbatim).
 * Cached per (manifest object, internal) in a WeakMap.
 */
export function commandSchema(manifest?: Manifest, opts?: { internal?: boolean }): z.ZodType<Command>;
/** Compact JSON Schema of the command schema at `path` (e.g. ["steps", 0, "branches"]), ≤ 1500 chars. Used for command.invalid hints and by the catalog. */
export function opJsonSchema(manifest: Manifest | undefined, op: string, path: (string | number)[]): JSONSchema;
// placeholders.ts (internal)
export function resolveStepRef(ref: StepRef, ids: Map<string, string>): string | undefined;
export function resolveValuePlaceholders(v: ValueExpr, ids: Map<string, string>): { value: ValueExpr; unknown?: string };
// step-factory.ts (public, used by react)
export function defaultConfig(schema: JSONSchema): Record<string, ValueExpr>;
export function syncBranches(step: Step, m: NodeManifest): Step;
export function createStep(id: string, m: NodeManifest): Step;
/** Deep JSON equality (moved from react). */
export function jsonEqual(a: unknown, b: unknown): boolean;
```

Every command object schema is a `z.strictObject`, so an unknown key (for example `verbatim` under `internal: false`) fails with `command.invalid`, and the error message names the key. The internal-only fields (`nullIsValue` on `setConfig`, `setTriggerConfig` and `setOutput`; `verbatim` on `insertSteps`) exist only in the `internal: true` variant.

The pipeline:
1. **Shape.** Unless `trusted`, parse **every** command with `commandSchema(manifest, { internal: true })` before running any.
   - Errors go in index order: `error` is the first and `more` holds up to 9 others.
   - Each error's `path` is `commands[<i>]` plus the Zod issue path, e.g. `commands[2].config.to`.
   - Its `hint` is `{ expected: opJsonSchema(manifest, op, zodPath) }`.
   - `setConfig.value` is any JSON value (`checkJson`) and is never checked against the field's schema.
2. **Run.** Run the handlers in order on a working copy. The first failure returns `{ ok: false }`. The input doc is never mutated; all tree ops are immutable.
3. **Hints.**
   - `step.notFound`: up to 5 of the closest existing IDs (by Levenshtein distance).
   - `node.unknown`: up to 10 of the closest node types.
   - `branch.unknown`: the step's branch IDs.
   - `placeholder.unknown`: `{ defined: [...placeholders so far], note: "$n is the result of commands[n-1]" }`.
4. **Messages the editor tests rely on:** `Unknown node type "<t>"`, `Unknown trigger type "<t>"`, `Step "<id>" not found`.
5. **Report.** Unless `report: false`:
   1. Compute `changedStepIds`.
   2. Compute the issue delta: `validateWorkflow` before vs after, keyed by `code`, `stepId`, `sectionId`, `field` and `message`. `added` is capped at 20; `more` is `{ added: <rest>, fetch: { tool: "getIssues", args: {} } }`.
   3. Build `changed`: one line per added (`+`), updated (`~`) and removed (`- <id>`) step and section (`▣`), in the after-doc's pre-order, using `stepLine`. It is capped at 2000 chars with `… N more changes: getSteps({ids:[…]})`.

   With `report: false`: `changed: ""` and `issues: { added: [], cleared: [] }`, while `ids` and `renamed` are still filled.
6. **No-op identity.** A handler that changes nothing returns its input doc. If the final doc is `===` the input, `apply` returns the input doc itself.
7. **`addStep`:**
   - `config` is merged over `defaultConfig`.
   - With `id`, it uses that ID, failing with `id.invalid` or `id.taken`; otherwise it calls `generateStepId`.
   - `node.unknown` messages as above.
   - `ids["$n"]` = the new ID.
8. **`moveStep`:**
   - The anchor is resolved after removal.
   - A target inside the step's own subtree fails with `move.intoSelf`.
   - Moving onto its own position is a no-op (`toBe`).
   - Upkeep uses `{ moved: {id} }`.
9. **`setConfig`:**
   - The `key` form: `null` removes the key unless `nullIsValue`. An unchanged value (`jsonEqual`) is a no-op.
   - The `config` form merges, with `null` removing keys.
   - Both forms run `syncBranches` for `fromConfig` nodes.

**Tests must pin**
- Each command's normal case, including the resulting doc shape.
- An unknown step fails with `step.notFound`, with a hint containing the near-miss ID. The input doc must deep-equal its pre-call `structuredClone`.
- Placeholders: `[addStep crm.getDeal, addStep crm.sendEmail with config.subject { $tpl: "Deal {{ steps.$1.deal.name }}" }, setConfig { id: "$2", key: "to", value: "a@b.c" }]`.
  - The template names the generated ID, and `ids` is `{ "$1": "getDeal", "$2": "sendEmail" }`.
  - `$9` fails with `placeholder.unknown` at `commands[0].id`, with `hint.defined` equal to `[]`.
  - A placeholder inside a `$ref` path resolves too.
- Atomicity (Review Focus 2): two good commands, then a failing third.
  - The result is `ok: false`, with `error.index === 2` and an `error.path` starting `commands[2]`.
  - No ID from commands 0–1 appears in the input doc.
- Several shape errors: `error` is the first, and `more` lists the others in index order.
- `apply(doc, [], m)` returns `ok: true` with `doc` `toBe` the input, `changed === ""` and an empty delta.
- No-op identity (M8), one row each, where `result.doc` `toBe` the input:
  - `moveStep` onto its own position
  - `setConfig` with an equal value
  - `setConfig { config: {} }`
  - `setConfig` removing an absent key
- Issue delta:
  - Adding a step with a missing required field lists that `config.required` in `added`, and filling it lists it in `cleared`.
  - 30 added issues give 20 in `added` and `more.added === 10`.
- `changed` contains `+ `, `~ ` and `- ` lines. 300 changes cap at 2000 chars, with the `getSteps` marker.
- `setConfig` null handling:
  - `null` removes the key; `nullIsValue: true` stores `null`.
  - `config: { a: 1, b: null }` merges `a` and removes `b`.
  - A switch `cases` change syncs branches.
  - A half-typed invalid value (`"12a"` for a number field) is accepted and reported as `config.invalid` in `added`, not rejected.
- `trusted: true, report: false`: the same doc as the default mode for a setConfig batch, with `changed === ""`. An invalid-shape command in trusted mode is not shape-checked, but handlers still reject unknown IDs.
- The `command.invalid` hint for `addStep` without `at` is a JSON Schema containing the `at` property, and is at most 1500 chars long.
- `commandSchema(m) === commandSchema(m)`: the cache works.
- Strictness: `{ op: "removeStep", id: "a", extra: 1 }` fails with `command.invalid`, and the message contains `extra`. `commandSchema(m, { internal: false })` rejects `nullIsValue` on `setConfig`.

- [ ] **Step 1:** Move `defaultConfig`/`syncBranches`/`createStep`/`jsonEqual` to core with their tests. Make `packages/react/src/store/commands.ts` import and re-export them. Run `pnpm vitest run --project react packages/react/src/store`. Expected: PASS, since this is a pure move.
- [ ] **Step 2:** Write the failing tests. Run `pnpm vitest run --project core packages/core/src/agent/apply.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Export `apply`, `Command`, `At`, `StepRef`, `SectionInput`, `ApplyResult`, `ApplyError`, `ApplyOptions`, `CommandErrorCode`, `FlowlineCommandError`, `changedStepIds`, `commandSchema`, `opJsonSchema`, `defaultConfig`, `syncBranches`, `createStep` and `jsonEqual`.
- [ ] **Step 4:** Gates. Commit `feat(core): atomic apply pipeline with the core step commands`.

---

### Task 5: core — remaining single-step and section commands, repairs

**Files:**
- Create: `packages/core/src/agent/sections.ts`, `agent/repairs.ts`
- Modify: `agent/commands.ts` (`SingleCommand`, `SectionCommand`), `agent/command-schema.ts`, `agent/single.ts`, `agent/apply.ts` (dispatch), `packages/core/src/index.ts`
- Modify: `packages/core/src/step-factory.ts`. Move `replaceStepType` there from `packages/react/src/store/commands.ts`, and add `copyName`, a public port of the private `copyName` in `packages/react/src/store/editor-store.ts:694` with identical rules.
- Modify: `packages/react/src/store/commands.ts`, which re-exports `replaceStepType` from core. Task 9 deletes the private React `copyName`.
- Test: `packages/core/src/agent/single.test.ts`, `agent/sections.test.ts`, `agent/repairs.test.ts`, `packages/core/src/step-factory.test.ts` (extend)

**Interfaces**

Consumes: the Task 4 pipeline. From the tree: `renameStepId`, `codeBlocksRename`, `isGeneratedStepId`, `duplicateStep`. From Task 1: `sectionRun`, `sectionIdFor`, `NOTE_MAX_CHARS`.

Produces:
```ts
// step-factory.ts (public)
/** The doc with step `id` switched to node `m`: config reset to defaults, children kept (moved verbatim from react). */
export function replaceStepType(doc: WorkflowDoc, id: string, m: NodeManifest): WorkflowDoc;
/**
 * The display name for a copy of `base`. Strips a trailing " (copy)" or " (copy N)", then returns
 * "<stem> (copy)", or "<stem> (copy 2)", "(copy 3)"… for the first name not in `taken`.
 */
export function copyName(base: string, taken: ReadonlySet<string>): string;
// commands.ts
type SingleCommand =
  | { op: "duplicateStep"; id: StepRef }                    // copy named copyName(display name, all display names)
  | { op: "renameStep"; id: StepRef; name: string }         // "" clears
  | { op: "renameStepId"; id: StepRef; newId: string }
  | { op: "setType"; id: StepRef; type: string }
  | { op: "setDisabled"; id: StepRef; disabled: boolean }
  | { op: "setNote"; id: StepRef; note: string | null }     // ≤ NOTE_MAX_CHARS; null or "" removes
  | { op: "setColor"; id: StepRef; color: AnnotationColor | null }
  | { op: "setTrigger"; type: string; config?: ConfigPatch }
  | { op: "setTriggerConfig"; key: string; value: ValueExpr | null; /** @internal */ nullIsValue?: boolean }
  | { op: "setTriggerConfig"; config: ConfigPatch }
  | { op: "setOutput"; key: string; value: ValueExpr | null; /** @internal */ nullIsValue?: boolean }
  | { op: "setOutput"; config: ConfigPatch }
  | { op: "renameWorkflow"; name: string };
type SectionCommand =
  | ({ op: "addSection"; first: StepRef; last: StepRef } & SectionInput)
  | { op: "updateSection"; id: StepRef; title?: string; color?: AnnotationColor; note?: string | null; first?: StepRef; last?: StepRef }
  | { op: "removeSection"; id: StepRef };
// repairs.ts
/** Commands that fix one section.broken / section.overlap / note.tooLong issue, or [] when it can't be fixed automatically. */
export function annotationRepairs(doc: WorkflowDoc, issue: Issue): Command[];
```

`nullIsValue` on `setTriggerConfig`/`setOutput` is internal, like `setConfig`'s. It is accepted only by `commandSchema(…, { internal: true })`, and never appears in the catalog.

How each command behaves:
- **`setType`** reproduces `EditorActions.replaceStep` exactly:
  - The same type is a no-op.
  - It follows `replaceStepType` semantics.
  - A generated ID is regenerated via `renameStepId`, unless `codeBlocksRename`.
  - It records `renamed[old] = new` and `ids["$n"]` = the resulting ID.
- **`renameStepId`** records `renamed`.
- **`duplicateStep`** names the copy `copyName(displayName, <display names of all steps>)`, which reproduces the editor's `(copy)`, `(copy 2)`… sequence. It sets `ids["$n"]` = the copy's ID.
- **`setTrigger`:** the same type with no `config` is a no-op; the same type with `config` merges it, like `setTriggerConfig`; a different type resets to the defaults, then merges `config`. An unknown type fails with `Unknown trigger type "<t>"` (`trigger.unknown`).
- **`setOutput`**: removing the last key removes `doc.output`, as the store does today.
- **`addSection`:**
  - `first`/`last` must be in one list and in order; otherwise it fails with `run.invalid`, with hint `{ first: location, last: location }`.
  - Overlap with an existing section in the same list fails with `section.overlap`, with hint `{ section: id }`. Nesting in a branch of a step inside another section is allowed.
  - `ids["$n"]` = the section ID.
- **`updateSection`** with `first`/`last` re-checks both rules. An unknown ID fails with `section.notFound`, whose hint lists the section IDs.
- **`removeSection`** keeps the steps.
- **Duplicated section IDs:** when two sections in `doc.sections` share an ID, `updateSection` and `removeSection` act on the **later** one.
- **`annotationRepairs`**, by issue:
  - A broken section with one surviving endpoint: `updateSection`, shrinking it to that endpoint.
  - A broken section with no surviving endpoint: `removeSection`.
  - A reversed section: `updateSection`, swapping `first` and `last`.
  - First and last in different branches: `updateSection { last: <first> }`, shrinking the section to its first step.
  - A bad colour: `updateSection { color: "gray" }`.
  - A duplicate or invalid section ID: `removeSection` of that section (the later one, for a duplicate), then `addSection` with the same `first`, `last`, `title`, `color` and `note`, and a fresh ID from `sectionIdFor`.
  - `section.overlap`: `removeSection` of the later section.
  - `note.tooLong`: `setNote` (or `updateSection { note }`) cut to 4000 chars.

**Tests must pin**
- A table with one row per command. Each row covers:
  - the normal case
  - `step.notFound`/`section.notFound`, with the input left untouched
  - a `$n`-addressed row, where the target is created by an earlier command in the batch
  - an atomic row: the command succeeds, and a failing next command leaves the input deep-equal to a pre-call `structuredClone`
- `duplicateStep` twice on "Send email" names the copies "Send email (copy)" and "Send email (copy 2)". `copyName("A (copy 2)", {"A (copy)"})` is `"A (copy 2)"`.
- No-op identity (M8), one row each, where `result.doc` `toBe` the input:
  - `renameStep` to the same name
  - `renameStepId` to the same ID
  - `setType` to the same type
  - `setDisabled` to the current value
  - `setNote` with the same text
  - `setNote(null)` on a step with no note
  - `setColor` with the same colour
  - `setTrigger` with the same type and no config
  - `setTriggerConfig` with an equal value
  - `setOutput` with an equal value
  - `renameWorkflow` with the same name
  - `updateSection` with the same values
- `setType`: core-specific assertions only. The store's `replaceStep` tests keep covering the rest through Task 9.
  - A generated ID is regenerated, and a `{{steps.<old>…}}` ref elsewhere is rewritten.
  - `renamed` is `{ old: new }`, and `ids["$1"]` is the new ID.
- `setTrigger`:
  - A different type resets the config to its defaults, then merges `config`.
  - The same type with `config` merges it.
- Section placeholders (S11):
  - `[addSection {…}, updateSection { id: "$1", color: "green" }, removeSection { id: "$1" }]` resolves `$1` to the new section's ID.
  - An unknown `$2` fails with `placeholder.unknown`.
- Sections:
  - `addSection`: the normal case, reversed, two lists, overlap, and nested-in-branch (allowed).
  - `updateSection` retargeting.
  - `removeSection`.
  - `moveStep` of a section's `first` via `apply` shrinks the section.
  - ⌥↑ of an interior member via `moveStep` keeps the section (Review Focus 1).
- `setNote` with 4001 chars fails with `command.invalid` at `commands[0].note`.
- `annotationRepairs` fixes each issue kind, one row each: missing endpoint (one survivor and none), reversed, different branches, bad colour, duplicate ID, invalid ID, overlap and a long note. After applying the returned commands, `validateWorkflow` no longer reports the issue. For a duplicate ID, the first section keeps its ID and the later one gets `sectionIdFor(title)`.

- [ ] **Step 1:** Failing tests. **Step 2:** Move `replaceStepType`, add `copyName` and implement the commands. Export `annotationRepairs`, `replaceStepType` and `copyName`. **Step 3:** Gates, including `pnpm vitest run --project react packages/react/src/store`. Commit `feat(core): single-step, trigger, output and section commands`.

---

### Task 6: core — bulk add: `insertSteps` (incl. verbatim) and `replaceSteps`

**Files:**
- Create: `packages/core/src/agent/fragments.ts`
- Modify: `agent/commands.ts` (declare `BulkCommand`), `agent/command-schema.ts`, `agent/apply.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/agent/fragments.test.ts`

**Interfaces**

Consumes: Tasks 4–5 internals, `createStep`, `syncBranches`, `branchesFor`, `validateWorkflow`, `upkeepSections`, `sectionIdFor`, and `availableRefs` + `compactSchema` (for hints).

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
/** Task 7 appends members to this alias. */
type BulkCommand =
  | { op: "insertSteps"; at: At; steps: Fragment[]; section?: SectionInput; /** @internal store paste */ verbatim?: boolean }
  | { op: "replaceSteps"; first: StepRef; last: StepRef; steps: Fragment[] };
```

**`insertSteps`, normal mode:**
1. **Build all steps first.**
   - IDs come from `id` or from `generateStepId`, checked against the doc plus the steps already built.
   - Each `ref` registers `$<ref>`; a duplicate `ref` in the batch fails with `command.invalid`.
   - Config = `defaultConfig` merged with `config`. Placeholders are resolved after all IDs exist, so a reference to a later sibling's `$ref` resolves and then fails the scope check, as it should.
   - Branches must be declared by the node (`branchesFor` on the built step). An undeclared key fails with `branch.unknown` at `…steps[0].branches.<key>`, with the declared IDs as hint.
   - `syncBranches` fills in missing declared branches.
2. **Insert and validate.** Insert the run at `at`, then validate the candidate doc once.
   - Reject on the first issue among the inserted steps whose code is one of `node.unknown`, `branch.unknown`, `config.invalid`, `ref.syntax`, `ref.unresolved`, `ref.outOfScope`, `step.invalidId` or `step.duplicateId`. Every other issue, including `config.required` and warnings, goes to `issues.added`.
   - Map the issue back to its fragment path, e.g. `commands[i].steps[0].branches.else[1].config.to`.
   - Hints: for `ref.*`, the valid refs at that position; for `config.invalid`, `compactSchema` of that field (≤ 1500 chars).
3. **Section.** `section` wraps the inserted top-level run as `{ id: section.id ?? sectionIdFor(title), first, last }`. Overlap with an existing section in that list fails with `section.overlap`.
4. **Placeholder result.** `ids["$n"]` = the first top-level inserted step.

**`insertSteps`, verbatim mode (`verbatim: true`, store paste only):**
- The given `id`s are used as-is and must be free; otherwise it fails with `id.taken`.
- Config is taken as-is, with no default merge. Branches are kept as-is, including undeclared ones; no `syncBranches` runs.
- Unknown node types are allowed.
- There is no validation rejection; issues appear only in the report.
- `ref` and `section` are still honoured.

**`replaceSteps`:**
- `first..last` must be a run; otherwise it fails with `run.invalid`.
- Remove the run, then insert the fragments at its position, following the normal-mode rules.
- `upkeepSections` uses a `subst` that maps every replaced member to the new top-level IDs, so a section that contained the run keeps them.
- Refs elsewhere to the removed steps show up as `ref.unresolved` in `issues.added`. They are not rejected, because only inserted steps are gated.

**Tests must pin**
- The spec §3 example flow built in one `insertSteps`: a condition with `then`/`else` fragments, and a `ref` used as `{{steps.$deal.deal.stage}}` in a nested branch. The doc must come out exact, and `ids` holds `$1` and every `$ref`.
- An unknown type deep in a branch fails with `node.unknown`, at path `commands[0].steps[1].branches.else[0].type`, with a hint that contains the closest type.
- Branch keys: an undeclared key fails with `branch.unknown` and lists the declared IDs; a loop's `body` is accepted.
- Ref and config problems:
  - A ref to a step that comes later, or that sits inside a sibling branch, fails with `ref.outOfScope`, with the valid refs as hint.
  - A literal of the wrong type fails with `config.invalid`, with the field schema as hint.
  - A missing required field is accepted and listed in `issues.added`.
- Verbatim (M2):
  - A step that reads `steps.load`, pasted above `load`, succeeds, and `ref.outOfScope` appears in `issues.added`.
  - A config with a removed default key stays without it.
  - An undeclared leftover branch is kept.
  - A taken ID fails with `id.taken`.
- `section`: wrapping works; a `section` that overlaps an existing one is rejected and leaves the doc untouched.
- `replaceSteps`:
  - Replacing `b..c` inside section `a..d` leaves the section as `a..d`.
  - Replacing exactly a section's run makes the section span the new steps.
  - Reversed or two-list runs fail with `run.invalid`.
- Atomicity (Review Focus 2): a failing fragment after a successful `insertSteps` in the same batch leaves the input doc untouched.
- Schema split: `commandSchema(m, { internal: false })` rejects `verbatim` (the object is strict, so this fails with `command.invalid`), while `internal: true` accepts it.
- Every placement row: the `$n` form (`insertSteps` at `{ after: "$1" }` after an `addStep`) and the atomic row (a failing next command) hold for both `insertSteps` and `replaceSteps`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement, and export `Fragment`. **Step 3:** Gates. Commit `feat(core): insertSteps and replaceSteps with whole-fragment validation`.

---

### Task 7: core — bulk edit and restructure, `cloneRunWithFreshIds`

**Files:**
- Create: `packages/core/src/agent/bulk.ts`
- Modify: `packages/core/src/tree.ts` (add public `cloneRunWithFreshIds`), `agent/commands.ts` (append to `BulkCommand`), `agent/command-schema.ts`, `agent/apply.ts`, `index.ts`
- Test: `packages/core/src/agent/bulk.test.ts`, `agent/sections-upkeep.test.ts` (the §8 upkeep matrix through commands), `packages/core/src/tree.test.ts` (extend)

**Interfaces**

Consumes: Task 3 `matchSteps`/`Where`, and the Tasks 4–6 internals. From the tree: `assignFreshIds` and `rewriteRefs` (internal).

Produces:
```ts
// tree.ts (public)
/**
 * Copies a run of steps (with subtrees) with fresh IDs unique in `doc`, remapping refs inside the copy
 * that point at steps of the run to their copies. Refs to steps outside the run are kept.
 */
export function cloneRunWithFreshIds(doc: WorkflowDoc, steps: readonly Step[]): { steps: Step[]; ids: Map<string, string> };
// commands.ts
export interface StepUpdate { id: StepRef; set?: { name?: string; disabled?: boolean; note?: string | null; color?: AnnotationColor | null }; config?: ConfigPatch }
type BulkCommand =
  | /* Task 6 members: insertSteps, replaceSteps */
  | { op: "duplicateSteps"; first: StepRef; last: StepRef; at?: At }      // default: right after last
  | { op: "updateSteps"; updates: StepUpdate[] }
  | { op: "updateSteps"; where: Where; set?: StepUpdate["set"]; config?: ConfigPatch; expect: number }
  | { op: "replaceInConfig"; find: string; replace: string; where?: Where; expect: number }
  | { op: "moveSteps"; first: StepRef; last: StepRef; to: At }
  | { op: "removeSteps"; ids: StepRef[] } | { op: "removeSteps"; first: StepRef; last: StepRef } | { op: "removeSteps"; where: Where; expect: number }
  | { op: "wrapSteps"; first: StepRef; last: StepRef; in: { type: string; branch: string; config?: Record<string, ValueExpr> } }
  | { op: "unwrapStep"; id: StepRef; keep: string };
// command-schema.ts (exported from the module for Task 8, not from index.ts)
/** Strict Zod schema of `Where`, shared by the selector commands and the read argument schemas. */
export const whereSchema: z.ZodType<Where>;
```

How each command behaves:
- **Selectors:** every selector command requires `expect`. A different match count fails with `expect.mismatch`, with hint `{ matched: [ids] }`. `expect: 0` with no matches is a no-op success that returns the input doc (`toBe`).
- **`duplicateSteps`:**
  - The copy comes from `cloneRunWithFreshIds`. Each top-level copy is named with `copyName`, like `duplicateStep`.
  - When the copy is inserted right after `last`, `upkeepSections` uses subst `last → [last, …copies]`, so copies of a section's run join it.
  - `ids["$n"]` = the first copy.
- **`updateSteps`:**
  - The list form applies each update in order, and later updates see earlier ones. An unknown ID fails with `step.notFound` at `commands[i].updates[k].id`.
  - `set.name: ""` clears the name. `note: null` or `color: null` removes the field.
  - An update that changes nothing is a no-op.
- **`replaceInConfig`:**
  - It replaces every occurrence of `find` (a plain, case-sensitive substring) in string literals and `$tpl` strings of step config. It does not touch `$ref` paths or trigger config.
  - `expect` counts steps with at least one replacement.
  - `find: ""` fails with `command.invalid`.
- **`moveSteps`:**
  - The run is checked first; otherwise it fails with `run.invalid`.
  - `to` is resolved after removal. A target inside the run's own subtree fails with `move.intoSelf`.
  - `upkeepSections` uses `moved` = the run's IDs. A section equal to or inside the run moves with it. A partially covered section keeps the members that land inside its span (rule 2), and the others leave.
- **`removeSteps`:** the `ids` form skips descendants of other removed IDs; the `where` form does the same. Dangling refs appear in `issues.added`.
- **`wrapSteps`:**
  - `in.type` must declare `in.branch` for the built wrapper; otherwise it fails with `branch.unknown`.
  - The wrapper takes the run's place. `upkeepSections` substitutes every run member with `[wrapperId]`, so the wrapper replaces the run inside any enclosing section. Sections inside the run move into the branch unchanged.
  - `ids["$n"]` = the wrapper ID.
- **`unwrapStep`:**
  - The step must have branches; otherwise it fails with `command.invalid`. `keep` must be one of them; otherwise it fails with `branch.unknown`.
  - The other branches' steps are removed and listed in `changed`.
  - `upkeepSections` uses subst `id → kept IDs`. A section from the kept branch that now overlaps an outer section in the lifted list is dropped by upkeep rule 4, and listed as `- ▣ <id>` in `changed`.

**Tests must pin**
- Each command: the normal case; `expect.mismatch` (with the matched IDs) and `expect: 0` as a `toBe` no-op for selector forms; a `$n`-addressed row (`first`/`last`/`id` created earlier in the batch); and an atomic row, where a failing next command leaves the input deep-equal to a pre-call `structuredClone`.
- `updateSteps` list form: two updates to the same step, where the second wins; `set.name: ""` clears the name.
- The spec §8 section-upkeep matrix through commands, one row each. Each row asserts the final `sections`, and that `validateWorkflow` reports no `section.*` issue:
  - delete: `removeSteps` of the first member, of the last member, and of all members
  - move: `moveSteps` of the whole run, of a part, of one member out, and of an interior pair up one (which keeps them)
  - duplicate: `duplicateSteps` of the section's run, and of its last member
  - wrap: the whole section run; a run inside a section; and a run overlapping a section's start, in the same list, where the wrapper takes the member's place and the section becomes `wrapper..last`
  - unwrap: inside a section, and with a kept branch that contains its own section
  - replace: covered by Task 6's `replaceSteps` rows, not repeated here
- `cloneRunWithFreshIds([load, email(uses {{steps.load.x}})])`: the copy of `email` references the copy of `load`, and an outside ref stays unchanged. `duplicateSteps` gets the same result.
- `replaceInConfig`: literals and templates are changed and `$ref`s are not.
- `moveSteps` into its own subtree fails with `move.intoSelf`.
- `unwrapStep` keeping `else`: the `else` steps are lifted in order, and the removed `if` steps are listed in `changed`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. Export `cloneRunWithFreshIds` and `StepUpdate` from `index.ts` (`Where` is already exported). Export `whereSchema` from `command-schema.ts` only. **Step 3:** Gates. Commit `feat(core): bulk edit and restructure commands with section upkeep`.

---

### Task 8: core — tool catalog and `runTool`

**Files:**
- Create: `packages/core/src/agent/catalog.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/agent/catalog.test.ts` (fixture manifest), plus `examples/mini-crm/server/src/catalog.test.ts` and its snapshot `__snapshots__/catalog.test.ts.snap` (a snapshot against the mini-crm manifest)
- Modify: `examples/mini-crm/server/src/app.ts`. Extract the inline `createRegistry([...])` (around line 170) into an exported `createCrmRegistry(): Registry`, and have the app use it.

**Interfaces**

Consumes: Tasks 2–3 `reads`/`ReadArgs`, Tasks 4–7 `apply`, `commandSchema(manifest, { internal: false })`, `opJsonSchema`, and Task 7's `whereSchema` (from `agent/command-schema.ts`).

Produces:
```ts
export interface ToolDefinition { name: string; description: string; inputSchema: JSONSchema }
export function commandCatalog(manifest: Manifest, opts?: { include?: ("reads" | "commands")[] }): ToolDefinition[];
export type ToolState = { doc: WorkflowDoc; manifest: Manifest; ctx?: ValidationContext };
/** Runs one catalog tool call. For "apply", `result` is the ApplyResult and `doc` the new doc to keep (on success). */
export function runTool(state: ToolState, name: string, args: unknown):
  | { ok: true; result: unknown; doc?: WorkflowDoc }
  | { ok: false; error: { code: "tool.unknown" | "command.invalid"; message: string; path?: string } };
/** Strict Zod schemas of each read's arguments (Where reuses whereSchema). The catalog's read input schemas are generated from these. */
export const readArgSchemas: { [K in ReadToolName]: z.ZodType<ReadArgs[K]> };
// examples/mini-crm/server/src/app.ts
export function createCrmRegistry(): Registry;
```

What the catalog contains:
- **The `apply` tool.** Its input is `{ commands: Command[] }`. The schema is `z.toJSONSchema(z.object({ commands: z.array(commandSchema(manifest, { internal: false })) }), { target: "draft-2020-12", io: "input", reused: "ref" })`, with the top-level `$schema` removed. Shared pieces (the node-type enum, `At`, `Fragment`, `ValueExpr`, `Where`) sit once under `$defs`.
- **One tool per read.** Names equal the read names, and each input schema is `z.toJSONSchema(readArgSchemas[name], …)` with the same options.
- **Manifest enums:**
  - node `type` fields, via one shared `$defs` enum
  - trigger `type` in `setTrigger`
  - `listNodeTypes.category`, from the manifest's categories
  - `branch` fields: an enum of the union of every node's static branch IDs, plus `body` for loops, **only when no node in the manifest has `fromConfig` branches**. Otherwise the field is a string, whose description says the valid IDs depend on the node, and says to use `describeNodeTypes`.
- **Descriptions** are written for a model, each with one short JSON example.
  - `overview`: "Start here. Then describeNodeTypes for any node type you'll add."
  - `apply` explains:
    - atomicity
    - that `$n` is the result of `commands[n-1]`, and that fragment `ref`s become `$<ref>`
    - `expect`
    - templates (`{ "$tpl": "Hi {{ trigger.contact.name }}" }`)
    - "the result includes the changed outline and issue delta, so there's no need to re-read after success"

  No example uses `nullIsValue` or `verbatim`.
- **Output:** plain JSON Schema, with no `x-flowline` keys.

What `runTool` does:
- For a read, it parses `args` with `readArgSchemas[name]`, then calls `reads[name](state.doc, state.manifest, args, { ctx })`. Bad read arguments fail with `command.invalid`, with `path`.
- For `apply`, it checks only the envelope `{ commands: unknown[] }`; a bad envelope fails with `command.invalid`. Otherwise it calls `apply(state.doc, commands, state.manifest, { ctx })` and returns the `ApplyResult` as `result`, with `ok: true`. Command shape errors come back inside `result` (with `hint` and `more`), not as a `runTool` error.
- An unknown tool fails with `tool.unknown`.

**Tests must pin**
- Fixture manifest:
  - `commandCatalog(m)` names are `["apply", "overview", "outline", "focus", "getSteps", "findSteps", "availableRefs", "listNodeTypes", "describeNodeTypes", "getIssues"]`.
  - `include: ["reads"]` omits `apply`; `include: ["commands"]` has only `apply`.
- Every JSON example embedded in a description parses with `commandSchema(m, { internal: false })` (for `apply`) or with the read's argument schema.
- Enums:
  - The node-type enum in `$defs` equals `m.nodes.map(n => n.type)`, and every `type` field references it.
  - The `setTrigger.type` enum equals the trigger types.
  - With no `fromConfig` node, `branch` is an enum; with one, it is a string.
- `JSON.stringify(catalog)` contains no `x-flowline`, no `"$schema"`, no `nullIsValue` and no `verbatim`.
- `runTool` round trip on a fixture: `overview`, then `apply`, then `getIssues`, feeding each call's `doc` into the next.
- `runTool` errors:
  - an unknown tool fails with `tool.unknown`
  - bad read args fail with `command.invalid` and a path
  - `apply` with `{ commands: 3 }` fails with `command.invalid`
  - `apply` with a malformed command returns `ok: true`, with `result.ok === false`, `result.error.code === "command.invalid"` and a `hint`
- mini-crm:
  - `expect(commandCatalog(createCrmRegistry().manifest())).toMatchSnapshot()`.
  - `JSON.stringify(catalog).length < 40_000`, a size budget. If it fails, shrink the descriptions and `$defs`; don't raise the limit without the controller's approval.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement, and export `commandCatalog`, `ToolDefinition`, `runTool`, `ToolState` and `readArgSchemas`. Extract `createCrmRegistry()`. **Step 3:** Write the snapshot with `pnpm vitest run --project mini-crm examples/mini-crm/server/src/catalog.test.ts -u`, run once. Review it by eye for the enums, `$defs` and descriptions. **Step 4:** Gates. Commit `feat(core): manifest-derived tool catalog and runTool`.

---

### Task 9: react — EditorActions on `apply`, no new behaviour (regression gate)

This task can run alongside Tasks 7–8. It touches only `packages/react/src/store/*`.

**Files:**
- Modify: `packages/react/src/store/editor-store.ts`, `packages/react/src/store/commands.ts` (`atFromLocation`, `stepToFragment`)
- Test: `packages/react/src/store/editor-store.test.ts`, which is **unchanged**, plus `packages/react/src/store/editor-store.apply.test.ts` (new, small)

**Interfaces**

Consumes: core `apply` with `{ trusted: true, report: false }`, `Command`, `At`, `Fragment`, `FlowlineCommandError` (Tasks 4–6), and `copyName` (Task 5). Delete the private `copyName` in `editor-store.ts` and import core's.

Produces:
```ts
// store/commands.ts
/** The command anchor for a StepLocation (`after` the previous sibling, else `start`, or `in` at index 0). Throws FlowlineTreeError for a missing parent or out-of-range index. */
export function atFromLocation(doc: WorkflowDoc, loc: StepLocation): At;
/** A step (with subtree) as a verbatim fragment, keeping IDs, config and branches exactly. */
export function stepToFragment(step: Step): Fragment;
```
Signatures of the existing `EditorActions` and `EditorState` are unchanged in this task.

Every doc-changing `EditorActions` method becomes:
1. Translate the call to `Command[]`.
2. Call `apply(doc, cmds, manifest, { ctx, trusted: true, report: false })`.
3. On `ok: false`, throw `new FlowlineCommandError(error)`.
4. If `result.doc === doc`, return without committing. This is the no-op identity rule.
5. Otherwise `commit` with today's coalesce keys and side effects, computed as today:
   - selecting the new step (`result.ids["$1"]`)
   - `needsTest`
   - resetting local samples
   - keeping `selection` on renamed IDs (`result.renamed`)

The mapping from method to command:
- `insertStep` → `addStep` with `atFromLocation`. It throws `/Unknown node type "nope.x"/` and a `FlowlineTreeError` for bad locations, as today.
- `replaceStep` → `setType`
- `removeStep` → `removeStep`
- `duplicateStep` → `duplicateStep`, or `addStep`-equivalent semantics for `opts`, kept as today
- `moveStep` → `moveStep`, with `to` computed on the doc after removal
- `renameStep` → `renameStep`
- `toggleDisabled` → `setDisabled`
- `setConfig` → `setConfig`: `undefined` becomes `null`, a `null` value adds `nullIsValue: true`, and an unchanged value sends no command
- `setTrigger` → `setTrigger`
- `setTriggerConfig` → `setTriggerConfig`
- `setOutput` → `setOutput`
- `renameWorkflow` → `renameWorkflow`
- `paste` → `insertSteps { at: atFromLocation(doc, loc), verbatim: true, steps: [stepToFragment(cloneWithFreshIds(doc, clipboard))] }`

These are not doc commands and stay as they are: `select`, `setServerIssues`, samples, `hydrateLocal`, `undo`, `redo`, `markSaved`, `markPublished`, `replaceDoc`, `copy`.

**Tests must pin**
- The whole existing `editor-store.test.ts` passes **without edits**, including the 200-step `< 20ms` revalidation test, clipboard lines 289/291, the unknown node and trigger messages, and the history round trip.
- `editor-store.apply.test.ts`:
  - A failed action throws `FlowlineCommandError`, which is also `instanceof FlowlineTreeError`.
  - A no-op action adds no history entry: `renameStep` to the same name, and `setTrigger` to the current type.
  - `toggleDisabled` twice, then `undo()` twice, returns the original doc object (`toBe`).
  - A paste of a step whose refs are out of scope at the target succeeds.
  - A paste keeps a config with a removed default key without that key.

- [ ] **Step 1:** Run `pnpm vitest run --project react packages/react/src/store` to record the baseline. Expected: PASS.
- [ ] **Step 2:** Write `editor-store.apply.test.ts`. Its new assertions fail where behaviour differs, for example the error class.
- [ ] **Step 3:** Re-implement the actions on `apply`. Run both files. Expected: PASS, and `editor-store.test.ts` shows no diff.
- [ ] **Step 4:** Gates. Commit `refactor(react): run editor actions through core apply`.

---

### Task 10: react — store state, `apply` action, agent bridge, `onStoreReady`

**Files:**
- Modify: `packages/react/src/store/editor-store.ts`, `canvas/canvas-context.ts` (remove `readOnly` from `CanvasUiState`), `canvas/workflow-canvas.tsx` (the `readOnly` prop sets the store flag), and the readers of the store's `readOnly`: `canvas/keyboard.ts`, `canvas/actions.ts`, `canvas/step-card.tsx` (line ~305), `canvas/edges.tsx` (line ~37) and `canvas/add-placeholder.tsx` (line ~23). Also modify `editor/editor-load.ts` (store lifecycle), `editor/workflow-editor.tsx` (`onStoreReady`), `run/run-viewer.tsx` (`readOnly: true`) and `index.ts`.
- Create: `packages/react/src/agent-bridge.ts`
- Test: `packages/react/src/store/editor-store.range.test.ts` (new), `packages/react/src/agent-bridge.test.tsx` (new), `editor/workflow-editor.test.tsx` (extend), `editor-store.test.ts` (unchanged)

**Interfaces**

Consumes: core `apply` (full report), `changedStepIds`, `reads`, `runTool`, `ReadArgs`, `ReadResults`, `ReadToolName`, `cloneRunWithFreshIds`, `SectionInput`, `AnnotationColor`; Task 9's wrappers, `atFromLocation` and `stepToFragment`.

Produces:
```ts
// editor-store.ts
interface EditorState {
  /** A contiguous run of steps in one list, or null. Pruned on every doc change like `selection`. */
  range: { first: string; last: string } | null;
  /** Single source of truth: doc-changing actions throw FlowlineCommandError(code "readOnly") and `apply` returns code "readOnly". */
  readOnly: boolean;
  /** Steps and sections changed by the last `apply` action, for a brief canvas highlight. */
  flash: { ids: string[]; sections: string[]; token: number } | null;
  /** The whole copied run (clipboard keeps the first step, as before). */
  clipboardRun: Step[] | null;
}
interface EditorActions {
  /**
   * Runs commands as one undo step, with the full report. Never throws. A burst with the same
   * coalesceKey joins the previous step. Remaps selection, range, samples, testState and sampleTypes
   * through `renamed`, and prunes removed IDs. Sets `flash` unless `flash: false`.
   */
  apply(commands: Command[], opts?: { coalesceKey?: string; flash?: boolean }): ApplyResult;
  /** Selects the run between two steps of one list; returns false (changing nothing) when they are in different lists. */
  selectRange(first: string, last: string): boolean;
  clearRange(): void;
  setReadOnly(readOnly: boolean): void;
  copyRange(first: string, last: string): void;              // clipboardRun = run; clipboard = run[0]
  removeRange(first: string, last: string): void;
  duplicateRange(first: string, last: string): string;        // first copy's ID
  moveBy(first: string, last: string, delta: -1 | 1): void;  // no-op at the list edge
  addSection(first: string, last: string, input: SectionInput): string;
  updateSection(id: string, patch: { title?: string; color?: AnnotationColor; note?: string | null }): void;
  removeSection(id: string): void;
  setNote(id: string, note: string | null): void;           // coalesces `note\0<id>`
  setColor(id: string, color: AnnotationColor | null): void;
}
// existing: copy(id) now also sets clipboardRun = [step]; paste(loc) inserts clipboardRun (verbatim, fresh IDs via cloneRunWithFreshIds) and returns the first new ID
createEditorStore(init: { doc; manifest; ctx?; readOnly?: boolean })

// agent-bridge.ts
export type BoundReads = { [K in ReadToolName]: (args: ReadArgs[K]) => ReadResults[K] };
export interface WorkflowAgentBridge {
  /** Reads against the store's current doc, taken at call time. */
  read: BoundReads;
  /** store.getState().apply(commands) — one undo step, flashes changed steps, rejects when read-only. */
  apply(commands: Command[]): ApplyResult;
  /** Catalog tool call: reads via core runTool on the current state; "apply" via store.apply. */
  runTool(name: string, args: unknown): ReturnType<typeof runTool>;
}
/** Plain (non-hook) bridge for agent loops that run outside React. A bridge keeps editing the store it was made for, so drop it when that store is replaced (see onStoreReady). */
export function createAgentBridge(store: EditorStore): WorkflowAgentBridge;
/** Hook form; `store` defaults to the enclosing editor's (useEditorStoreApi()). Memoized per store. */
export function useWorkflowAgentBridge(store?: EditorStore): WorkflowAgentBridge;
// WorkflowEditor props
/** Called for every store the editor creates (first load, workflowId change, retry, startNew). The returned cleanup runs when that store is replaced or the editor unmounts. */
onStoreReady?(store: EditorStore): void | (() => void);
```

Read-only as the single source of truth:
- `WorkflowCanvas`'s `readOnly` prop runs `useEffect(() => { const prev = s.readOnly; s.setReadOnly(true); return () => s.setReadOnly(prev) }, [readOnly])` when it is true.
- Canvas UI and keyboard code use `useEditorStore(s => s.readOnly)`.
- The run viewer creates its store with `readOnly: true`.

**Tests must pin**
- `editor-store.test.ts` is still unchanged and green.
- Each `apply` is one undo step: a three-command batch, then `undo()`, gives back the pre-batch doc (`toBe`); `redo()` gives the batch result.
- A failed `apply` (Review Focus 2) leaves `doc`, history, `canUndo` and `flash` unchanged.
- Remapping (S4):
  - A bridge `renameStepId` of the selected step moves `selection` and its samples to the new ID.
  - `setType` with regeneration does the same.
  - `wrapSteps` of the selected step keeps the selection.
  - `removeSteps` of the selected step clears it.
- Range:
  - `selectRange` in one list sets it; across lists it returns false.
  - Deleting a member prunes or clears `range`.
  - `moveBy` of an interior section member keeps the section (Review Focus 1).
  - Undo restores sections removed together with a range.
- Clipboard: `copyRange` + `paste` inserts the run with fresh IDs and remapped internal refs; `clipboard` equals the first step.
- `readOnly: true`:
  - every doc action throws `FlowlineCommandError` with `error.code === "readOnly"`
  - `apply` returns `{ ok: false, error: { code: "readOnly", index: 0, path: "" } }`
  - `<WorkflowCanvas readOnly>` sets the flag and restores it on unmount
  - the run viewer's store is read-only
- Bridge:
  - `createAgentBridge(store).read.overview({})` reflects the doc after a store change, with no re-render.
  - `bridge.apply(...)` changes the doc, sets `flash.ids`, and adds one undo step.
  - `runTool("apply", { commands })` goes through `store.apply`: history grows, and a read-only store gives `readOnly`.
  - `runTool("overview", {})` returns the live outline.
- `onStoreReady` fires on first load and again after `retry()` and after a `workflowId` change, and the previous cleanup runs before the next call.

- [ ] **Step 1:** Write the failing tests. **Step 2:** Implement the state and actions, the read-only source of truth, the bridge and the store lifecycle callback. Export `createAgentBridge`, `useWorkflowAgentBridge`, `WorkflowAgentBridge` and `BoundReads`. **Step 3:** Gates. Commit `feat(react): apply action, range and annotation store actions, agent bridge`.

---

### Task 11: react — layout reserves space for sections and notes; loop routing

This task can run alongside Tasks 2–10. It touches only `packages/react/src/layout/*`, `canvas/geometry.ts`, and a few exports in `index.ts` (four constants and the `LayoutSection`/`LayoutNote` types), and it needs only Task 1's types. Keep every change additive, because Task 10 edits `workflow-canvas.tsx` at the same time.

**Files:**
- Modify: `packages/react/src/layout/constants.ts`, `packages/react/src/layout/layout-tree.ts`, `packages/react/src/canvas/geometry.ts`, `packages/react/src/index.ts` (export the new constants and the `LayoutSection`/`LayoutNote` types, with TSDoc)
- Test: `packages/react/src/layout/layout-tree.test.ts` (extend; the existing snapshot must not change), `canvas/geometry.test.ts` (extend, or create if absent)

**Interfaces**

Consumes: `Section`, `sectionRun`, `isAnnotationColor` (Task 1).

Produces:
```ts
// constants.ts
export const NOTE_W = 180;          // sticky note width
export const NOTE_GAP = 12;         // gap between a card and its note
export const SECTION_PAD = 16;      // padding inside a section region (sides and bottom)
export const SECTION_HEADER_H = 32; // header band above a section's first member
// layout-tree.ts
export interface LayoutSection { id: string /* "section:<id>" */; sectionId: string; color: AnnotationColor /* unknown → "gray" */; x: number; y: number; w: number; h: number; depth: number }
export interface LayoutNote { id: string /* "note:<stepId>" */; stepId: string; x: number; y: number; w: number; h: number }
export function layoutTree(doc, manifest): { nodes: LayoutNode[]; edges: LayoutEdge[]; sections: LayoutSection[]; notes: LayoutNote[]; width: number; height: number };
// geometry.ts
export interface CanvasRect { x: number; y: number; w: number; h: number }
export function edgeGeometries(nodes, edges, gutter, obstacles?: readonly CanvasRect[]): Map<string, EdgeGeometry>;   // return type unchanged; obstacles default []
```

Layout rules:
- **Extents.** Sizes become extents around the column centre: `{ l, r, h }`.
  - A card has `l = r = CARD_W / 2`.
  - A card with a note has `r = CARD_W / 2 + NOTE_GAP + NOTE_W`.
  - A column's extents are the maximum `l` and `r` of its items, plus `SECTION_PAD` for items inside a section of that column.
  - Branch columns are placed left to right by their `l + r` widths, with `BRANCH_GAP` between them.
  - A block's extents are `max(card extent, inner span / 2 (+ LOOP_GUTTER for loops))` on each side, so a note never covers a neighbouring column.
- **Vertical space.**
  - In a list, the first member of a section starts `SECTION_HEADER_H` lower.
  - After the last member, the next item starts `SECTION_PAD` lower.
  - Broken sections (`sectionRun` undefined) reserve nothing and produce no `LayoutSection`; their Fix lives in the issues pill (Task 14).
  - A section with a valid run and an unknown colour produces a region with `color: "gray"`.
- **Section rect.**
  - Left: the column centre minus the members' max `l` minus `SECTION_PAD`.
  - Right: the centre plus the max `r` plus `SECTION_PAD`.
  - Top: the first member's top minus `SECTION_HEADER_H`.
  - Bottom: the bottom of the last member's item (its join node, for a block) plus `SECTION_PAD`.
  - `depth` is the list depth, used for the z-order of nested regions.
- **Note rect:** `x = card.x + CARD_W + NOTE_GAP`, `y = card.y`, `w = NOTE_W`, `h = CARD_H`.
- **Width.** `width` = `2 * max(l, r)` of the root column, so `fitViewport` stays centred on the trigger.
- **Separate arrays.** `nodes` and `edges` keep their existing IDs and order. Notes and sections are **not** in `nodes`, because keyboard tree order and edge geometry read `nodes`.
- **Loop routing.** The `loopReturn` route's x is left of the leftmost obstacle between the loop card and its join.

**Tests must pin**
- A doc without annotations produces exactly the old `nodes`, `edges`, `width` and `height`, with the existing snapshot unchanged, and empty `sections`/`notes`.
- A note on a step in the left column of a two-branch condition: the right column's leftmost card `x` is ≥ the note's `x + w + BRANCH_GAP`.
- A note on a top-level step: `width === 2 * (CARD_W / 2 + NOTE_GAP + NOTE_W)`, and the trigger is still centred at `x = -CARD_W / 2`.
- A section around two top-level steps:
  - The region contains both cards, with `SECTION_PAD` on the sides and the header band above.
  - The first member is pushed down by `SECTION_HEADER_H`, and the step after the section by `SECTION_PAD`.
- A section inside an `else` branch stays within the `else` column's extents and does not overlap the `if` column.
- Nesting: a section in a branch of a step that is itself in an outer section gives an inner rect inside the outer rect, with inner `depth` > outer `depth`.
- A section whose member is a condition block has its rect bottom below the block's join node.
- Colours and broken sections: a broken section gives no region and no throw; `color: "red"` on a valid run gives a region with `color: "gray"` (Review Focus 3).
- Geometry: a loop whose body contains a section gets a `loopReturn` path whose x is left of the section rect. Without obstacles, the output is unchanged.
- Determinism on the annotated fixture: sections in a branch, notes, and a loop with a section. Laying it out twice gives deep-equal results. The existing `layout-tree.test.ts:231` test covers plain docs.

- [ ] **Step 1:** Failing tests. **Step 2:** Refactor sizes to extents, keeping the existing outputs byte-identical. Then add sections, notes and the geometry obstacles. **Step 3:** Run `pnpm vitest run --project react packages/react/src/layout packages/react/src/canvas/geometry.test.ts`, then the gates. Commit `feat(react): layout reserves space for sections and notes`.

---

### Task 12: react — canvas rendering, palette, read-only, accessibility

**Files:**
- Create: `packages/react/src/canvas/section-node.tsx`, `canvas/note-node.tsx`
- Modify:
  - `canvas/workflow-canvas.tsx`: node types `section`, `sectionHeader` and `note`; flow nodes from `layout.sections`/`layout.notes`; pass section rects to `edgeGeometries`
  - `canvas/step-card.tsx`: `data-color`, `data-flash`, and the note in `ariaLabel`
  - `labels.ts`, `theme.ts`, `styles.css`
  - `playground/fixtures.ts`, `playground/main.tsx`, `playground/screenshot.mjs`
- Test: `packages/react/src/canvas/annotations.test.tsx` (new), `packages/react/src/theme.test.ts` (new: token contrast and CSS rules), `labels.test.ts` (extend)
- Docs: `packages/react/README.md` "Theming" (the annotation tokens)

**Interfaces**

Consumes: Task 11's layout and `edgeGeometries` obstacles; Task 10's `flash` and `readOnly`.

Produces:
```ts
// theme.ts
export type AnnotationToken = `annot${"Yellow" | "Blue" | "Green" | "Pink" | "Purple" | "Gray"}${"Bg" | "Border" | "Text"}`;
export type ThemeToken = /* existing */ | AnnotationToken;     // tokenVar("annotYellowBg") === "--fl-annot-yellow-bg"
// labels.ts (new keys)
colorNames: Record<AnnotationColor, string>;         // "Yellow", …
sectionRegion(title: string): string;                // aria-label of the region
sectionHeader(title: string, note?: string): string; // chip accessible name
noteLabel(text: string): string;                     // "Note: …"
stepWithNote(name: string, note: string): string;    // "<name>. Note: <first 120 chars>"
// section-node.tsx / note-node.tsx
export function SectionRegion(props: NodeProps<Node<{ sectionId: string; color: AnnotationColor }, "section">>): JSX.Element;
export function SectionHeader(props: NodeProps<Node<{ sectionId: string; color: AnnotationColor }, "sectionHeader">>): JSX.Element;
export function NoteCard(props: NodeProps<Node<{ stepId: string }, "note">>): JSX.Element;
```

What gets rendered:
- **Section region:** the xyflow node `section:<id>`.
  - It has `zIndex: -1` and is neither selectable nor focusable.
  - `role="group"`, `aria-label={labels.sectionRegion(title)}`.
  - Background `var(--fl-annot-<c>-bg)`, a 1.5px border `var(--fl-annot-<c>-border)`, radius `calc(var(--fl-radius) * 1.5)`.
  - If the Step 3 screenshots show edges hidden by the region, move the regions into a `<ViewportPortal>` layer below the edges instead of using `zIndex: -1`.
- **Header chip:** a separate focusable node, `sectionHeader:<id>`.
  - It sits at the region's top-left (`x + SECTION_PAD`, `y + 6`). It is left-aligned so it never sits under the centred "+" of the edge above.
  - It is a button showing a colour swatch and the title, in text colour `--fl-annot-<c>-text`.
  - When the section has a note, the chip also shows a one-line excerpt of it (60 chars, muted), with the full text in `title`.
- **Note:** the xyflow node `note:<stepId>`.
  - It is focusable, with `aria-label={labels.noteLabel(note)}`.
  - Background `--fl-annot-<step color ?? yellow>-bg`.
  - It shows the first ~3 lines (`-webkit-line-clamp: 3`), with the full text in `title`.
  - This task renders it only; editing is Task 14.
- **Step card:**
  - `data-color={color}` draws a 3px left accent in `--fl-annot-<c>-border`.
  - The flow node's `ariaLabel` becomes `labels.stepWithNote(name, note)` when the step has a note.
  - `data-flash` is set while `flash.token` is new and the step ID is in `flash.ids`, and cleared on `animationend`.
- **Unknown colours** are treated as `gray` everywhere.
- **Read-only** (store `readOnly`, including the run viewer):
  - `.fl-canvas[data-readonly] .fl-section, .fl-note { opacity: 0.72 }`.
  - The header chip and note are not buttons: no menu, no editing. They are still in the accessibility tree.
- **CSS:**
  - 18 tokens (`--fl-annot-<c>-{bg,border,text}`) in the light `.fl-root` block, and identically in both dark blocks.
  - `--fl-changed` is a derived `color-mix` token, and is exempt from the light/dark rule (Global Constraints). It inherits `--fl-accent`'s light and dark values, so it is declared once.
  - `--fl-changed: color-mix(in srgb, var(--fl-accent) 45%, transparent)` in the derived block.
  - `@keyframes fl-flash`: a box-shadow ring of `--fl-changed`, 900ms, applied via `.fl-card[data-flash]`. `@media (prefers-reduced-motion: reduce) { .fl-card[data-flash] { animation: none } }`.
- **Playground:**
  - The fixture `?fixture=annotations` has two sections (one of them in a branch, one with a note), three notes and two coloured cards.
  - `screenshot.mjs` shoots it in the `light` and `dark` colour schemes, to `annotations-light.png` and `annotations-dark.png`.

**Tests must pin**
- `theme.test.ts`:
  - It parses `styles.css`. For each of the 6 colours, in light and dark, the contrast of `-text` on `-bg` and of `--fl-text` on `-bg` is ≥ 4.5 (WCAG AA).
  - The two dark blocks declare identical annotation values.
  - `styles.css` contains a `prefers-reduced-motion: reduce` rule that sets `animation: none` for `[data-flash]`.
  - `tokenVar("annotPurpleBorder") === "--fl-annot-purple-border"`, and `themeStyle({ annotYellowBg: "#fff" })` sets the variable.
- `annotations.test.tsx`:
  - A doc with a section renders a `role="group"` named by the title.
  - The header chip is focusable, has the title, and shows a note excerpt when there is one.
  - A step note renders a node named "Note: …", and the step's accessible name includes the note.
  - `color: "pink"` sets `data-color="pink"` on the card.
  - A `color: "red"` section renders a region with `data-color="gray"`.
  - A read-only canvas renders the annotations with `data-readonly`, and there are no buttons in the chip or note.
- A bridge `apply` sets `data-flash` on the changed cards only.
- The existing `canvas.test.tsx` passes unchanged.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement the tokens, labels, nodes and card attributes, and pass obstacles into `edgeGeometries`. **Step 3:** Add the playground fixture, run `node packages/react/playground/screenshot.mjs /tmp/fl-shots`, and inspect `annotations-light.png` and `annotations-dark.png`: edges must be visible over regions, notes must not overlap columns, and text must be legible. **Step 4:** Write the README tokens paragraph, then run the gates including e2e. Commit `feat(react): draw sections, notes and step colours on the canvas`.

---

### Task 13: react — range selection, RangeBar and range keys

**Files:**
- Create: `packages/react/src/canvas/range-bar.tsx`
- Modify: `canvas/workflow-canvas.tsx` (shift-click), `canvas/canvas-context.ts` (`renamingSection`), `canvas/actions.ts` (`rangeActions`), `canvas/keyboard.ts` (⇧↑/⇧↓, ⌥↑/⌥↓, ⌘G, ⌘D/⌘C on a range, Esc clears the range), `canvas/step-card.tsx` (`data-in-range`), `canvas/context-menu.tsx` (range menu), `labels.ts`, `styles.css`
- Test: `packages/react/src/canvas/range.test.tsx` (new), `labels.test.ts`

**Interfaces**

Consumes: Task 10's `selectRange`, `clearRange`, `copyRange`, `duplicateRange`, `removeRange`, `moveBy` and `addSection`.

Produces:
```ts
// actions.ts
export interface RangeActions { group(): void; remove(): void; copy(): void; duplicate(): void; moveUp(): void; moveDown(): void; clear(): void }
/** undefined only without a range. In read-only mode group/remove/duplicate/moveUp/moveDown are no-ops; copy and clear work. */
export function rangeActions(store: EditorStore, ui: CanvasUiStore, root: () => HTMLElement | null): RangeActions | undefined;
// canvas-context.ts UI state
renamingSection: string | null;   // set by group(); Task 14 renders the input
// labels.ts (new keys)
groupIntoSection: string; defaultSectionTitle: string;    // "Section"
rangeSelected(n: number): string;       // "3 steps selected"
rangeOtherList: string;                 // "A range must stay in one branch. Shift-click a step in the same list."
stepsDeleted(n: number): string; moveUp: string; moveDown: string; clearRange: string;
```

Behaviour:
- **Selecting a range:**
  - Shift-click on a step, when there is a selection or range in the same list, calls `selectRange(anchor, clicked)`.
  - Shift-click in a different list is refused: the existing selection is kept and the toast `labels.rangeOtherList` appears.
  - ⇧↑/⇧↓ extend the range from the focused card within its list.
  - A plain click or Esc clears the range.
- **With a range:**
  - Cards in it get `data-in-range`.
  - The `RangeBar` is an xyflow `<Panel position="top-center">` with `role="toolbar"` and `aria-label={labels.rangeSelected(n)}`. It offers Group (⌘G), Duplicate (⌘D), Copy (⌘C), Move up (⌥↑), Move down (⌥↓), Delete and Clear. Delete from the toolbar button works here; Delete/Backspace from the keyboard is Task 15.
  - Right-clicking a range card shows the same items.
- **Group:**
  - It calls `addSection(first, last, { title: labels.defaultSectionTitle, color: "blue" })` and sets `renamingSection` to the new ID.
  - ⌘G on a single focused or selected step groups that step.
  - Grouping over an existing section in the same list surfaces the command's `section.overlap` message as a toast.
- **Move:** ⌥↑/⌥↓ on a single focused step calls `moveBy(id, id, ±1)`; at an edge nothing happens. Focus follows the moved card.
- **Read-only:** range selection still works, but the RangeBar shows only Copy and Clear.

**Tests must pin**
- Shift-click in the same list selects the run: the cards get `data-in-range` and the bar shows "3 steps selected". Shift-click into another branch is refused with the hint and leaves the range unchanged.
- ⇧↓ twice from a focused card selects three steps; Esc clears them.
- ⌘G on a range creates a section titled "Section" and sets `renamingSection`. ⌘G overlapping an existing section shows a toast and changes nothing.
- Range Duplicate, Copy + Paste, Move up and Move down produce the expected docs, and each is one undo step.
- ⌥↑ on an interior section member keeps it in the section (Review Focus 1). Assert both ways: `sectionRun(store.getState().doc, s).ids` contains the moved ID, and the rendered region's rect (from `layoutTree`) contains the moved card's rect.
- Read-only: with a range, the RangeBar shows only Copy and Clear, and `rangeActions(...).remove()` leaves the doc unchanged.
- Label override: rendering with `labels={{ groupIntoSection: "Grouper" }}` shows "Grouper".

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Gates including e2e. Commit `feat(react): range selection, range toolbar and move keys`.

---

### Task 14: react — annotation menus, note editing, Fix actions

**Files:**
- Modify:
  - `canvas/context-menu.tsx`: the step menu gains Add note / Edit note / Remove note and a Color submenu
  - `canvas/section-node.tsx`: header menu, inline title input, Fix item
  - `canvas/note-node.tsx`: click-to-edit textarea, Shorten
  - `canvas/actions.ts`: `sectionActions`, `noteActions`
  - `canvas/canvas-context.ts`: `editingNote`
  - `editor/issues-pill.tsx`: Fix for annotation issues
  - `labels.ts`, `styles.css`
- Test: `packages/react/src/canvas/annotation-menus.test.tsx` (new), `editor/issues-pill.test.tsx` (extend, or create if absent), `labels.test.ts`

**Interfaces**

Consumes: Task 10's `addSection`, `updateSection`, `removeSection`, `setNote`, `setColor` and `apply`; Task 13's `renamingSection`; core `annotationRepairs` and `NOTE_MAX_CHARS`.

Produces:
```ts
// actions.ts
export interface SectionActions { rename(): void; setColor(c: AnnotationColor): void; editNote(): void; ungroup(): void; repair(): void }
export function sectionActions(store: EditorStore, ui: CanvasUiStore, root: () => HTMLElement | null, sectionId: string): SectionActions;
export interface NoteActions { edit(): void; remove(): void; shorten(): void }
export function noteActions(store: EditorStore, ui: CanvasUiStore, root: () => HTMLElement | null, stepId: string): NoteActions;
/** Applies annotationRepairs(doc, issue) as one undo step; returns false when there is no repair. */
export function repairIssue(store: EditorStore, issue: Issue): boolean;
// canvas-context.ts UI state
editingNote: string | null;             // step ID or "section:<id>"
// labels.ts (new keys)
ungroup: string; renameSection: string; sectionNote: string; color: string; noColor: string;
addNote: string; editNote: string; removeNote: string; sectionDeleted(title: string): string; noteDeleted: string;
fixIssue: string; shortenNote: string; sectionMenu(title: string): string;
```

Behaviour:
- **Step menus:** the "…" menu and the right-click menu gain **Add note**, or **Edit note** + **Remove note** when the step has one. They also gain **Color**: a submenu of the six colours, each a swatch plus `labels.colorNames[c]`, then **No color**.
- **Header chip:**
  - A click or Enter opens its menu:
    - **Rename**: an inline title input. Enter saves, Esc keeps the old title, and blur saves.
    - **Color**
    - **Note**: edits the section note in the same textarea component.
    - **Ungroup**: `removeSection`, with the toast `sectionDeleted` and Undo.
  - When `renamingSection` equals the section's ID, the title input opens immediately (after ⌘G).
  - When the section has a `section.*` issue, the chip shows a warning badge and a **Fix** item (`repairIssue`).
- **Issues pill (M7):** an issue with code `section.broken`, `section.overlap` or `note.tooLong` shows a **Fix** button next to it, calling `repairIssue`. This is the only way to fix a broken section, which has no region.
- **Note editing:**
  - Clicking the note, or choosing Add/Edit note, opens an inline `<textarea>` in the note node: autofocused, with `maxLength={NOTE_MAX_CHARS}`.
  - ⌘Enter or blur saves via `setNote`, coalesced. Esc cancels. Saving empty text removes the note.
  - A note with `note.tooLong` shows a **Shorten** action, which cuts it to 4000 chars.
- **Read-only:** none of these menus or editors appear.

**Tests must pin**
- The Color submenu sets `color` on a step and on a section; **No color** removes the step colour.
- Notes: Add note opens the textarea; typing then blurring saves; empty text plus blur removes the note; Esc cancels.
- Title editing: after ⌘G, the title input is focused. Typing "Owner loop" and pressing Enter saves it; Esc keeps "Section".
- Ungroup removes the section and keeps the steps, and the toast's Undo restores it.
- Fix, one test per case (Review Focus 3):
  - the issues pill's Fix on a broken section (missing `first`) shrinks it
  - the pill's Fix on a section with a missing `first` **and** `last` removes it
  - the chip's Fix on a `"red"` section sets it to gray
  - **Shorten** on a 5000-char note clears `note.tooLong`

  After each, the issue is gone and one undo step restores the prior doc.
- Label override: every new string comes from labels; rendering with `labels={{ ungroup: "Dégrouper" }}` shows it.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Gates including e2e. Commit `feat(react): annotation menus, note editing and one-click repairs`.

---

### Task 15: react — Backspace/Delete from the canvas, the panel and annotations

**Files:**
- Create: `packages/react/src/canvas/delete-key.ts`
- Modify:
  - `canvas/keyboard.ts`: `ownsKey` no longer blocks Delete/Backspace on the card "…" trigger and the "+" insert buttons. Toast buttons and menus keep `ownsKey`. Also range delete.
  - `canvas/workflow-canvas.tsx`: register the editor-scope handler
  - `editor/workflow-editor.tsx`: `EditorBody` provides its body element through `DeleteScopeContext`
  - `canvas/section-node.tsx`, `canvas/note-node.tsx`: Delete/Backspace on a focused chip or note
- Test: `packages/react/src/editor/delete-key.test.tsx` (new), `canvas/keyboard.test.ts` or `canvas/canvas.test.tsx` (add one new `describe` for the deliberate change; existing cases unchanged)

**Interfaces**

Consumes: `isEditableTarget`, `stepActions().remove`, `rangeActions().remove`, `sectionActions().ungroup`, `noteActions().remove`, and the store's `readOnly`.

Produces:
```ts
// delete-key.ts
/** What a Delete/Backspace keydown should delete, or null when the key belongs to a text control or nothing applies. */
export function deleteTarget(
  e: { key: string; target: EventTarget | null; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  state: { selection: string | null; range: { first: string; last: string } | null; readOnly: boolean },
): { kind: "step"; id: string } | { kind: "range"; first: string; last: string } | { kind: "section"; id: string } | { kind: "note"; stepId: string } | null;
/** Internal: the element (editor body) whose keydowns outside the canvas root the canvas also handles. */
export const DeleteScopeContext: React.Context<HTMLElement | null>;
```

Rules (spec §7), checked in this order:
1. Only Delete or Backspace with no modifiers count.
2. If `isEditableTarget(target)`, the key is not handled. That covers inputs, textareas, selects, contenteditable, CodeMirror, open menus/dialogs/listboxes and the step picker.
3. Focus on a section header chip deletes that section: `removeSection` + an Undo toast.
4. Focus on a note removes that note, with an Undo toast.
5. Otherwise, a range calls `removeRange`, with the toast `stepsDeleted(n)` + Undo.
6. Otherwise, a selected step (not the trigger) runs the existing `stepActions.remove()`: toast + Undo, and focus moves to the neighbour.

Where it applies:
- keydowns inside the canvas root
- keydowns inside the editor body but outside the canvas: the config panel header, tabs, buttons and other non-text controls
- keydowns whose target is `document.body`, when the last `pointerdown` in the document was inside this editor

**Deliberate change (S15), and its limits:**
- Backspace/Delete now deletes the selected step on exactly these: the card "…" menu trigger, the "+" insert buttons, and non-text controls in the editor body outside the canvas.
- Today `ownsKey` ignores Delete/Backspace on those buttons.
- Toast buttons, such as Undo, and open menus keep `ownsKey`, so Backspace there deletes nothing.
- Other plain keys on these buttons (Enter, Space) still belong to the button.
- In read-only mode, nothing is deleted.

**Tests must pin**
- **Step 1 reproduces the reported bug first.**
  - In `delete-key.test.tsx`, render `<WorkflowEditor>`, with the mock client as in `workflow-editor.test.tsx`.
  - Click the step card "Send email" with `userEvent`, then move focus to the panel: focus `.fl-cp__name-btn`, as the panel's autofocus does.
  - Press Backspace. The expected result is that the step is removed and the "Deleted “Send email”" toast appears.
  - On the current code this test FAILS. Keep it as the regression test.
- The matrix, one `it` per case (Review Focus 5):

  | Focus | Expected |
  |---|---|
  | canvas card | deletes |
  | panel name button | deletes |
  | panel tab button | deletes |
  | panel config text input | does **not** delete; the character is removed from the input |
  | panel name input (rename mode) | does not delete |
  | inline card rename input | does not delete |
  | CodeMirror editor | does not delete |
  | data-picker search | does not delete |
  | note textarea | does not delete |
  | section title input | does not delete |
  | section chip | deletes the section only |
  | note | deletes the note only |
  | panel, with a range selected | deletes the range |
  | trigger selected | nothing |
  | read-only editor | nothing |
  | `document.body`, after clicking in the editor | deletes |
  | `document.body`, after clicking outside the editor | nothing |
- The deliberate change, as a new `describe` in the canvas tests:
  - With a step selected, Backspace on its "…" trigger button deletes it, and so does Backspace on a "+" button.
  - Enter on "+" still opens the picker.
- Must stay green, unchanged: `canvas.test.tsx` "Backspace on the toast's Undo button doesn't delete the selected step" (line ~518).
- Exactly one deletion per keypress, with no double handling between the canvas root and the scope handler: after one Backspace, the undo history grows by exactly one.
- The existing canvas keyboard tests pass unchanged.

- [ ] **Step 1:** Write the reproduction test. Run `pnpm vitest run --project react packages/react/src/editor/delete-key.test.tsx`. Expected: FAIL (the step is not removed).
- [ ] **Step 2:** Write the rest of the matrix and the deliberate-change tests. They fail where expected.
- [ ] **Step 3:** Implement `deleteTarget` and the scope context and listener. Attach the listener to the scope element from `WorkflowCanvas` via an effect, and ignore events whose target is inside the canvas root, which the root handler already covers. Then add the chip and note handlers, and range delete in `handleCanvasKey`.
- [ ] **Step 4:** Gates including e2e. Commit `fix(react): Backspace and Delete delete the selection while the panel has focus`.

---

### Task 16: mini-crm — annotated seeded flow and e2e

**Files:**
- Modify: `examples/mini-crm/server/src/flows/deal-stuck.ts` (sections and notes), `examples/mini-crm/server/src/app.test.ts` (the seeded doc keeps its annotations through save, publish and load)
- Create: `examples/mini-crm/e2e/annotations.spec.ts`
- Modify: `examples/mini-crm/README.md` (the annotated demo)

**Interfaces**

Consumes: everything above. Produces a `dealStuckFlow` with:
```ts
sections: [
  { id: "check_deal", title: "Check the deal is still stuck", color: "blue", note: "Every side effect is preceded by a fresh load", first: "deal", last: "still_there" },
  { id: "escalate_block", title: "Escalate", color: "pink", first: "recheck", last: "escalate" },
]
// notes: nudge.note = "Owner, not assignee", wait.note = "1m in the demo, 1d in production"; escalate.color = "pink"
```
These IDs are the real top-level IDs of `deal-stuck.ts`, and both runs are contiguous top-level runs. `validateWorkflow` must report no `section.*` issue.

**Tests must pin**
- `app.test.ts`: after seeding, `GET /flowline/workflows/<DEAL_STUCK_WORKFLOW_ID>` returns the doc with both sections and both notes, and publishing it has no errors.
- `e2e/annotations.spec.ts`:
  1. "groups two steps into a section, colours it, adds a note, ungroups and deletes through the UI":
     1. Open the deal-stuck workflow. Click the `owner` card, shift-click `nudge` (both outside the seeded sections), and press ⌘G/Ctrl+G.
     2. Type "Owner loop" + Enter. Expect a group named "Owner loop".
     3. Open its chip menu → Color → Green. Expect the region's `data-color="green"`.
     4. Open `owner`'s "…" → Add note (`owner` has no seeded note), type "Check the owner", and click the canvas. Expect a note "Note: Check the owner".
     5. Chip menu → Ungroup. Expect no group "Owner loop".
     6. Select `wait`, click into the panel header, and press Backspace. Expect the step gone and the Undo toast. Click Undo and expect `wait` back, so the saved doc keeps every seeded step.
     7. Save (saving never publishes, so the published version `triggers.spec.ts` relies on is untouched), reload, and expect the note on `owner` to persist.
  2. "seeded sections and notes render in light and dark":
     1. Open the deal-stuck workflow and expect groups "Check the deal is still stuck" and "Escalate".
     2. Save `page.screenshot` to `test-results/annotations-light.png`.
     3. Emulate `colorScheme: "dark"` and save `annotations-dark.png`. These are artifacts for review, with no pixel comparison.

- [ ] **Step 1:** Write the failing server test and e2e spec. **Step 2:** Annotate the flow and update the README. **Step 3:** Gates including `pnpm --filter @flowlinejs/example-mini-crm e2e`. Commit `feat(mini-crm): annotated deal-stuck flow and annotation e2e`.

---

### Task 17: docs, agent scenario, changeset

**Files:**
- Create: `examples/mini-crm/server/src/agent-scenario.test.ts`
- Modify:
  - `README.md`: a new "Agents: reads, commands and the tool catalog" section after "Editor". "Editor" gains notes, sections, range selection, Backspace, `createAgentBridge`/`useWorkflowAgentBridge` and `onStoreReady`. Roadmap gains the MCP server and a copilot UI.
  - `packages/core/README.md`: reads, `apply`, catalog and `runTool` usage
  - `packages/react/README.md`: the bridge
  - `examples/docs-check/stubs/*`, if a snippet needs a stub
- Create: `.changeset/agent-commands-annotations.md`

**Interfaces**

Consumes: all public APIs, and `createCrmRegistry()` from `examples/mini-crm/server/src/app.ts` (Task 8), which supplies the manifest for the scenario.

**Precondition (check first):**
- 0.2.0 is versioned and released on `main`: `.changeset/triggers-conditions.md` no longer exists, and every package's `package.json` reads `0.2.0`.
- The controller has merged that release into the integration branch.
- If either is false, stop and report to the controller. With the precondition met, this task's changeset is the only pending one, and `changeset version` yields `0.3.0`.

Produces docs whose TypeScript blocks typecheck under `examples/docs-check`, and this changeset:
```md
---
"@flowlinejs/core": minor
"@flowlinejs/engine": minor
"@flowlinejs/nodes-builtin": minor
"@flowlinejs/react": minor
"@flowlinejs/storage-memory": minor
"@flowlinejs/storage-postgres": minor
---

Agent commands, reads and canvas annotations: step notes, colours and sections; budgeted reads
(`overview`, `outline`, `focus`, …); one atomic `apply(doc, commands, manifest)` with bulk commands;
`commandCatalog` and `runTool`; the editor runs on `apply`; `createAgentBridge`,
`useWorkflowAgentBridge` and `onStoreReady`; range selection, grouping and notes on the canvas;
Backspace/Delete work while the config panel has focus.

Notes for upgraders: `EditorActions` now throw `FlowlineCommandError`, a subclass of
`FlowlineTreeError`; `layoutTree` also returns `sections` and `notes`; Backspace on the canvas "…"
and "+" buttons deletes the selected step.
```

**Tests must pin**
- The agent scenario (success criterion 1). It starts from a blank manual-trigger doc, holds only `commandCatalog(manifest)` and `runTool`, and makes **at most 4** `runTool` calls:
  1. `describeNodeTypes` for the types it needs.
  2. One `apply` containing:
     - `setTrigger` (`crm.dealStuckInStage`, `{ stage: "proposal", days: 3 }`)
     - `renameWorkflow`
     - one `insertSteps` at `{ start: true }` that builds the whole flow of the 0.2.0 spec §7.5, with `ref`s used in `{{ steps.$deal… }}` templates and no `section`
     - `addSection` for `check_deal` over `deal..still_there`, with its note
     - `addSection` for `escalate_block` over `recheck..escalate`
     - two `setNote`s
  3. `getIssues`.

  Then:
  - The final doc has `errors === 0`.
  - The final doc structurally equals `dealStuckFlow`, comparing step IDs, types, configs, branch structure, trigger, sections and notes, with display names ignored (S13).
  - Every tool name used is in the catalog.
  - Every `apply` input parses with `commandSchema(manifest, { internal: false })`.
- `examples/docs-check` passes: every new block is annotated and typechecks. The core README snippet runs `apply` and `overview` on a small doc.
- The changeset lists all six packages as `minor`. `pnpm changeset status` reports exactly one pending changeset, releasing the group at `0.3.0`.

- [ ] **Step 1:** Write the agent scenario and run it. It should PASS against the finished code. If it needs more than four calls, fix the catalog or reads, not the test.
- [ ] **Step 2:** Write the docs. Run `pnpm vitest run --project docs-check`.
- [ ] **Step 3:** Add the changeset.
- [ ] **Step 4:** Full gates in order: `pnpm install`, `pnpm build`, `pnpm test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm --filter @flowlinejs/example-mini-crm e2e`, `pnpm test:scripts`. Commit `docs: agent commands, reads and canvas annotations; changeset for 0.3.0`.

---

## Done when

- Every Review Focus item has a green test naming it.
- The four spec success criteria hold:
  - The scripted agent builds `dealStuckFlow` in ≤ 4 calls with no errors (Task 17).
  - Bridge edits appear live, as one undo step each (Tasks 10 and 12).
  - Reads on 500 steps stay within budget, and their follow-ups return all hidden content (Tasks 2 and 3).
  - Docs from before 0.3.0 load and run unchanged (Task 1).
- `editor-store.test.ts` is byte-identical to its state at `4ca8b18`.
- The full gate sequence passes on `flowkit-v1`.
- 0.2.0 was already released, so `.changeset/` holds only Task 17's changeset, and `changeset version` bumps all six packages from `0.2.0` to `0.3.0`.
