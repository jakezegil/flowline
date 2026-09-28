/**
 * The run viewer's "Resume run" dialog: sends a JSON callback body to a waiting step, checked
 * against the body schema the step's node declares (`resume.body`), if any.
 *
 * @module
 */

import { checkJson, describeType, isAnySchema, type JSONSchema } from "@flowlinejs/core";
import { LoaderCircle } from "lucide-react";
import { type JSX, useEffect, useId, useState } from "react";
import { useFlowlineAppearance } from "../provider";
import { SmallDialog } from "../ui/primitives";

const MAX_EXAMPLE_DEPTH = 4;

/** A sample value for `schema`, shown as the body field's placeholder (never sent). */
export function exampleFor(schema: JSONSchema, depth = 0): unknown {
  if (depth > MAX_EXAMPLE_DEPTH) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("default" in schema) return schema.default;
  const members = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(members) && members[0] && typeof members[0] === "object") {
    return exampleFor(members[0] as JSONSchema, depth + 1);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const keys = required.length > 0 ? required : Object.keys(props);
      return Object.fromEntries(keys.map((k) => [k, exampleFor(props[k] ?? {}, depth + 1)]));
    }
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/**
 * Resume run: a JSON body for the waiting step's callback. Without a declared `schema` the body
 * starts as `{}`; with one it starts empty (a guessed body could take the wrong path, e.g. reject
 * an approval), shows what it expects and is checked against it before sending.
 */
export function ResumeDialog({
  open,
  onOpenChange,
  onResume,
  schema,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onResume(body: unknown): Promise<boolean>;
  /** JSON Schema of the callback body (the node's `resume.body`). */
  schema?: JSONSchema | undefined;
}): JSX.Element {
  const { labels } = useFlowlineAppearance();
  const bodySchema = schema !== undefined && !isAnySchema(schema) ? schema : undefined;
  const declared = bodySchema !== undefined;
  const [text, setText] = useState(declared ? "" : "{}");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const bodyId = `${id}-body`;
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  // Each opening starts over, so a body typed for one wait isn't sent to the next.
  useEffect(() => {
    if (!open) return;
    setText(declared ? "" : "{}");
    setProblems([]);
  }, [open, declared]);

  const submit = async () => {
    let body: unknown;
    if (text.trim() === "") {
      if (declared) {
        setProblems([labels.callbackBodyRequired]);
        return;
      }
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        setProblems([labels.invalidJson]);
        return;
      }
    }
    if (bodySchema) {
      const found = checkJson(body, bodySchema, labels.callbackBody);
      if (found.length > 0) {
        setProblems(found);
        return;
      }
    }
    setProblems([]);
    setBusy(true);
    const ok = await onResume(body);
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  const describedBy = [declared ? hintId : "", problems.length > 0 ? errId : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <SmallDialog
      open={open}
      onOpenChange={onOpenChange}
      title={labels.resumeTitle}
      description={labels.resumeDescription}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="fl-btn" onClick={() => onOpenChange(false)}>
            {labels.cancel}
          </button>
          <button type="submit" className="fl-btn fl-btn--primary" disabled={busy}>
            {busy && <LoaderCircle size={14} className="fl-spin" aria-hidden />}
            {labels.resumeTitle}
          </button>
        </>
      }
    >
      <div className="fl-field">
        <label className="fl-field__label" htmlFor={bodyId}>
          {labels.callbackBody}
        </label>
        <textarea
          id={bodyId}
          className="fl-input fl-input--mono"
          rows={6}
          spellCheck={false}
          value={text}
          {...(bodySchema ? { placeholder: JSON.stringify(exampleFor(bodySchema), null, 2) } : {})}
          aria-invalid={problems.length > 0 || undefined}
          aria-describedby={describedBy || undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {bodySchema && (
          <div id={hintId} className="fl-field__hint">
            {labels.callbackBodyExpects(describeType(bodySchema))}
          </div>
        )}
        {problems.length > 0 && (
          <div id={errId} className="fl-field__error">
            {problems.join(" · ")}
          </div>
        )}
      </div>
    </SmallDialog>
  );
}
