# Canvas UX research (2026-09-27)

Research into best-in-class workflow-builder UX to inform `@flowkit/react`. Closest analogue: **Activepieces** (React + @xyflow/react + tree model). Use it for *patterns*, do not copy code (parts of its repo are commercially licensed).

## Layout & structure
- **Custom recursive tree layout, not dagre/elk.** Activepieces builds a sub-graph per step/router/loop, offsets and merges them, with fixed constants (card 232×60, vertical gap 60, horizontal branch gap 80, extra vertical offsets for loops/routers). Dedicated edge types: router-start, router-end (rejoin), loop-start, loop-return. "+" buttons are rendered *on edges*; an empty branch renders a big "add" placeholder node.
- React Flow docs: dagre can't lay out sub-flows well, d3-hierarchy needs uniform sizes, elk is heavy (https://reactflow.dev/learn/layouting/layouting). A tree model gets exact, stable positions from a hand layout.
- React Flow Pro "Dynamic Layouting" example: placeholder nodes, "+" on edges, **animated position transitions** (https://reactflow.dev/examples/layout/dynamic-layouting). Copy the animation idea.
- Branches should rejoin (HubSpot's non-rejoining branches + "Go to" jumps are hard to follow/audit). Always keep a default/else branch.
- Zapier Paths: renameable, nestable, duplicable, drag-reorder (https://zapier.com/blog/introducing-visual-editor/).
- Fit-to-view: clamp zoom, pad ~100px, **anchor to top** rather than centering.

## Node card
- Anatomy: app icon · step name (+ step number) · subtitle (summary; run duration in run mode) · status badge at corner · chevron/kebab menu.
- Draft statuses: invalid, needs-test (edited since last test), tested, untested, disabled/skip (faded).
- Fixed width (~232–280px) keeps branch math simple.

## Configuration
- **Right side panel, not modal.** n8n moving away from modal editors; users want auto-hide when nothing selected and a clear close control (https://community.n8n.io/t/help-us-test-some-canvas-improvements/201703).
- Data picker patterns:
  - Activepieces: focusing any field opens a "Data to insert" tree of upstream steps; inserts at cursor mixing text + refs; "Copy reference" in context menu (https://www.activepieces.com/docs/flows/passing-data).
  - Zapier: fields grouped by step, typed tree, inserted as colored **pills**; stale mapping shown yellow (https://help.zapier.com/hc/en-us/articles/8496343026701).
  - n8n: drag field from INPUT pane onto a parameter; expression editor with live resolved preview.
  - Pipedream: typing `{{` autocompletes from the test event.
- Testing: Windmill "Test this step" with upstream-prefilled args, "Test up to step", input library of past runs (https://www.windmill.dev/docs/flows/test_flows). Zapier lets you load recent real runs as sample data.
- **Anti-pattern:** picker empty until you've run a test. Fall back to schema-derived fields with type placeholders.

## Adding nodes
- One popover step picker anchored on "+" (also used for "replace"). Search + category tabs (Logic, then one per plugin/app).

## Run / audit view
- Make.com: bubble per module (green/red), click to inspect input/output bundles.
- Activepieces: per-step status on canvas, run-history sidebar, loop iteration stepper that **auto-jumps to the failed iteration**, step detail tabs Input/Output/Timeline, "retry from failed step".
- Trigger.dev: status header + timeline, tabs Overview (payload/output/error)/Detail/Context.
- Recommendation: same canvas read-only; status + duration badges; dim untaken paths.

## Validation
- Attio blocks publishing until invalid blocks are fixed. Activepieces "N steps incomplete" widget → selects & pans to first issue; card shows a warning triangle with tooltip.

## Keyboard / a11y
- Shortcuts suppressed in editable targets. Context menu: Replace, Copy, Duplicate, Skip, Copy reference, Paste after / inside branch / inside loop, Delete.
- React Flow a11y: `nodesFocusable`, Tab/Enter selection, `autoPanOnNodeFocus`, `ariaLabelConfig` (https://reactflow.dev/learn/advanced-use/accessibility).
- In a tree, arrow keys should navigate tree order, not nudge positions.

## Theming for embedding
- Import `@xyflow/react/dist/base.css` (structural) not `style.css`; expose own `--fk-*` tokens mapped onto `--xy-*`; `colorMode` prop (https://reactflow.dev/learn/customization/theming).
- Wrap styles in a CSS `@layer` so host styles win. Headless store/layout/picker logic + default styled skin.

## Top patterns (ranked)
1. Deterministic tree layout, fixed card sizes, dedicated rejoin/loop edges, animated transitions.
2. "+" on every edge, big "+" in empty branches, one searchable categorized picker for add/insert/replace.
3. Right-side config panel; canvas stays visible; auto-hide; pan selection into view.
4. Focus-triggered data picker (typed tree + sample values) inserting pills; `{{` autocomplete.
5. Per-step Test with prefilled inputs; "needs re-test" state; sample output feeds picker.
6. Card status badges + "N issues" pill that cycles/focuses; publish blocked while invalid.
7. Run overlay on same canvas; iteration stepper to failure; Input/Output/Error tabs.
8. Context menu mirrored by shortcuts incl. Copy reference, Duplicate, Disable, tree-aware paste; undo/redo.
9. Named branches, always-present default/else, labels on edges.
10. Token theming over base.css, read-only mode, localized aria labels.

## Anti-patterns
- Free positioning / drag-to-connect handles in a tree model.
- Modal node editors that hide the flow.
- Picker that is empty until a test runs.
- Non-rejoining branches / "go to" jumps.
- Permanently docked panels eating space; ambiguous icons.
