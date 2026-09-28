/**
 * Run status changes, shared between the views of one client: when `useRun` (and so
 * `<RunViewer>`) or `<RunList>` sees a run in a new status, the others hear of it at once instead
 * of at their next poll. Cancelling a run in the viewer updates the list right away.
 *
 * @module
 */
import type { RunSummary } from "@flowkit/core";
import type { FlowkitClient } from "@flowkit/core/client";

/** The fields of a run a status change carries. */
export type RunChange = Pick<
  RunSummary,
  "id" | "workflowId" | "status" | "updatedAt" | "createdAt" | "stoppedAt"
>;

type Listener = (run: RunChange) => void;

interface Bus {
  listeners: Set<Listener>;
  /** Last published status key per run ID. */
  seen: Map<string, string>;
}

const buses = new WeakMap<FlowkitClient, Bus>();

function busOf(client: FlowkitClient): Bus {
  let bus = buses.get(client);
  if (!bus) {
    bus = { listeners: new Set(), seen: new Map() };
    buses.set(client, bus);
  }
  return bus;
}

const keyOf = (run: RunChange) => `${run.status}|${run.stoppedAt ?? ""}`;

/**
 * Tell `client`'s listeners about `run`, if its status (or `stoppedAt`) differs from the last one
 * published for it. With `onlyIfKnown`, a run never published before is only remembered: a list
 * loading its rows is not news to anyone.
 * @internal
 */
export function publishRunChange(
  client: FlowkitClient,
  run: RunChange,
  opts: { onlyIfKnown?: boolean } = {},
): void {
  const bus = busOf(client);
  const key = keyOf(run);
  const last = bus.seen.get(run.id);
  if (last === key) return;
  bus.seen.set(run.id, key);
  if (last === undefined && opts.onlyIfKnown) return;
  for (const l of [...bus.listeners]) l(run);
}

/** Subscribe to `client`'s run status changes; returns the unsubscribe function. @internal */
export function subscribeRunChanges(client: FlowkitClient, listener: Listener): () => void {
  const bus = busOf(client);
  bus.listeners.add(listener);
  return () => bus.listeners.delete(listener);
}
