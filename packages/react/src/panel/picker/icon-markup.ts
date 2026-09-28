/**
 * Icons for plain DOM that CodeMirror owns (pills, autocomplete rows). Each icon is rendered
 * once and its SVG markup copied into every element that shows it: CodeMirror re-creates and
 * reuses that DOM freely, so a React root per element could never be reliably unmounted.
 *
 * @module
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { IconComponent } from "../../icons";

const markupCache = new WeakMap<IconComponent, Map<number, string>>();
let pending: { el: HTMLElement; Icon: IconComponent; size: number }[] = [];

function cached(Icon: IconComponent, size: number): string | undefined {
  return markupCache.get(Icon)?.get(size);
}

function render(Icon: IconComponent, size: number): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(createElement(Icon, { size })));
  const html = host.innerHTML;
  root.unmount();
  let sizes = markupCache.get(Icon);
  if (!sizes) {
    sizes = new Map();
    markupCache.set(Icon, sizes);
  }
  sizes.set(size, html);
  return html;
}

function flush(): void {
  const list = pending;
  pending = [];
  for (const { el, Icon, size } of list) el.innerHTML = cached(Icon, size) ?? render(Icon, size);
}

/**
 * Puts `Icon`'s SVG into `el`: at once if it was rendered before, else in a microtask (DOM
 * widgets are often built while React is mid-commit, when it can't render synchronously).
 */
export function fillIcon(el: HTMLElement, Icon: IconComponent, size = 12): void {
  const html = cached(Icon, size);
  if (html !== undefined) {
    el.innerHTML = html;
    return;
  }
  if (pending.length === 0) queueMicrotask(flush);
  pending.push({ el, Icon, size });
}
