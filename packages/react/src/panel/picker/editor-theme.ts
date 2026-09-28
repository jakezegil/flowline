/**
 * CodeMirror themes for Flowline's editors, drawn from the `--fl-*` tokens so they follow the
 * light/dark theme. CodeMirror injects its own base styles unlayered, which beat anything in
 * the `flowline` layer, so everything inside the editor is styled here rather than in styles.css.
 *
 * @module
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const tooltip = {
  ".cm-tooltip": {
    fontFamily: "var(--fl-font)",
    color: "var(--fl-text)",
    background: "var(--fl-surface)",
    border: "1px solid var(--fl-border)",
    borderRadius: "10px",
    boxShadow: "var(--fl-shadow-lg)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--fl-font)",
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
    color: "var(--fl-text)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    color: "var(--fl-text)",
    background: "var(--fl-subtle-strong)",
  },
  "&:not(.cm-focused) .cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--fl-subtle)",
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
    color: "var(--fl-accent-text)",
  },
  ".cm-completionDetail": {
    flex: "none",
    marginLeft: "0",
    fontStyle: "normal",
    fontFamily: "var(--fl-font-mono)",
    fontSize: "11px",
    color: "var(--fl-text-muted)",
  },
  ".cm-completionIcon": { display: "none" },
  ".fl-ref-option__icon": {
    display: "grid",
    flex: "none",
    placeItems: "center",
    width: "20px",
    height: "20px",
    color: "var(--fl-text-muted)",
    background: "var(--fl-subtle)",
    borderRadius: "5px",
  },
  ".fl-ref-option__sample": {
    flex: "0 1 auto",
    maxWidth: "35%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--fl-font-mono)",
    fontSize: "11px",
    color: "var(--fl-text-muted)",
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
    fontFamily: "var(--fl-font)",
    fontSize: "13px",
    color: "var(--fl-text)",
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
    caretColor: "var(--fl-text)",
  },
  ".cm-line": { padding: "0 10px" },
  ".cm-placeholder": { color: "var(--fl-text-muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fl-text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { background: "var(--fl-ring)" },
  ".fl-ref-pill": {
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
    color: "var(--fl-accent-text)",
    background: "var(--fl-accent-soft)",
    borderRadius: "6px",
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--fl-accent) 22%, transparent)",
    cursor: "default",
    userSelect: "none",
  },
  ".fl-ref-pill__icon": {
    display: "grid",
    flex: "none",
    placeItems: "center",
    width: "15px",
    height: "15px",
    color: "var(--fl-accent-text)",
    background: "color-mix(in srgb, var(--fl-accent) 16%, var(--fl-surface))",
    borderRadius: "4px",
  },
  ".fl-ref-pill__icon svg": { width: "11px", height: "11px" },
  ".fl-ref-pill__head": {
    flex: "0 1 auto",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".fl-ref-pill__sep": {
    flex: "none",
    opacity: "0.55",
  },
  ".fl-ref-pill__path": {
    flex: "0 1 auto",
    minWidth: "2em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: "600",
  },
  ".fl-ref-pill--stale": {
    color: "color-mix(in srgb, var(--fl-warning) 72%, var(--fl-text))",
    background: "color-mix(in srgb, var(--fl-warning) 13%, var(--fl-surface))",
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--fl-warning) 45%, transparent)",
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, var(--fl-warning) 60%, transparent)",
  },
  ".fl-ref-pill--stale .fl-ref-pill__icon": {
    color: "var(--fl-on-status)",
    background: "var(--fl-warning)",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    borderRadius: "8px",
  },
  ".fl-ref-card": {
    maxWidth: "300px",
    padding: "8px 10px",
    fontSize: "12px",
    lineHeight: "1.45",
  },
  ".fl-ref-card__title": { fontWeight: "600" },
  ".fl-ref-card__meta": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "2px",
    color: "var(--fl-text-muted)",
  },
  ".fl-ref-card__meta code": {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--fl-font-mono)",
    fontSize: "11px",
  },
  ".fl-ref-card__type": {
    flex: "none",
    padding: "0 5px",
    fontFamily: "var(--fl-font-mono)",
    fontSize: "10.5px",
    lineHeight: "16px",
    background: "var(--fl-subtle-strong)",
    borderRadius: "4px",
  },
  ".fl-ref-card__sample": {
    display: "flex",
    gap: "6px",
    marginTop: "6px",
    paddingTop: "6px",
    borderTop: "1px solid var(--fl-border)",
  },
  ".fl-ref-card__sample span:first-child": { color: "var(--fl-text-muted)" },
  ".fl-ref-card__sample span:last-child": {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--fl-font-mono)",
    fontSize: "11px",
  },
  ".fl-ref-card__warn": {
    marginTop: "6px",
    paddingTop: "6px",
    color: "color-mix(in srgb, var(--fl-warning) 72%, var(--fl-text))",
    borderTop: "1px solid var(--fl-border)",
  },
  ...tooltip,
});

/** The look of the code editor: mono text, a quiet gutter, token-colored syntax. */
export const codeEditorTheme: Extension = [
  EditorView.theme({
    "&": {
      fontSize: "12.5px",
      color: "var(--fl-text)",
      background: "transparent",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--fl-font-mono)",
      lineHeight: "20px",
    },
    ".cm-content": { padding: "8px 0", caretColor: "var(--fl-text)" },
    ".cm-line": { padding: "0 12px 0 6px" },
    ".cm-gutters": {
      color: "color-mix(in srgb, var(--fl-text-muted) 70%, transparent)",
      background: "var(--fl-subtle)",
      border: "none",
      borderRight: "1px solid var(--fl-border)",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "28px" },
    ".cm-activeLine": { background: "color-mix(in srgb, var(--fl-text) 3%, transparent)" },
    ".cm-activeLineGutter": { color: "var(--fl-text)", background: "transparent" },
    "&:not(.cm-focused) .cm-activeLine, &:not(.cm-focused) .cm-activeLineGutter": {
      background: "transparent",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fl-text)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { background: "var(--fl-ring)" },
    "&.cm-focused .cm-matchingBracket": {
      background: "color-mix(in srgb, var(--fl-accent) 18%, transparent)",
      outline: "none",
    },
    ".cm-placeholder": { color: "var(--fl-text-muted)" },
    ...tooltip,
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
        color: "var(--fl-accent-text)",
        fontWeight: "550",
      },
      // Mixed toward the text color so they keep AA contrast on both backgrounds.
      {
        tag: [t.string, t.special(t.string), t.regexp],
        color: "color-mix(in srgb, var(--fl-success) 78%, var(--fl-text))",
      },
      {
        tag: [t.number, t.bool, t.null, t.atom],
        color: "color-mix(in srgb, var(--fl-warning) 75%, var(--fl-text))",
      },
      {
        tag: [t.comment, t.lineComment, t.blockComment],
        color: "var(--fl-text-muted)",
        fontStyle: "italic",
      },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: "color-mix(in srgb, var(--fl-accent) 60%, var(--fl-text))",
      },
      { tag: [t.propertyName], color: "var(--fl-text)" },
      { tag: [t.variableName, t.definition(t.variableName)], color: "var(--fl-text)" },
      { tag: [t.operator, t.punctuation, t.bracket], color: "var(--fl-text-muted)" },
      { tag: t.invalid, color: "var(--fl-danger)" },
    ]),
  ),
];
