# @flowlinejs/react

The Flowline workflow editor, run viewer and run list for React. See the
[main README](../../README.md#editor) for the components and the provider's options.

## Styles and cascade layers

Import the stylesheet once, next to your app's own CSS:

```ts file=styles.ts
import "@flowlinejs/react/styles.css";
```

Every Flowline rule sits in the `flowline` [cascade layer](https://developer.mozilla.org/docs/Web/CSS/@layer).
Styles outside any layer beat styles in a layer, whatever their specificity, so your unlayered CSS
always wins over Flowline's. That is what makes theming easy, and it's also the one trap to avoid.

### Put element resets in a layer below `flowline`

A global reset such as

```css
button, input, select, textarea { font: inherit; color: inherit; }
```

is unlayered, so it beats Flowline's `.fl-btn--primary { color: var(--fl-accent-fg) }` and the
editor's buttons lose their colors (white text on the accent turns into body text on the accent).
The same goes for `a { color }`, `:focus-visible { outline }` and similar element rules.

Put resets in a layer and declare the layer order before Flowline's stylesheet loads. The first
place a layer is named fixes its order, so do this in a file imported first:

```css
/* layers.css — import this before @flowlinejs/react/styles.css */
@layer reset, flowline;
```

```css
/* your app's CSS */
@layer reset {
  button, input, select, textarea { font: inherit; color: inherit; }
  a { color: var(--brand); }
}

/* Class-level app styles can stay unlayered. */
.app-header { … }
```

```ts file=main.ts
import "./layers.css";
import "@flowlinejs/react/styles.css";
import "./app.css";
```

If you use a CSS framework that already has layers (Tailwind v4's `base`, for example), list
`flowline` after its base layer: `@layer theme, base, flowline, components, utilities;`.

The mini-crm example does exactly this in `examples/mini-crm/web/src/layers.css`.

### Theming

Prefer tokens to overriding rules. Pass `theme={{ colorMode, tokens }}` to `<FlowlineProvider>`, or
set the `--fl-*` custom properties (`--fl-accent`, `--fl-accent-fg`, `--fl-bg`, `--fl-surface`,
`--fl-border`, `--fl-text`, `--fl-text-muted`, `--fl-danger`, `--fl-warning`, `--fl-success`,
`--fl-radius`, `--fl-font`, `--fl-font-mono` and others at the top of `styles.css`) in
an unlayered `.fl-root { … }` rule. Flowline defines them on `.fl-root` itself, so setting them on
an ancestor has no effect. Dark mode follows `colorMode`, or `prefers-color-scheme` when it is
`"system"`.

An unlayered `.fl-root { --fl-accent: … }` applies in both colour modes. For dark-only values,
scope the rule to dark mode: `.fl-root[data-fl-theme="dark"] { … }`, plus
`@media (prefers-color-scheme: dark) { .fl-root[data-fl-theme="system"] { … } }` if you use
`colorMode: "system"`. `theme.tokens` also applies in both modes, so pass mode-specific tokens
from your own colour-mode state if you need them.

Annotations have their own palette. Each of the six colours (`yellow`, `blue`, `green`, `pink`,
`purple`, `gray`) has three tokens: `--fl-annot-<colour>-bg`, `-border` and `-text`, for example
`--fl-annot-yellow-bg`. In `theme.tokens` they are `annotYellowBg`, `annotYellowBorder`,
`annotYellowText` and so on (the `AnnotationToken` type). Section regions and sticky notes fill
with `-bg`. Regions are outlined with `-border`, which is also the left accent of a coloured step
card. A section's header text uses `-text`. The built-in values keep `-text` and `--fl-text` at
WCAG AA contrast (4.5:1) on `-bg` in both colour modes, so keep that in mind when you override
them. A colour outside the six draws as gray. The ring that flashes around steps an agent just
changed is `--fl-changed`. It is derived from `--fl-accent`, so it follows your accent.

```ts file=theme.ts
import type { FlowlineTheme } from "@flowlinejs/react";

export const theme: FlowlineTheme = {
  tokens: { annotYellowBg: "#fff4c2", annotYellowText: "#5c4300" },
};
```

When you do override a Flowline rule, an unlayered rule with any specificity wins. You don't need
`!important`.

## Agent bridge

The bridge lets an AI agent edit the open workflow the way a person does. Its reads see the
editor's current doc at call time, and its edits go through the editor store's `apply`, so each
batch is one undo step, flashes the changed steps on the canvas, and is rejected with code
`"readOnly"` while the editor is read-only. It serves the same tools as core's `commandCatalog`
(see the [core README](../core/README.md#agents)); `bridge.runTool(name, args)` runs one call.

For an agent loop outside React, create a bridge per store with `createAgentBridge` in
`onStoreReady`. The editor calls it for every store it creates (first load, a new `workflowId`, a
retry, a new workflow), and runs the cleanup you return when that store is replaced or the
editor unmounts:

```tsx file=AgentEditor.tsx
import { commandCatalog, type Manifest, type ToolDefinition } from "@flowlinejs/core";
import { createAgentBridge, WorkflowEditor } from "@flowlinejs/react";

/** Your agent loop: it sends `tools` to the model and calls `run` for each tool call. */
interface Agent {
  attach(tools: ToolDefinition[], run: (name: string, args: unknown) => unknown): void;
  detach(): void;
}

export function AgentEditor({ agent, manifest }: { agent: Agent; manifest: Manifest }) {
  return (
    <WorkflowEditor
      workflowId="welcome-contact"
      onStoreReady={(store) => {
        const bridge = createAgentBridge(store);
        agent.attach(commandCatalog(manifest), (name, args) => bridge.runTool(name, args));
        return () => agent.detach();
      }}
    />
  );
}
```

Inside the editor, `useWorkflowAgentBridge()` returns the bridge of the enclosing
`<WorkflowEditor>`'s or `<WorkflowCanvas>`'s store (or of the store you pass it), the same object
until the store changes. `bridge.read` holds every read bound to the store, and
`bridge.apply(commands)` runs a batch directly. A read is a snapshot taken when you call it, so
subscribe to `doc` to recompute it after each edit:

```tsx file=AgentPanel.tsx
import {
  ConfigPanel,
  type EditorStore,
  useEditorStore,
  useWorkflowAgentBridge,
  WorkflowEditor,
} from "@flowlinejs/react";
import { useMemo } from "react";

export function AgentPanel() {
  const bridge = useWorkflowAgentBridge();
  const doc = useEditorStore((s) => s.doc);
  // `doc` is a dependency so the read re-runs after each edit.
  const { text } = useMemo(() => bridge.read.overview({ budget: 2000 }), [bridge, doc]);
  const rename = () => bridge.apply([{ op: "renameWorkflow", name: "Welcome VIPs" }]);
  return (
    <section>
      <pre>{text}</pre>
      <button type="button" onClick={rename}>
        Rename
      </button>
    </section>
  );
}

// `renderPanel` replaces the default panel, so render the config form next to your own.
const panel = (store: EditorStore) => (
  <>
    <ConfigPanel store={store} />
    <AgentPanel />
  </>
);

export function AgentWorkflowPage() {
  return <WorkflowEditor workflowId="welcome-contact" renderPanel={panel} />;
}
```

The `renderPanel` slot shows only while a step is selected. For an agent panel that is always
visible, render it in your own layout and give it a bridge from `onStoreReady` with
`createAgentBridge(store)`, as above.
