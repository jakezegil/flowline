/**
 * `TestStep`: runs one step against the sample data of the trigger and earlier steps
 * (`client.testStep`), shows its resolved input and its output or error, and keeps a successful
 * output as the step's sample for the data pickers of later steps.
 *
 * @module
 */
import {
  availableScope,
  branchesFor,
  collectRefs,
  parseRefPath,
  resolveValue,
  type TestStepResponse,
  type ValueExpr,
} from "@flowkit/core";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FlaskConical,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore, useEditorStoreApi, useStep } from "../hooks";
import { useFlowkit, useFlowkitAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { JsonTree } from "../ui/json-tree";
import { errorText } from "../ui/primitives";

type Result = { response: TestStepResponse } | { error: string };

/** Step IDs (and `"trigger"`) that `config` references. */
function referencedSources(config: Record<string, ValueExpr>): Set<string> {
  const out = new Set<string>();
  for (const ref of collectRefs(config)) {
    try {
      const p = parseRefPath(ref);
      if (p.root === "trigger") out.add(TRIGGER_KEY);
      else if (p.root === "steps" && p.stepId) out.add(p.stepId);
    } catch {
      // Bad syntax is reported by the validator.
    }
  }
  return out;
}

/** The step's input resolved against the samples, or `undefined` if it can't be resolved. */
function resolveInput(
  config: Record<string, ValueExpr>,
  samples: Record<string, unknown>,
): unknown {
  const { [TRIGGER_KEY]: trigger, ...steps } = samples;
  try {
    return resolveValue(config, { trigger, steps, run: { id: "test" } });
  } catch {
    return undefined;
  }
}

/** Test state line: tested, needs a new test (and why), or never tested. */
function TestStatus({ stepId }: { stepId: string }): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const info = useStep(stepId);
  const sampleType = useEditorStore((s) => s.sampleTypes[stepId]);
  const typeChanged =
    sampleType !== undefined && info !== undefined && sampleType !== info.step.type;
  const state = typeChanged ? "needs-test" : info?.testState;
  if (state === "tested") {
    return (
      <p className="fk-test__status" data-tone="success">
        <CircleCheck size={14} aria-hidden />
        {labels.tested}
      </p>
    );
  }
  if (state === "needs-test") {
    return (
      <p className="fk-test__status" data-tone="warning">
        <TriangleAlert size={14} aria-hidden />
        <span>
          <strong>{labels.needsRetest}</strong>
          <span className="fk-test__why">
            {typeChanged ? labels.sampleTypeChanged : labels.needsTest}
          </span>
        </span>
      </p>
    );
  }
  return (
    <p className="fk-test__status">
      <CircleDashed size={14} aria-hidden />
      {labels.notTested}
    </p>
  );
}

/**
 * Tests the step `stepId` of the editor's workflow: shows the input it would get (resolved
 * against the samples), a "Test step" button, and the output or error. A successful output
 * becomes the step's sample (and marks it tested). Warns when referenced upstream steps or the
 * trigger have no sample yet, since their references would resolve to nothing.
 */
export function TestStep({ stepId }: { stepId: string }): JSX.Element | null {
  const { client } = useFlowkit();
  const { labels } = useFlowkitAppearance();
  const store = useEditorStoreApi();
  const info = useStep(stepId);
  const doc = useEditorStore((s) => s.doc);
  const manifest = useEditorStore((s) => s.manifest);
  const ctx = useEditorStore((s) => s.ctx);
  const samples = useEditorStore((s) => s.samples);
  const select = useEditorStore((s) => s.select);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const config = info?.step.config;
  const scope = useMemo(
    () => availableScope(doc, stepId, manifest, ctx),
    [doc, stepId, manifest, ctx],
  );
  const missing = useMemo(() => {
    if (!config) return [];
    const sources = referencedSources(config);
    return scope.filter((e) => {
      const key = e.kind === "trigger" ? TRIGGER_KEY : e.kind === "step" ? e.stepId : undefined;
      return key !== undefined && sources.has(key) && samples[key] === undefined;
    });
  }, [config, scope, samples]);
  const input = useMemo(
    () => (config ? resolveInput(config, samples) : undefined),
    [config, samples],
  );

  if (!info) return null;
  const { step } = info;

  const run = async () => {
    setBusy(true);
    try {
      const { doc: current, samples: all } = store.getState();
      const { [TRIGGER_KEY]: triggerSample, ...stepSamples } = all;
      const response = await client.testStep({
        step,
        doc: current,
        samples: stepSamples,
        ...(triggerSample !== undefined ? { triggerSample } : {}),
      });
      if (response.ok) store.getState().setSample(stepId, response.output);
      if (alive.current) setResult({ response });
    } catch (err) {
      if (alive.current) setResult({ error: labels.testFailed(errorText(err)) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const response = result && "response" in result ? result.response : undefined;
  const failed = result !== null && ("error" in result || response?.ok === false);
  const errorMessage = result && "error" in result ? result.error : response?.error;
  const branchLabel = (id: string) =>
    (info.manifest ? branchesFor(info.manifest, step) : []).find((b) => b.id === id)?.label ?? id;
  const lastSample = samples[stepId];

  return (
    <div className="fk-test">
      <div className="fk-test__top">
        <TestStatus stepId={stepId} />
        <button
          type="button"
          className="fk-btn fk-btn--primary"
          onClick={() => void run()}
          aria-disabled={busy || undefined}
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle size={14} className="fk-spin" aria-hidden />
          ) : (
            <FlaskConical size={14} aria-hidden />
          )}
          {busy
            ? labels.testing
            : result || lastSample !== undefined
              ? labels.testAgain
              : labels.testStep}
        </button>
      </div>
      <p className="fk-test__intro">{labels.testIntro}</p>

      {missing.length > 0 && (
        <div className="fk-callout" data-tone="warning" role="note">
          <TriangleAlert size={15} aria-hidden />
          <div>
            <p className="fk-callout__title">{labels.upstreamUntested}</p>
            <p>{labels.upstreamList(missing.map((e) => e.label))}</p>
            <div className="fk-callout__actions">
              {missing.map((e) => (
                <button
                  key={e.refBase}
                  type="button"
                  className="fk-btn fk-btn--sm"
                  onClick={() => select(e.kind === "trigger" ? TRIGGER_KEY : (e.stepId ?? null))}
                >
                  {e.kind === "trigger" ? labels.addTriggerSample : e.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <section className="fk-test__section" aria-label={labels.testInput}>
        <h3 className="fk-section-title">{labels.testInput}</h3>
        <JsonTree value={response?.input ?? input ?? {}} label={labels.testInput} />
      </section>

      {result && (
        <section
          className="fk-test__section"
          aria-label={failed ? labels.testError : labels.testOutput}
          aria-live="polite"
        >
          <h3 className="fk-section-title">
            {failed ? labels.testError : labels.testOutput}
            {response && (
              <span className="fk-section-title__meta">
                {labels.testDuration(response.durationMs)}
              </span>
            )}
          </h3>
          {failed ? (
            <div className="fk-callout" data-tone="danger" role="alert">
              <CircleAlert size={15} aria-hidden />
              <p className="fk-callout__mono">{errorMessage}</p>
            </div>
          ) : (
            <>
              {(response?.branch || response?.signal) && (
                <p className="fk-test__facts">
                  {response.branch && (
                    <span>{labels.testBranch(branchLabel(response.branch))}</span>
                  )}
                  {response.signal && <span>{labels.testSignal[response.signal]}</span>}
                </p>
              )}
              <JsonTree value={response?.output ?? null} label={labels.testOutput} />
            </>
          )}
        </section>
      )}

      {!result && lastSample !== undefined && (
        <section className="fk-test__section" aria-label={labels.testSample}>
          <h3 className="fk-section-title">{labels.testSample}</h3>
          <JsonTree value={lastSample} label={labels.testSample} />
        </section>
      )}
    </div>
  );
}
