# @flowkit/react

The Flowkit workflow editor, run viewer and run list for React. See the
[main README](../../README.md#editor) for the components and the provider's options.

## Styles and cascade layers

Import the stylesheet once, next to your app's own CSS:

```ts
import "@flowkit/react/styles.css";
```

Every Flowkit rule sits in the `flowkit` [cascade layer](https://developer.mozilla.org/docs/Web/CSS/@layer).
Styles outside any layer beat styles in a layer, whatever their specificity, so your unlayered CSS
always wins over Flowkit's. That is what makes theming easy, and it's also the one trap to avoid.

### Put element resets in a layer below `flowkit`

A global reset such as

```css
button, input, select, textarea { font: inherit; color: inherit; }
```

is unlayered, so it beats Flowkit's `.fk-btn--primary { color: var(--fk-accent-fg) }` and the
editor's buttons lose their colors (white text on the accent turns into body text on the accent).
The same goes for `a { color }`, `:focus-visible { outline }` and similar element rules.

Put resets in a layer and declare the layer order before Flowkit's stylesheet loads. The first
place a layer is named fixes its order, so do this in a file imported first:

```css
/* layers.css — import this before @flowkit/react/styles.css */
@layer reset, flowkit;
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

```ts
import "./layers.css";
import "@flowkit/react/styles.css";
import "./app.css";
```

If you use a CSS framework that already has layers (Tailwind v4's `base`, for example), list
`flowkit` after its base layer: `@layer theme, base, flowkit, components, utilities;`.

The mini-crm example does exactly this in `examples/mini-crm/web/src/layers.css`.

### Theming

Prefer tokens to overriding rules. Pass `theme={{ colorMode, tokens }}` to `<FlowkitProvider>`, or
set the `--fk-*` custom properties (`--fk-accent`, `--fk-accent-fg`, `--fk-bg`, `--fk-surface`,
`--fk-border`, `--fk-text`, `--fk-text-muted`, `--fk-danger`, `--fk-warning`, `--fk-success`,
`--fk-radius`, `--fk-font`, `--fk-font-mono` and others at the top of `styles.css`) in
an unlayered `.fk-root { … }` rule. Flowkit defines them on `.fk-root` itself, so setting them on
an ancestor has no effect. Dark mode follows `colorMode`, or `prefers-color-scheme` when it is
`"system"`.

When you do override a Flowkit rule, an unlayered rule with any specificity wins. You don't need
`!important`.
