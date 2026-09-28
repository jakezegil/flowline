/**
 * `?page=picker` (or `/picker`): the reference input, data picker and code editor in isolation,
 * against a hand-made scope with samples. `&theme=light|dark`.
 */
import type { ScopeEntry, ValueExpr } from "@flowline/core";
import type { FlowlineClient } from "@flowline/core/client";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { PortalContainerContext } from "../src/canvas/canvas-context";
import { FlowlineProvider } from "../src/index";
import { CodeEditor } from "../src/panel/code-editor";
import { DataPicker } from "../src/panel/data-picker";
import { RefTextInput } from "../src/panel/ref-text-input";

const contact = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: "string", format: "email" },
    score: { type: "number" },
    vip: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    company: {
      type: "object",
      properties: {
        name: { type: "string" },
        domain: { type: "string" },
        employees: { type: "integer" },
      },
    },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "email"],
};

/** Scope in document order, as `availableScope` returns it. */
export const pickerScope: ScopeEntry[] = [
  {
    refBase: "trigger",
    kind: "trigger",
    label: "Deal updated",
    icon: "handshake",
    schema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        amount: { type: "number" },
        stage: { enum: ["lead", "won", "lost"] },
        owner: {
          type: "object",
          properties: { name: { type: "string" }, email: { type: "string" } },
        },
      },
    },
  },
  {
    refBase: "steps.loadContact",
    kind: "step",
    stepId: "loadContact",
    label: "Load contact",
    icon: "user",
    schema: contact,
  },
  {
    refBase: "steps.fetchOrders",
    kind: "step",
    stepId: "fetchOrders",
    label: "Fetch orders",
    icon: "globe",
    schema: {},
  },
  {
    refBase: "steps.oldNotify",
    kind: "step",
    stepId: "oldNotify",
    label: "Notify Slack",
    icon: "message-square",
    schema: { type: "object", properties: { ts: { type: "string" } } },
    disabled: true,
  },
  {
    refBase: "loop",
    kind: "loop",
    stepId: "eachTag",
    label: "For each tag",
    icon: "repeat",
    schema: { type: "object", properties: { item: { type: "string" }, index: { type: "number" } } },
  },
];

export const pickerSamples: Record<string, unknown> = {
  __trigger: {
    dealId: "d_981",
    amount: 12500,
    stage: "won",
    owner: { name: "Grace Hopper", email: "grace@acme.io" },
  },
  loadContact: {
    id: "c_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    score: 92,
    vip: true,
    tags: ["enterprise", "emea"],
    company: { name: "Analytical Engines Ltd", domain: "engines.io", employees: 42 },
    createdAt: "2026-03-14T09:26:53Z",
  },
  // No schema: the picker falls back to the sample's shape.
  fetchOrders: {
    status: 200,
    body: { orders: [{ id: "o_1", total: 420.5, sku: "ENG-01" }], next: null },
  },
};

const client = {} as FlowlineClient;

function Field(props: {
  label: string;
  hint?: string;
  value: unknown;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="pk-field">
      <div className="pk-label">
        {props.label}
        {props.hint && <span className="pk-hint">{props.hint}</span>}
      </div>
      {props.children}
      <pre className="pk-value">
        {props.value === undefined ? "undefined" : JSON.stringify(props.value)}
      </pre>
    </div>
  );
}

export function PickerPage(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const theme = (params.get("theme") as "light" | "dark" | "system" | null) ?? "system";
  const themeValue = useMemo(() => ({ colorMode: theme }), [theme]);
  const resolvedTheme =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [subject, setSubject] = useState<ValueExpr | undefined>({
    $tpl: "Welcome aboard, {{steps.loadContact.name}}!",
  });
  const [body, setBody] = useState<ValueExpr | undefined>({
    $tpl: "Hi {{steps.loadContact.name}},\n\nYour deal {{trigger.dealId}} is {{trigger.stage}}.",
  });
  const [to, setTo] = useState<ValueExpr | undefined>({ $ref: "steps.loadContact.email" });
  const [stale, setStale] = useState<ValueExpr | undefined>({
    $tpl: "Order {{steps.removedStep.id}} for {{steps.loadContact.email}}",
  });
  const [literal, setLiteral] = useState<ValueExpr | undefined>(
    "https://api.example.com/v1/{{not a ref}}",
  );
  const [empty, setEmpty] = useState<ValueExpr | undefined>(undefined);
  const [code, setCode] = useState(
    "const total = steps.fetchOrders.body.orders.length;\nreturn { total, vip: steps.loadContact.vip };\n",
  );
  const [picked, setPicked] = useState<string>("");
  const invalid = useMemo(() => new Set(["steps.removedStep.id"]), []);

  return (
    <FlowlineProvider client={client} theme={themeValue}>
      <div className="fl-root pk" data-fl-theme={theme} data-theme={resolvedTheme}>
        <PortalContainerContext.Provider value={portal}>
          <main className="pk-main">
            <section className="pk-panel" aria-label="Reference inputs">
              <h1 className="pk-title">Send email</h1>
              <Field label="Subject" value={subject}>
                <RefTextInput
                  ariaLabel="Subject"
                  value={subject}
                  onChange={setSubject}
                  scope={pickerScope}
                  samples={pickerSamples}
                />
              </Field>
              <Field label="To" hint="single reference" value={to}>
                <RefTextInput
                  ariaLabel="To"
                  singlePill
                  value={to}
                  onChange={setTo}
                  scope={pickerScope}
                  samples={pickerSamples}
                />
              </Field>
              <Field label="Body" hint="multi-line" value={body}>
                <RefTextInput
                  ariaLabel="Body"
                  multiline
                  value={body}
                  onChange={setBody}
                  scope={pickerScope}
                  samples={pickerSamples}
                />
              </Field>
              <Field label="Note" hint="stale reference" value={stale}>
                <RefTextInput
                  ariaLabel="Note"
                  value={stale}
                  onChange={setStale}
                  scope={pickerScope}
                  samples={pickerSamples}
                  invalidRefs={invalid}
                />
              </Field>
              <Field label="Reply-to" value={empty}>
                <RefTextInput
                  ariaLabel="Reply-to"
                  value={empty}
                  onChange={setEmpty}
                  scope={pickerScope}
                  samples={pickerSamples}
                  placeholder="Type or insert data…"
                />
              </Field>
              <Field label="Endpoint" hint="literal only" value={literal}>
                <RefTextInput
                  ariaLabel="Endpoint"
                  literalOnly
                  value={literal}
                  onChange={setLiteral}
                  scope={pickerScope}
                  samples={pickerSamples}
                />
              </Field>
              <Field label="Read-only" value={subject}>
                <RefTextInput
                  ariaLabel="Read-only subject"
                  readOnly
                  value={subject}
                  onChange={() => {}}
                  scope={pickerScope}
                  samples={pickerSamples}
                />
              </Field>
              <Field label="Code" hint="transform" value={code}>
                <CodeEditor ariaLabel="Code" value={code} onChange={setCode} scope={pickerScope} />
              </Field>
            </section>
            <section className="pk-panel pk-panel--picker" aria-label="Standalone data picker">
              <h2 className="pk-title">DataPicker</h2>
              <div className="pk-picker">
                <DataPicker
                  scope={pickerScope}
                  samples={pickerSamples}
                  onPick={(ref, type) => setPicked(`${ref} : ${type}`)}
                />
              </div>
              <pre className="pk-value">{picked || "Pick a field"}</pre>
              <h2 className="pk-title">Empty scope</h2>
              <div className="pk-picker">
                <DataPicker scope={[]} samples={{}} onPick={() => {}} />
              </div>
            </section>
          </main>
        </PortalContainerContext.Provider>
        <div ref={setPortal} className="fl-portal" />
      </div>
    </FlowlineProvider>
  );
}
