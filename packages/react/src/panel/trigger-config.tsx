/**
 * The trigger's side of the config panel: trigger type, kind-specific info (the webhook URL, the
 * event name), the trigger's config form, and its sample data.
 *
 * @module
 */
import {
  availableScope,
  dropHiddenFields,
  type Issue,
  type JSONSchema,
  payloadSchemaFor,
  type TriggerManifest,
} from "@flowline/core";
import { Check, Copy, Info, Link2, Zap } from "lucide-react";
import { type JSX, useEffect, useId, useMemo, useState } from "react";
import { useEditorStore } from "../hooks";
import { useFlowline, useFlowlineAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { IssueNotes } from "./fields/shell";
import { deref, typesOf } from "./schema";
import { SchemaForm } from "./schema-form";
import { SubflowOutput, useHasOutputMapping } from "./subflow-output";

/** The trigger's issues, with `field` relative to its config (`"trigger.x"` → `"x"`). */
export function triggerIssues(issues: Issue[]): Issue[] {
  const out: Issue[] = [];
  for (const i of issues) {
    if (i.stepId !== undefined) continue;
    if (i.field?.startsWith("trigger.")) out.push({ ...i, field: i.field.slice(8) });
    else if (i.code === "trigger.unknown") {
      const { field: _f, ...rest } = i;
      out.push(rest);
    }
  }
  return out;
}

/** Copies text, reporting success for a moment. */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text) => {
      try {
        globalThis.navigator?.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      } catch {
        // Clipboard unavailable; the URL is selectable.
      }
    },
  ];
}

/**
 * The webhook URL, `<origin><baseUrl>/hooks/<tenant>/<workflow>/<slug>`. The slug and tenant come
 * from the last saved version, so the URL shows once the workflow has been saved.
 */
function WebhookUrl(): JSX.Element {
  const { client } = useFlowline();
  const { labels } = useFlowlineAppearance();
  const docId = useEditorStore((s) => s.doc.id);
  const docSlug = useEditorStore((s) => s.doc.trigger.config.slug);
  const savedVersion = useEditorStore((s) => s.savedVersion);
  const [saved, setSaved] = useState<{ tenantId: string; slug?: string } | null>(null);
  const [copied, copy] = useCopy();

  useEffect(() => {
    if (savedVersion === null) return;
    let active = true;
    client.getWorkflow(docId).then(
      (d) => {
        if (!active) return;
        const slug = d.latest.doc.trigger.config.slug;
        setSaved({ tenantId: d.latest.tenantId, ...(typeof slug === "string" ? { slug } : {}) });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [client, docId, savedVersion]);

  const slug = typeof docSlug === "string" ? docSlug : saved?.slug;
  let url: string | undefined;
  if (saved && slug) {
    const origin = globalThis.location?.origin ?? "";
    const base = new URL(client.baseUrl ?? "", origin || "http://localhost").href.replace(
      /\/+$/,
      "",
    );
    const enc = encodeURIComponent;
    url = `${base}/hooks/${enc(saved.tenantId)}/${enc(docId)}/${enc(slug)}`;
  }

  return (
    <div className="fl-webhook">
      <div className="fl-webhook__head">
        <Link2 size={14} aria-hidden />
        <span className="fl-webhook__title">{labels.webhookUrl}</span>
      </div>
      {url ? (
        <>
          <div className="fl-webhook__row">
            <input
              className="fl-input fl-input--code fl-webhook__url"
              readOnly
              value={url}
              aria-label={labels.webhookUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="fl-btn" onClick={() => copy(url)}>
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
              {copied ? labels.copied : labels.copyUrl}
            </button>
          </div>
          <p className="fl-f__help">{labels.webhookUrlHint}</p>
        </>
      ) : (
        <p className="fl-webhook__pending">{labels.webhookSaveFirst}</p>
      )}
    </div>
  );
}

/** Trigger type choice, grouped by plugin. */
function TriggerTypeSelect({ triggers }: { triggers: TriggerManifest[] }): JSX.Element {
  const { labels } = useFlowlineAppearance();
  const id = useId();
  const type = useEditorStore((s) => s.doc.trigger.type);
  const plugins = useEditorStore((s) => s.manifest.plugins);
  const setTrigger = useEditorStore((s) => s.setTrigger);
  const known = triggers.some((t) => t.type === type);
  const groups = plugins
    .map((p) => ({ name: p.name, items: triggers.filter((t) => t.plugin === p.id) }))
    .filter((g) => g.items.length > 0);
  const ungrouped = triggers.filter((t) => !plugins.some((p) => p.id === t.plugin));
  return (
    <div className="fl-f">
      <div className="fl-f__head">
        <label className="fl-f__label" htmlFor={id}>
          {labels.triggerType}
        </label>
      </div>
      <select
        id={id}
        className="fl-input fl-select"
        value={type}
        onChange={(e) => setTrigger(e.target.value)}
      >
        {!known && <option value={type}>{labels.triggerUnknown(type)}</option>}
        {groups.map((g) => (
          <optgroup key={g.name} label={g.name}>
            {g.items.map((t) => (
              <option key={t.type} value={t.type}>
                {t.name}
              </option>
            ))}
          </optgroup>
        ))}
        {ungrouped.map((t) => (
          <option key={t.type} value={t.type}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The Configure tab of the trigger. */
export function TriggerConfigure(): JSX.Element {
  const { labels } = useFlowlineAppearance();
  const trigger = useEditorStore((s) => s.doc.trigger);
  const triggers = useEditorStore((s) => s.manifest.triggers);
  const allIssues = useEditorStore((s) => s.issues);
  const setTriggerConfig = useEditorStore((s) => s.setTriggerConfig);
  const m = triggers.find((t) => t.type === trigger.type);
  const issues = useMemo(() => triggerIssues(allIssues), [allIssues]);
  const loose = issues.filter((i) => i.field === undefined);
  const hasFields = m && Object.keys((m.config.properties ?? {}) as object).length > 0;
  const showOutput = useHasOutputMapping();
  return (
    <div className="fl-cp__section">
      <TriggerTypeSelect triggers={triggers} />
      {m?.description && <p className="fl-cp__desc">{m.description}</p>}
      <IssueNotes issues={loose} />
      {m?.kind === "webhook" && <WebhookUrl />}
      {m?.kind === "event" && m.event && (
        <p className="fl-callout" data-tone="info">
          <Zap size={15} aria-hidden />
          <span>{labels.eventTriggerHint(m.event)}</span>
        </p>
      )}
      {m && hasFields && (
        <SchemaForm
          schema={m.config}
          value={trigger.config}
          onChange={setTriggerConfig}
          stepId={TRIGGER_KEY}
          issues={issues}
          literalOnly
        />
      )}
      {showOutput && <SubflowOutput />}
    </div>
  );
}

/** Sample text per field-name pattern, first match wins (`first_name` and `firstName` alike). */
const TEXT_SAMPLES: [RegExp, string][] = [
  [/^(first|given|fore)name$/, "Ada"],
  [/^(last|family|sur)name$|^surname$/, "Lovelace"],
  [/^(middle)name$/, "Augusta"],
  [/^user(name)?$|^login$|^handle$/, "ada"],
  [/e?mail/, "ada@example.com"],
  [/phone|mobile|^tel$/, "+44 20 7946 0000"],
  [/company|organi[sz]ation|^org$|employer|account/, "Analytical Engines Ltd"],
  [/(job)?title$|role|position/, "Mathematician"],
  [/url|website|link|href/, "https://example.com"],
  [/street|address/, "12 St James's Square"],
  [/city|town/, "London"],
  [/country/, "United Kingdom"],
  [/zip|postcode|postal/, "SW1Y 4JH"],
  [/currency/, "GBP"],
  [/source|channel/, "web"],
  [/message|body|note|comment|description|text/, "Hello from Ada"],
  [/subject|summary|headline/, "Hello"],
  [/name/, "Ada Lovelace"],
];

/** An ID suffix as its own word: `contactId`, `contactID`, `contact_id`. */
const ID_SUFFIX = /(?<=[a-z0-9])I[dD]$|[_\s-][iI][dD]$/;

/** A plausible string for a field named `key`, e.g. `lastName` → `"Lovelace"`. */
export function sampleText(key: string): string {
  const k = key.replace(/[\s_-]+/g, "").toLowerCase();
  if (ID_SUFFIX.test(key) && k.length > 2) return `${k.slice(0, -2)}_123`;
  if (k === "id") return "item_123";
  for (const [re, text] of TEXT_SAMPLES) if (re.test(k)) return text;
  return key ? `${key} text` : "text";
}

/** A plausible number for a field named `key`: amounts in the thousands, counts small. */
function sampleNumber(key: string): number {
  const k = key.toLowerCase();
  if (/amount|price|value|total|revenue|budget|cost/.test(k)) return 1200;
  if (k === "age") return 36;
  if (/year/.test(k)) return 1843;
  return 1;
}

/** Example value of a schema, for "Fill from fields". */
export function exampleOf(root: JSONSchema, schema: JSONSchema, key = "", depth = 0): unknown {
  const s = deref(root, schema);
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const type = typesOf(s)?.find((t) => t !== "null");
  if (depth > 6) return null;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, JSONSchema>)) {
        out[k] = exampleOf(root, v, k, depth + 1);
      }
      return out;
    }
    case "array":
      return [exampleOf(root, (s.items ?? {}) as JSONSchema, key, depth + 1)];
    case "number":
    case "integer":
      return sampleNumber(key);
    case "boolean":
      return true;
    case "string":
      if (s.format === "date-time") return new Date(Date.UTC(2026, 0, 31, 9)).toISOString();
      if (s.format === "email") return "ada@example.com";
      if (s.format === "uri") return "https://example.com";
      return sampleText(key);
    default:
      return null;
  }
}

/** The trigger's Test tab: the sample payload that data pickers and step tests use. */
export function TriggerSample(): JSX.Element {
  const { labels } = useFlowlineAppearance();
  const trigger = useEditorStore((s) => s.doc.trigger);
  const manifest = useEditorStore((s) => s.manifest);
  const doc = useEditorStore((s) => s.doc);
  const ctx = useEditorStore((s) => s.ctx);
  const sample = useEditorStore((s) => s.samples[TRIGGER_KEY]);
  const setSample = useEditorStore((s) => s.setSample);
  const m = manifest.triggers.find((t) => t.type === trigger.type);
  const id = useId();
  const stored = sample === undefined ? "" : JSON.stringify(sample, null, 2);
  const [draft, setDraft] = useState(stored);
  const [savedFlash, setSavedFlash] = useState(false);
  useEffect(() => setDraft(stored), [stored]);
  let error = false;
  let parsed: unknown;
  if (draft.trim() !== "") {
    try {
      parsed = JSON.parse(draft);
    } catch {
      error = true;
    }
  }
  const payload = useMemo(() => {
    if (!m) return {};
    // Payload declarations hidden by showIf aren't part of the payload (as at run time).
    const visible = {
      ...trigger,
      config: dropHiddenFields(trigger.config, m.config) as typeof trigger.config,
    };
    return availableScope(doc, null, manifest, ctx)[0]?.schema ?? payloadSchemaFor(m, visible);
  }, [m, doc, manifest, ctx, trigger]);
  const dirty = draft !== stored;
  return (
    <div className="fl-cp__section">
      <div className="fl-f">
        <div className="fl-f__head">
          <label className="fl-f__label" htmlFor={id}>
            {m?.kind === "manual" ? labels.manualSample : labels.triggerSample}
          </label>
          <div className="fl-f__aside">
            <button
              type="button"
              className="fl-btn fl-btn--sm fl-btn--ghost"
              onClick={() => setDraft(JSON.stringify(exampleOf(payload, payload), null, 2))}
            >
              {labels.fillFromFields}
            </button>
          </div>
        </div>
        <textarea
          id={id}
          className="fl-input fl-input--mono fl-sample"
          rows={12}
          spellCheck={false}
          value={draft}
          placeholder={labels.jsonPlaceholder}
          aria-invalid={error || undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        {error && <p className="fl-f__local">{labels.invalidJson}</p>}
        <p className="fl-f__help">
          <Info size={12} aria-hidden /> {labels.triggerSampleHint}
        </p>
      </div>
      <div className="fl-cp__actions">
        <button
          type="button"
          className="fl-btn fl-btn--primary"
          disabled={error || draft.trim() === "" || !dirty}
          onClick={() => {
            setSample(TRIGGER_KEY, parsed);
            setSavedFlash(true);
            setTimeout(() => setSavedFlash(false), 1500);
          }}
        >
          {savedFlash ? <Check size={14} aria-hidden /> : null}
          {savedFlash ? labels.sampleSaved : labels.saveSample}
        </button>
        {dirty && stored !== "" && (
          <button type="button" className="fl-btn fl-btn--ghost" onClick={() => setDraft(stored)}>
            {labels.cancel}
          </button>
        )}
      </div>
    </div>
  );
}
