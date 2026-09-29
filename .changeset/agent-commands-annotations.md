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
and "+" buttons deletes the selected step; Backspace/Delete on RangeBar buttons delete the range;
Backspace/Delete with Shift, Meta, Ctrl or Alt no longer delete (on Windows/Linux, Meta+Delete
used to), and key auto-repeat no longer deletes step after step; the built-in delay node's card
summary now reads "Wait 2d" or "Wait until …" instead of a broken template.
