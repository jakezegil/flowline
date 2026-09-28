/**
 * A read-only JSON viewer: collapsible objects and arrays, values colored by type, masked values
 * called out, and a button copying the whole value.
 *
 * @module
 */

import { Check, ChevronRight, Copy, Lock } from "lucide-react";
import { type JSX, useState } from "react";
import { useFlowkitAppearance } from "../provider";
import { Hint } from "./primitives";

/** The engine's placeholder for masked secret and sensitive values. */
const REDACTED = "[redacted]";

/** Objects and arrays deeper than this start collapsed. */
const OPEN_DEPTH = 2;

/** A JSON value as an expandable tree, with a "Copy JSON" button. */
export function JsonTree({ value, label }: { value: unknown; label?: string }): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = JSON.stringify(value, null, 2) ?? "undefined";
    try {
      const write = globalThis.navigator?.clipboard?.writeText(text);
      write?.then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        () => {},
      );
    } catch {
      // Clipboard unavailable: nothing to do; the value is on screen.
    }
  };
  return (
    <figure className="fk-json" aria-label={label}>
      <button
        type="button"
        className="fk-json__copy"
        onClick={copy}
        aria-label={copied ? labels.copied : labels.copyJson}
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        <span>{copied ? labels.copied : labels.copyJson}</span>
      </button>
      <div className="fk-json__body">
        <JsonNode value={value} depth={0} />
      </div>
    </figure>
  );
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const { labels } = useFlowkitAppearance();
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const key =
    name !== undefined ? (
      <span className="fk-json__key">
        {name}
        <span className="fk-json__colon">:</span>
      </span>
    ) : null;

  if (value !== null && typeof value === "object") {
    const isArray = Array.isArray(value);
    const entries = isArray
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    const count = isArray ? labels.items(entries.length) : labels.keys(entries.length);
    if (entries.length === 0) {
      return (
        <div className="fk-json__row">
          {key}
          <span className="fk-json__punct">{isArray ? "[]" : "{}"}</span>
        </div>
      );
    }
    return (
      <div className="fk-json__group">
        <button
          type="button"
          className="fk-json__row fk-json__toggle"
          aria-expanded={open}
          aria-label={`${name ?? ""} ${open ? labels.collapse : labels.expand}`.trim()}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={12} className="fk-json__chev" aria-hidden />
          {key}
          <span className="fk-json__punct">{isArray ? "[" : "{"}</span>
          {!open && (
            <>
              <span className="fk-json__count">{count}</span>
              <span className="fk-json__punct">{isArray ? "]" : "}"}</span>
            </>
          )}
        </button>
        {open && (
          <>
            <div className="fk-json__children">
              {entries.map(([k, v]) => (
                <JsonNode key={k} name={isArray ? undefined : k} value={v} depth={depth + 1} />
              ))}
            </div>
            <div className="fk-json__row fk-json__close">
              <span className="fk-json__punct">{isArray ? "]" : "}"}</span>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="fk-json__row">
      {key}
      <Scalar value={value} />
    </div>
  );
}

function Scalar({ value }: { value: unknown }) {
  const { labels } = useFlowkitAppearance();
  if (value === REDACTED) {
    return (
      <Hint content={labels.redacted} side="top">
        <span className="fk-json__redacted" role="img" aria-label={labels.redacted}>
          <Lock size={10} aria-hidden />
          <span aria-hidden>{labels.redactedValue}</span>
        </span>
      </Hint>
    );
  }
  if (typeof value === "string") {
    return <span className="fk-json__str">"{value}"</span>;
  }
  if (typeof value === "number") return <span className="fk-json__num">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="fk-json__bool">{String(value)}</span>;
  if (value === null) return <span className="fk-json__null">null</span>;
  return <span className="fk-json__null">undefined</span>;
}
