import type { RunStatus, RunSummary } from "@flowlinejs/core";
import { Ban, Check, CircleStop, Clock, LoaderCircle, X } from "lucide-react";
import type { JSX } from "react";
import { useFlowlineAppearance } from "../provider";

/** How a run reads to people: its status, plus "stopped" (completed by a Stop step) and "cancelling". */
export type RunDisplayState = RunStatus | "stopped" | "cancelling";

/** Whether a run can no longer change. */
export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * The display state of a run (a summary or a run detail's `run`): "stopped" when a Stop step
 * ended it (`stoppedAt`, the same derivation for RunList and RunViewer).
 */
export function displayState(
  run: Pick<RunSummary, "status" | "stoppedAt">,
  cancelling = false,
): RunDisplayState {
  if (cancelling && !isTerminal(run.status)) return "cancelling";
  if (run.status === "completed" && run.stoppedAt !== undefined) return "stopped";
  return run.status;
}

const ICON = {
  queued: <Clock size={12} strokeWidth={2.5} aria-hidden />,
  running: <LoaderCircle size={12} strokeWidth={2.5} className="fl-spin" aria-hidden />,
  waiting: <Clock size={12} strokeWidth={2.5} aria-hidden />,
  completed: <Check size={12} strokeWidth={3} aria-hidden />,
  stopped: <CircleStop size={12} strokeWidth={2.5} aria-hidden />,
  failed: <X size={12} strokeWidth={3} aria-hidden />,
  cancelled: <Ban size={12} strokeWidth={2.5} aria-hidden />,
  cancelling: <LoaderCircle size={12} strokeWidth={2.5} className="fl-spin" aria-hidden />,
} satisfies Record<RunDisplayState, JSX.Element>;

/** The display name of a run state. */
export function useRunStateName(): (state: RunDisplayState) => string {
  const { labels } = useFlowlineAppearance();
  return (state) =>
    state === "stopped"
      ? labels.runStopped
      : state === "cancelling"
        ? labels.cancelling
        : labels.runState[state];
}

/** A run status chip: colored icon and name. `size="lg"` for the run viewer's header. */
export function RunStateChip({
  state,
  size = "md",
}: {
  state: RunDisplayState;
  size?: "md" | "lg";
}): JSX.Element {
  const name = useRunStateName();
  return (
    <span className="fl-run-chip" data-state={state} data-size={size}>
      {ICON[state]}
      <span>{name(state)}</span>
    </span>
  );
}
