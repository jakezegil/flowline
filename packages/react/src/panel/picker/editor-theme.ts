/**
 * CodeMirror themes for Flowkit's editors, drawn from the `--fk-*` tokens so they follow the
 * light/dark theme. CodeMirror injects its own base styles unlayered, which beat anything in
 * the `flowkit` layer, so everything inside the editor is styled here rather than in styles.css.
 *
 * @module
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const tooltip = {
  ".cm-tooltip": {
    fontFamily: "var(--fk-font)",
    color: "var(--fk-text)",
    background: "var(--fk-surface)",
    border: "1px solid var(--fk-border)",
    borderRadius: "10px",
    boxShadow: "var(--fk-shadow-lg)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--fk-font)",
    maxHeight: "min(300px, 45vh)",
    minWidth: "260px",
    maxWidth: "min(420px, calc(100vw - 24px))",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 8px",
    borderRadius: "6px",
    fontSize: "12.5px",
    lineHeight: "18px",
    color: "var(--fk-text)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    color: "var(--fk-text)",
    background: "var(--fk-subtle-strong)",
  },
  "&:not(.cm-focused) .cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--fk-subtle)",
  },
  ".cm-completionLabel": {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "620",
    color: "var(--fk-accent-text)",
  },
  ".cm-completionDetail": {
    flex: "none",
    marginLeft: "0",
    fontStyle: "normal",
    fontFamily: "var(--fk-font-mono)",
    fontSize: "11px",
    color: "var(--fk-text-muted)",
  },
  ".cm-completionIcon": { display: "none" },
  ".fk-ref-option__icon": {
    display: "grid",
    flex: "none",
    placeItems: "center",
    width: "20px",
    height: "20px",
    color: "var(--fk-text-muted)",
    background: "var(--fk-subtle)",
    borderRadius: "5px",
  },
  ".fk-ref-option__sample": {
    flex: "0 1 auto",
    maxWidth: "35%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--fk-font-mono)",
    fontSize: "11px",
    color: "var(--fk-text-muted)",
    order: "1",
  },
  ".cm-completionInfo": {
    padding: "8px 10px",
    fontSize: "12px",
  },
};

/** The look of a reference input: an input-like box, with pills and a hover card. */
export const refInputTheme: Extension = EditorView.theme({
  "&": {
    fontFamily: "var(--fk-font)",
    fontSize: "13px",
    color: "var(--fk-text)",
    background: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "22px",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "5px 0",
    caretColor: "var(--fk-text)",
  },
  ".cm-line": { padding: "0 10px" },
  ".cm-placeholder": { color: "var(--fk-text-muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fk-text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { background: "var(--fk-ring)" },
  ".fk-ref-pill": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "100%",
    height: "20px",
    margin: "1px 1px 0",
    padding: "0 7px 0 3px",
    overflow: "hidden",
    // Top-aligned in the 22px line (an inline-flex box's baseline comes from its icon).
    verticalAlign: "top",
    fontSize: "12px",
    fontWeight: "520",
    lineHeight: "20px",
    whiteSpace: "nowrap",
    color: "var(--fk-accent-text)",
    background: "var(--fk-accent-soft)",
    borderRadius: "6px",
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--fk-accent) 22%, transparent)",
    cursor: "default",
    userSelect: "none",
  },
  ".fk-ref-pill__icon": {
    display: "grid",
    flex: "none",
    placeItems: "center",
    width: "15px",
    height: "15px",
    color: "var(--fk-accent-text)",
    background: "color-mix(in srgb, var(--fk-accent) 16%, var(--fk-surface))",
    borderRadius: "4px",
  },
  ".fk-ref-pill__icon svg": { width: "11px", height: "11px" },
  ".fk-ref-pill__head": {
    flex: "0 1 auto",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".fk-ref-pill__sep": {
    flex: "none",
    opacity: "0.55",
  },
  ".fk-ref-pill__path": {
    flex: "0 1 auto",
    minWidth: "2em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: "600",
  },
  ".fk-ref-pill--stale": {
    color: "color-mix(in srgb, var(--fk-warning) 72%, var(--fk-text))",
    background: "color-mix(in srgb, var(--fk-warning) 13%, var(--fk-surface))",
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--fk-warning) 45%, transparent)",
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, var(--fk-warning) 60%, transparent)",
  },
  ".fk-ref-pill--stale .fk-ref-pill__icon": {
    color: "var(--fk-on-status)",
    background: "var(--fk-warning)",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    borderRadius: "8px",
  },
  ".fk-ref-card": {
    maxWidth: "300px",
    padding: "8px 10px",
    fontSize: "12px",
    lineHeight: "1.45",
  },
  ".fk-ref-card__title": { fontWeight: "600" },
  ".fk-ref-card__meta": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "2px",
    color: "var(--fk-text-muted)",
  },
  ".fk-ref-card__meta code": {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--fk-font-mono)",
    fontSize: "11px",
  },
  ".fk-ref-card__type": {
    flex: "none",
    padding: "0 5px",
    fontFamily: "var(--fk-font-mono)",
    fontSize: "10.5px",
    lineHeight: "16px",
    background: "var(--fk-subtle-strong)",
    borderRadius: "4px",
  },
  ".fk-ref-card__sample": {
    display: "flex",
    gap: "6px",
    marginTop: "6px",
    paddingTop: "6px",
    borderTop: "1px solid var(--fk-border)",
  },
  ".fk-ref-card__sample span:first-child": { color: "var(--fk-text-muted)" },
  ".fk-ref-card__sample span:last-child": {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--fk-font-mono)",
    fontSize: "11px",
  },
  ".fk-ref-card__warn": {
    marginTop: "6px",
    paddingTop: "6px",
    color: "color-mix(in srgb, var(--fk-warning) 72%, var(--fk-text))",
    borderTop: "1px solid var(--fk-border)",
  },
  ...tooltip,
});

/** The look of the code editor: mono text, a quiet gutter, token-colored syntax. */
export const codeEditorTheme: Extension = [
  EditorView.theme({
    "&": {
      fontSize: "12.5px",
      color: "var(--fk-text)",
      background: "transparent",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--fk-font-mono)",
      lineHeight: "20px",
    },
    ".cm-content": { padding: "8px 0", caretColor: "var(--fk-text)" },
    ".cm-line": { padding: "0 12px 0 6px" },
    ".cm-gutters": {
      color: "color-mix(in srgb, var(--fk-text-muted) 70%, transparent)",
      background: "var(--fk-subtle)",
      border: "none",
      borderRight: "1px solid var(--fk-border)",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "28px" },
    ".cm-activeLine": { background: "color-mix(in srgb, var(--fk-text) 3%, transparent)" },
    ".cm-activeLineGutter": { color: "var(--fk-text)", background: "transparent" },
    "&:not(.cm-focused) .cm-activeLine, &:not(.cm-focused) .cm-activeLineGutter": {
      background: "transparent",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fk-text)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { background: "var(--fk-ring)" },
    "&.cm-focused .cm-matchingBracket": {
      background: "color-mix(in srgb, var(--fk-accent) 18%, transparent)",
      outline: "none",
    },
    ".cm-placeholder": { color: "var(--fk-text-muted)" },
    ...tooltip,
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
        color: "var(--fk-accent-text)",
        fontWeight: "550",
      },
      // Mixed toward the text color so they keep AA contrast on both backgrounds.
      {
        tag: [t.string, t.special(t.string), t.regexp],
        color: "color-mix(in srgb, var(--fk-success) 78%, var(--fk-text))",
      },
      {
        tag: [t.number, t.bool, t.null, t.atom],
        color: "color-mix(in srgb, var(--fk-warning) 75%, var(--fk-text))",
      },
      {
        tag: [t.comment, t.lineComment, t.blockComment],
        color: "var(--fk-text-muted)",
        fontStyle: "italic",
      },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: "color-mix(in srgb, var(--fk-accent) 60%, var(--fk-text))",
      },
      { tag: [t.propertyName], color: "var(--fk-text)" },
      { tag: [t.variableName, t.definition(t.variableName)], color: "var(--fk-text)" },
      { tag: [t.operator, t.punctuation, t.bracket], color: "var(--fk-text-muted)" },
      { tag: t.invalid, color: "var(--fk-danger)" },
    ]),
  ),
];
