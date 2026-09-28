import type { RunEvent, RunStatus } from "@flowkit/core";
import { Ban, Check, CircleStop, Clock, LoaderCircle, X } from "lucide-react";
import type { JSX } from "react";
import { useFlowkitAppearance } from "../provider";

/** How a run reads to people: its status, plus "stopped" (completed by a Stop step) and "cancelling". */
export type RunDisplayState = RunStatus | "stopped" | "cancelling";

/** Whether a run can no longer change. */
export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** The display state of a run with these events. */
export function displayState(
  status: RunStatus,
  events: RunEvent[] | undefined,
  cancelling = false,
): RunDisplayState {
  if (cancelling && !isTerminal(status)) return "cancelling";
  if (status === "completed" && events?.some((e) => e.type === "run.stopped")) return "stopped";
  return status;
}

const ICON = {
  queued: <Clock size={12} strokeWidth={2.5} aria-hidden />,
  running: <LoaderCircle size={12} strokeWidth={2.5} className="fk-spin" aria-hidden />,
  waiting: <Clock size={12} strokeWidth={2.5} aria-hidden />,
  completed: <Check size={12} strokeWidth={3} aria-hidden />,
  stopped: <CircleStop size={12} strokeWidth={2.5} aria-hidden />,
  failed: <X size={12} strokeWidth={3} aria-hidden />,
  cancelled: <Ban size={12} strokeWidth={2.5} aria-hidden />,
  cancelling: <LoaderCircle size={12} strokeWidth={2.5} className="fk-spin" aria-hidden />,
} satisfies Record<RunDisplayState, JSX.Element>;

/** The display name of a run state. */
export function useRunStateName(): (state: RunDisplayState) => string {
  const { labels } = useFlowkitAppearance();
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
    <span className="fk-run-chip" data-state={state} data-size={size}>
      {ICON[state]}
      <span>{name(state)}</span>
    </span>
  );
}
