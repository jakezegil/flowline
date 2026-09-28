/**
 * Dev playground: `pnpm --filter @flowkit/react playground`. URL params pick the state, so the
 * screenshot script can drive it: `?theme=light|dark|system&doc=nested|empty&mode=edit|readonly|run`.
 */
import type { FlowkitClient } from "@flowkit/core/client";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createEditorStore, FlowkitProvider, type RunOverlay, WorkflowCanvas } from "../src/index";
import "../src/styles.css";
import { emptyDoc, manifest, nestedDoc } from "./fixtures";

type Theme = "light" | "dark" | "system";
type DocName = "nested" | "empty";
type Mode = "edit" | "readonly" | "run";

const params = new URLSearchParams(location.search);
const initial = {
  theme: (params.get("theme") as Theme | null) ?? "system",
  doc: (params.get("doc") as DocName | null) ?? "nested",
  mode: (params.get("mode") as Mode | null) ?? "edit",
};

const client = {} as FlowkitClient;

const runOverlay: RunOverlay = {
  stepStatus: {
    loadContact: { status: "done", durationMs: 182 },
    isWon: { status: "done", durationMs: 4 },
    region: { status: "done", durationMs: 2 },
    welcomeEmea: { status: "done", durationMs: 1320, attempts: 3 },
    markCustomer: { status: "done", durationMs: 95 },
    eachTag: { status: "failed", durationMs: 640 },
    addTag: { status: "failed", durationMs: 210, attempts: 2 },
    notify: { status: "pending" },
    wait: { status: "skipped" },
    nudge: { status: "skipped" },
  },
  takenEdges: new Set(["step:isWon->step:region", "step:region->step:welcomeEmea"]),
  // The loop failed on its third tag; that iteration is shown.
  loopIteration: { eachTag: { index: 2, count: 4, failedIndex: 2 } },
};

function setParam(key: string, value: string) {
  const url = new URL(location.href);
  url.searchParams.set(key, value);
  history.replaceState(null, "", url);
}

function Select<T extends string>(props: {
  label: string;
  value: T;
  options: T[];
  onChange(v: T): void;
}) {
  return (
    <label className="pg-field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

function App() {
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [docName, setDocName] = useState<DocName>(initial.doc);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [clicked, setClicked] = useState<string | null>(null);
  const store = useMemo(() => {
    const doc = docName === "nested" ? nestedDoc() : emptyDoc();
    const s = createEditorStore({ doc, manifest });
    if (docName === "nested") {
      s.getState().setSample("loadContact", { id: "c_1", name: "Ada", email: "ada@example.com" });
      s.getState().setSample("markCustomer", { id: "c_1" });
      s.getState().setConfig("markCustomer", "stage", "customer ");
    }
    return s;
  }, [docName]);
  const themeValue = useMemo(() => ({ colorMode: theme }), [theme]);
  const [overlay, setOverlay] = useState(runOverlay);

  return (
    <FlowkitProvider client={client} theme={themeValue}>
      <div className="pg" data-theme={theme}>
        <header className="pg-bar">
          <strong>Flowkit canvas</strong>
          <Select
            label="Theme"
            value={theme}
            options={["system", "light", "dark"]}
            onChange={(v) => {
              setTheme(v);
              setParam("theme", v);
            }}
          />
          <Select
            label="Workflow"
            value={docName}
            options={["nested", "empty"]}
            onChange={(v) => {
              setDocName(v);
              setParam("doc", v);
            }}
          />
          <Select
            label="Mode"
            value={mode}
            options={["edit", "readonly", "run"]}
            onChange={(v) => {
              setMode(v);
              setParam("mode", v);
            }}
          />
          <span className="pg-log">{clicked ? `Opened: ${clicked}` : ""}</span>
        </header>
        <main className="pg-canvas">
          <WorkflowCanvas
            key={docName}
            store={store}
            readOnly={mode !== "edit"}
            {...(mode === "run"
              ? {
                  overlay: {
                    ...overlay,
                    onIterationChange: (id, index) =>
                      setOverlay((o) => ({
                        ...o,
                        loopIteration: {
                          ...o.loopIteration,
                          [id]: { ...(o.loopIteration[id] ?? { count: 0 }), index },
                        },
                      })),
                  },
                }
              : {})}
            onStepClick={setClicked}
          />
        </main>
      </div>
    </FlowkitProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
