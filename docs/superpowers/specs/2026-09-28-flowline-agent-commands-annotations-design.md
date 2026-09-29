# Agent commands, reads and canvas annotations: design

Status: approved in conversation on 2026-09-28. Written spec awaiting review.
Target release: `0.3.0`, after the triggers/conditions batch ships as `0.2.0`.

## 1. Intent

**What the user asked for**

- Long workflows are hard to read. Users need sticky notes, and coloured backgrounds and borders around sections. These are visual only and have no runtime effect.
- Backspace should delete.
- An AI agent should be able to inspect and edit a workflow the same way a human does, through **one shared command API** that the editor also uses. The first release covers commands, a tool catalog and a read side. An MCP server and a copilot UI come later.
- Agents need granular reads and an overview, so they don't get swamped. They also need bulk add, bulk edit and bulk restructure, so they don't have to call tools over and over.
- Annotations must not be separate from steps in ways that could confuse an agent.

**Success criteria**

1. A scripted agent that has only `commandCatalog(manifest)` and the read tools builds, annotates and validates the mini-crm "Deal stuck in stage" flow from scratch, in **≤ 4 tool calls in total**, and produces a document with no errors.
2. A human watching the editor sees agent edits appear live. Each `apply` batch is one undo step.
3. Reads on a 500-step workflow stay within their size budget, and each read says what it left out and how to fetch it.
4. Documents from before 0.3.0 load and run unchanged. 0.2.0 engines ignore the new fields.

**Out of scope**

- An MCP server package.
- An in-editor chat or copilot UI.
- Free-floating (coordinate-placed) annotations.
- Free-form hex colours.
- Save and publish as commands. Those stay the host's storage decisions.

## 2. Document model

All new fields are optional. Both the core validator and the engine ignore them at runtime.

```ts
// @flowlinejs/core
export type AnnotationColor = "yellow" | "blue" | "green" | "pink" | "purple" | "gray";

interface Step {
  // …existing fields
  /** Sticky note pinned to this step. Plain text, ≤ 4000 chars. */
  note?: string;
  /** Accent colour for the step card. */
  color?: AnnotationColor;
}

export interface Section {
  /** Stable ID, unique within the doc. Matches the step-ID pattern. */
  id: string;
  title: string;
  color: AnnotationColor;
  note?: string;
  /** First and last step of a contiguous run within one step list (the same parent and branch). */
  first: string;
  last: string;
}

interface WorkflowDoc {
  // …existing fields
  sections?: Section[];
}
```

**Why notes live on steps.** Step notes and colours move, copy, duplicate and delete with the step, with no extra bookkeeping. Only sections span several steps, so only sections need a top-level list. Commands address a section through its step IDs, as in `addSection({ first, last, … })`. A section's `id` is needed only for update and remove, and every read that shows a section shows its `id`.

**Section invariants**

- `first` and `last` are in the same step list, and `first` is at or before `last`.
- Two sections in the same list never overlap.
- A section inside a branch may sit inside a section of an enclosing list. That nesting is allowed.

The core tree operations (`removeStep`, `moveStep` and the bulk commands) keep sections intact automatically:
- Deleting `first` or `last` shrinks the section to the nearest remaining member.
- Deleting every member removes the section.
- Moving a member out of the run shrinks the section, or removes it if nothing is left.
- Moving the whole run moves the section with it.

**Validation issues**, all warnings:
- `section.broken`: a hand-edited doc whose `first`/`last` are missing or in different lists.
- `section.overlap`: two sections in the same list overlap.
- `note.tooLong`: a note over 4000 chars.

The editor offers to repair each of these.

## 3. Reads

Every read is a pure function in `@flowlinejs/core`. Each returns plain JSON and is also exposed as a tool in the catalog. Annotations are shown **inline** wherever steps appear.

| Read | Returns |
|---|---|
| `overview(doc, manifest, { budget? })` | Name, a trigger summary, then an indented outline of steps with one line per step: id, node label, name, issue count, and a truncated note. Sections appear as headers, with their member steps indented under them. Totals come last. |
| `outline(doc, manifest, { stepId, branch?, budget? })` | The same line format for one subtree or branch. |
| `focus(doc, manifest, stepId)` | Everything needed to edit one step: config, name, note, colour, containing section, compact input schema, `{{ }}` refs available at that point with their types, issues, and branch IDs. |
| `getSteps(doc, ids[], { include?: ("config" \| "schema" \| "refs")[] })` | Several steps at once. |
| `findSteps(doc, manifest, where)` | IDs and one-line summaries matching a selector (§4.3), so an agent can preview a bulk edit. |
| `availableRefs(doc, manifest, stepId, { path? })` | The `{{ }}` refs in scope, top level by default. `path` drills into nested objects. |
| `listNodeTypes(manifest, { query?, category? })` | ID, label and a one-line description. No schemas. |
| `describeNodeTypes(manifest, types[])` | Input schema, branches, output shape and custom operators, for each requested type. |
| `getIssues(doc, manifest, { stepId? })` | Validation issues, optionally for one step. |

**Budget discipline**

- `budget` is in characters. The default is 4000 for `overview` and `outline`.
- Under budget, `overview` includes each step's config inline, so a small workflow needs exactly one read.
- Over budget, content is dropped in this order:
  1. config values
  2. notes, down to 40 chars
  3. deep branches, collapsed to `… 12 steps in branch else: outline({stepId:"recheck",branch:"else"})`
- Each collapse marker includes the exact follow-up call.
- Strings longer than 500 chars in `focus`/`getSteps` are cut, with the marker `…(+1.2k chars)` and a `full: true` option.

Tool descriptions tell the agent to start with `overview`.

Example `overview` line format:
```
trigger  Deal stuck in stage (poll, every 10s)
▣ section check "Check the deal" [blue]: note "Skip if the deal already moved"
  getDeal        Get deal
  recheck        If  · 1 issue
    ├ then
    │  notifyOwner  Send email: note "Owner, not assignee"
    └ else
       stopMoved    Stop
delay_1m       Delay
```

## 4. Commands

### 4.1 Apply

```ts
export function apply(doc: WorkflowDoc, commands: Command[], manifest: Manifest): ApplyResult;
type ApplyResult =
  | { ok: true; doc: WorkflowDoc; ids: Record<string, string>; changed: string /* outline of the changed region */; issues: { added: Issue[]; cleared: Issue[] } }
  | { ok: false; error: { index: number; path: string; code: string; message: string; hint?: unknown /* schema fragment, valid refs or matched IDs */ } };
```

- **Atomic.** Any failure applies nothing.
- **References to new steps.** A command can refer to steps created earlier in the same batch by `$1`, `$2`, … (the result index of the command that created it) or by a fragment `ref` name (§4.2). This works both in step-ID arguments and inside `{{steps.$1.…}}` templates. `ids` maps every placeholder to the generated ID.
- **Results are self-describing.** They include the outline of the changed region and the issue delta, so the agent never needs to re-read after a successful batch.
- **Actionable errors.** Each error names the command index and a JSON path, such as `commands[2].steps[0].branches.else[0].type`, and carries a `hint`.

### 4.2 Command set

Every command is a discriminated union member, `{ op: "…", … }`.

**Single-step**
- `addStep`: `at` is one of `{ after }`, `{ before }`, `{ in: { stepId, branch }, index? }`, or `{ start: true }`.
- `moveStep`
- `removeStep`
- `duplicateStep`
- `renameStep` (display name)
- `renameStepId`: rewrites every `{{steps.<id>…}}` ref.
- `setConfig`: one key, or `config: {…}` to merge; `null` removes.
- `setDisabled`
- `setNote`
- `setColor`
- `setTrigger`
- `setTriggerConfig`
- `setOutput`
- `renameWorkflow`

**Bulk add**
- `insertSteps({ at, steps: Fragment[], section? })`.
  - A fragment step is `{ ref?, id?, type, name?, config?, note?, color?, disabled?, branches?: Record<string, Fragment[]> }`.
  - `ref` names a new step for later refs within the fragment and the batch.
  - The whole fragment is validated first: node types, config schemas, which branches each node allows, and whether each ref is reachable at its position.
  - `section: { title, color, note? }` wraps the inserted top-level run in a section.
- `duplicateSteps({ first, last, at? })`: fresh IDs; refs inside the copy are remapped to the copies.

**Bulk edit**
- `updateSteps`. Takes either:
  - a list: `{ updates: [{ id, set?: { name?, disabled?, note?, color? }, config?: Record<string, ValueExpr | null> }] }`, or
  - a selector: `{ where, set?, config?, expect }`.
- `replaceInConfig({ find, replace, where?, expect })`: string and template find/replace across config values.

**Bulk restructure**
- `moveSteps({ first, last, to })`: a contiguous run moves as a block, and any section covering it moves too.
- `removeSteps`: takes `{ ids }`, `{ first, last }` or `{ where, expect }`. Refs left dangling are reported in `issues.added`.
- `wrapSteps({ first, last, in: { type, branch, config? } })`: puts a run inside a new branching step.
- `unwrapStep({ id, keep: branchId })`: removes a branching step and lifts one of its branches into its place.
- `replaceSteps({ first, last, steps: Fragment[] })`

**Sections**
- `addSection({ first, last, title, color, note? })`
- `updateSection({ id, title?, color?, note? , first?, last? })`
- `removeSection({ id })`: the steps are kept.

### 4.3 Selectors and the `expect` guard

A `where` selector has the fields `{ type?, section?, within?: { stepId, branch? }, nameContains?, configHas?: string /* path */ }`. The fields are ANDed together.

Every selector-based command requires `expect: number`. If the matched count differs, the batch fails with `code: "expect.mismatch"`, and `hint` lists the matched IDs. This stops a vague selector from silently editing many steps.

### 4.4 Tool catalog

```ts
export function commandCatalog(manifest: Manifest, opts?: { include?: ("reads" | "commands")[] }): ToolDefinition[];
interface ToolDefinition { name: string; description: string; inputSchema: JSONSchema }
```

- There is one `apply` tool, whose input schema is the command union, plus one tool per read.
- Schemas are generated from the host manifest:
  - `type` fields are enums of the registered node types;
  - `branch` fields are enums where the node's branches are static;
  - trigger types are enums.
- Descriptions are written for models and include short examples.
- The output is plain JSON Schema, usable by any tool-calling model. It is snapshot-tested.

## 5. Editor integration

- **One code path.** `EditorActions` (`packages/react/src/store/editor-store.ts`) are re-implemented as `apply` calls. Human and agent edits share validation, `$ref` resolution, section upkeep and undo. Each `apply` is one undo step.
- **Host-facing agent hook.** It lets a host wire an agent into a mounted editor:
  ```ts
  useWorkflowAgentBridge(): {
    read: typeof reads,
    apply(commands: Command[]): ApplyResult,
  }
  ```
  - `apply` works on the live doc.
  - The canvas highlights changed steps briefly, using the existing change-highlight tokens.
  - A read-only editor rejects `apply` with `code: "readOnly"`.
- **Headless use.** On the server, a host calls `apply` from `@flowlinejs/core` directly against stored docs.

## 6. Canvas presentation

**Sections**
- Each section is drawn behind its member cards as a rounded, tinted region with a coloured border. The region is the bounding box of the members' layout rects plus padding.
- The layout reserves header space above the section's first member for a chip showing the title, a swatch and a note icon.
- A section inside a branch stays within that branch column.

**Notes**
- A note is a sticky card pinned to the right edge of its step, showing the first ~3 lines. Click it to edit.
- The layout reserves the note's width so notes never cover a neighbouring branch column.
- A section's note appears in its header.
- `color` tints the step card's accent, with or without a note.

**Palette**
- Six tokens, `--fl-annot-{yellow,blue,green,pink,purple,gray}`, each with light and dark background, border and text values that meet WCAG AA for text.
- The tokens can be overridden by host themes.

**Selection and editing**
- Shift-click selects a contiguous run within one list. A click in a different list is refused, and a hint explains why.
- On a range, the available actions are:
  - Group into section (⌘G)
  - Delete/Backspace
  - copy, duplicate and move
- A step's "…" menu adds **Add note** and **Color**.
- A section header's menu has **Rename**, **Color**, **Note** and **Ungroup**.
- All new copy goes in overridable `labels`.

**Read-only views.** The run viewer and read-only canvases show annotations slightly faded, and they cannot be edited.

**Accessibility**
- Section regions have `role="group"` with `aria-label` set to the title.
- Notes are reachable by keyboard, and are announced as "Note: …" on their step.
- Colour is never the only carrier of meaning, because the title and note text are always present.

## 7. Backspace and Delete

**The gap today.** `handleCanvasKey` (`packages/react/src/canvas/keyboard.ts`) only receives keys while focus is inside the canvas root. Clicking a step opens its config panel and moves focus there, so Backspace does nothing.

**The fix**
- While a step or range is selected and focus is not in a text-editing control (`isEditableTarget`), Delete/Backspace deletes the selection with the existing undo toast. This includes focus on the panel header or on non-text panel controls.
- When a section header or note is focused, the keys delete that annotation instead.
- The exact case the user reported is reproduced first and pinned in a test.

## 8. Testing

**Core**
- Every command is table-tested for:
  - normal cases
  - `$n`/`ref` resolution, including inside templates
  - an atomic failure leaving the doc identical
  - `expect` mismatches
  - fragment validation paths
  - section upkeep under delete, move, duplicate, wrap, unwrap and replace
- Reads are tested for budget compliance at 5, 50 and 500 steps. The tests assert that collapse markers carry follow-ups which, when executed, return the hidden content.
- `commandCatalog` has a snapshot test against the mini-crm manifest.

**Agent scenario.** A scripted test drives only catalog tools to build the "Deal stuck in stage" flow, with a section and notes. It asserts ≤ 4 calls and a document with no errors.

**React**
- The existing store, canvas and keyboard suites pass unchanged after actions move onto `apply`.
- New tests cover:
  - section and note rendering
  - range selection rules
  - Group, Ungroup, Color and Note
  - the Backspace/Delete matrix: canvas focus, panel focus, text-field focus, and annotation focus
  - the bridge hook, including read-only rejection
- Light and dark screenshots.

**Mini-crm**
- One seeded flow gains sections and notes.
- An e2e test covers grouping, colouring, adding a note, ungrouping and deleting through the UI.

## 9. Compatibility and release

- `note`, `color` and `sections` are optional. Older docs load unchanged.
- The engine ignores the new fields, and a 0.2.0 engine running a 0.3.0 doc behaves identically.
- A changeset with a `minor` bump goes in with the final task of the batch, following ruling 87's pattern.

## 10. Decisions recorded from the implementation plan

The plan (`docs/superpowers/plans/2026-09-28-flowline-agent-commands-annotations.md`) closes these gaps. They are binding alongside §§1–9.

- **`setType { id, type }`** is added to the single-step commands (§4.2). It is the editor's Replace: config resets, children are kept, and generated IDs are regenerated. Without it, `EditorActions.replaceStep` would have no command, and §5's "one code path" would be impossible.
- **`setTrigger`**:
  - Same type with no config: a no-op.
  - Same type with `config`: merges it.
  - Different type: resets to the defaults, then merges.
- **Placeholders** are 1-based: `$n` is the result of `commands[n-1]`. A fragment `ref` is addressed as `$<ref>`. Section-ID arguments accept placeholders too.
- **`null` in `setConfig`** removes a key. An internal `nullIsValue` flag stores a literal `null`; it is left out of the catalog.
- **Internal command fields.** `insertSteps { verbatim: true }` is internal, used by paste. It inserts steps as given (no default config merged, undeclared branches kept) and only reports issues.
- **Rejection rules.** `apply` rejects structural problems. For non-verbatim fragments, it also rejects the validation codes `node.unknown`, `branch.unknown`, `config.invalid`, `ref.*`, `step.invalidId` and `step.duplicateId`. Missing required fields and warnings are reported, not rejected. `setConfig` never rejects a value.
- **Trusted mode.** `apply` accepts `{ trusted, report }` options, so the editor can skip the shape parse and the report on every keystroke.
- **`ApplyResult` additions**, all additive:
  - `renamed` (old → new step IDs)
  - `issues.more`: `added` is capped at 20, with a `getIssues` follow-up
  - `more` on failure: further shape errors, up to 9
  - The `command.invalid` hint is the compact schema at the failing path, at most 1500 chars.
- **Reads** are all `(doc, manifest, args, opts?)`, where `args` is exactly the tool input. This changes `getSteps`, which needs the manifest. Additions:
  - `outline` takes an optional `stepId` and `after` for paging.
  - `getSteps` also takes `{ where, after?, limit? }`, and returns `next`.
  - `budget` covers the whole result: `text` plus the serialized `omitted`.
  - The notes follow-up uses `full: true`.
- **Host glue:**
  - `runTool(state, name, args)` in core.
  - `createAgentBridge(store)` and `useWorkflowAgentBridge(store?)` in React. Bridge reads are bound to the live store, and bridge `apply` goes through the store.
  - `<WorkflowEditor onStoreReady>` fires for every store the editor creates, and its cleanup runs when that store is replaced.
- **Read-only.** The editor store's `readOnly` flag is the single source of truth for read-only mode, and `<WorkflowCanvas readOnly>` sets it.
- **Errors.** `FlowlineCommandError` extends `FlowlineTreeError`.
- **Section upkeep:** a moved member stays in its section when it lands within the section's span, so ⌥↑ on an interior member keeps it.
- **Canvas:**
  - A section with an unknown colour draws as gray. Broken sections have no region, and are repaired from the issues pill's Fix.
  - The section header chip shows a one-line excerpt of the section note (60 chars), with the full note as a tooltip.
  - `--fl-changed` and `fl-flash` are new; no change-highlight token existed before.
  - Ranges and steps move with Move up/Move down (⌥↑/⌥↓).
- **Clipboard.** `EditorState.clipboard` stays `Step | null`, and a new `clipboardRun` holds a copied run.
- **Branch enums in the catalog** (§4.4) apply only when no node in the manifest has `fromConfig` branches. Otherwise `branch` fields are free text. Shared enums sit once under `$defs`.
- **Backspace/Delete** on the canvas's "…" and "+" buttons deletes the selected step. This is a deliberate change.
- **Duplicate and invalid section IDs.** When two sections share an ID, `updateSection` and `removeSection` act on the later one. Fix works like this:
  - A duplicate ID: remove the later copy, then re-add it with the same run, title, colour and note under a fresh ID from `sectionIdFor`.
  - An invalid ID: the same, on that section.
  - A section whose `first`/`last` are in different branches: shrink it to its first step.
- **The §3 example is illustrative** in its spacing (padding widths, spaces before `·`). The exact bytes come from the formatting rules, pinned by a snapshot test. What must match is each line's content, with whitespace collapsed, in order.
- **Budget floor.** An `overview`/`outline` result never exceeds `budget` once `budget` is at least the floor: header + totals + one tail marker, with its omission. Below the floor, the result is exactly the floor. Any note that is cut, even at the default 120 chars, is listed in `omitted`, with a `full: true` follow-up.
- **Strict command schemas.** Unknown keys in a command fail with `command.invalid`, and the error names the key.
- **`runTool("apply")`** checks only the `{ commands: [...] }` envelope. Command errors come back inside the `ApplyResult`, with hints.
- **Duplicate names** follow the editor's `(copy)`, `(copy 2)`… sequence, through core's `copyName`.
