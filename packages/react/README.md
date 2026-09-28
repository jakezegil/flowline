# @flowline/react

The Flowline workflow editor, run viewer and run list for React. See the
[main README](../../README.md#editor) for the components and the provider's options.

## Styles and cascade layers

Import the stylesheet once, next to your app's own CSS:

```ts
import "@flowline/react/styles.css";
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
/* layers.css — import this before @flowline/react/styles.css */
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

```ts
import "./layers.css";
import "@flowline/react/styles.css";
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

When you do override a Flowline rule, an unlayered rule with any specificity wins. You don't need
`!important`.
