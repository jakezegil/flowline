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
Backspace/Delete work while the config panel has focus. Model input through `runTool` and the
bridge is capped by the new `AGENT_LIMITS` export: 1000 commands per call, 64-char new IDs,
200-char names and titles, and 1000-item lists.

Notes for upgraders: `EditorActions` now throw `FlowlineCommandError`, a subclass of
`FlowlineTreeError`; `layoutTree` also returns `sections` and `notes`; Backspace on a card's "…"
button deletes that step, and on a "+" button the selected step; Backspace/Delete on RangeBar
buttons delete the range; Backspace/Delete with Shift, Meta, Ctrl or Alt no longer delete (on
Windows/Linux, Meta+Delete used to), and key auto-repeat no longer deletes step after step; the
built-in delay node's card summary now reads "Wait 2d" or "Wait until …" instead of a broken
template; `IssueCode` gains `section.broken`, `section.overlap` and `note.tooLong` (all warnings),
so exhaustive `switch` statements over it need new cases; a `where.type` naming an unknown node
type is now an error (`node.unknown` from `apply`, `command.invalid` from reads) instead of
silently matching nothing.
