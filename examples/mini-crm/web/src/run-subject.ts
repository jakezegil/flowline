/**
 * What a run is about, for the run list: the contact or deal (or webhook lead) its trigger
 * carried, so sixteen "Lead intake" rows can be told apart. The list only has run summaries, so
 * each run's trigger is fetched once (a trigger never changes) and cached for the page's life.
 *
 * @module
 */
import type { RunSummary } from "@flowkit/core/client";
import { useCallback, useEffect, useState } from "react";
import { flowkit } from "./api";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A short label for a trigger payload: a contact's email (or name), a deal's name, or a flat
 * payload's email, name or company (a webhook or manual run). `undefined` when there is none.
 */
export function subjectOf(trigger: unknown): string | undefined {
  if (typeof trigger !== "object" || trigger === null) return undefined;
  const t = trigger as Record<string, unknown>;
  const contact = t.contact as Record<string, unknown> | undefined;
  if (contact && typeof contact === "object") {
    const name = [str(contact.firstName), str(contact.lastName)].filter(Boolean).join(" ");
    return str(contact.email) ?? (name || undefined);
  }
  const deal = t.deal as Record<string, unknown> | undefined;
  if (deal && typeof deal === "object") return str(deal.name);
  // A webhook run's payload is `{ body, headers }`.
  if (typeof t.body === "object" && t.body !== null && "headers" in t) return subjectOf(t.body);
  const name = [str(t.firstName), str(t.lastName)].filter(Boolean).join(" ");
  return str(t.email) ?? str(t.name) ?? (name || undefined) ?? str(t.company);
}

/** Subject per run ID (`null`: the run's trigger has none). */
const cache = new Map<string, string | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let queued: string[] = [];
let scheduled = false;

function flush() {
  scheduled = false;
  const ids = queued;
  queued = [];
  for (const id of ids) {
    flowkit.getRun(id).then(
      (d) => {
        cache.set(id, subjectOf(d.run.trigger) ?? null);
        inflight.delete(id);
        for (const l of listeners) l();
      },
      () => inflight.delete(id),
    );
  }
}

function request(id: string) {
  if (cache.has(id) || inflight.has(id)) return;
  inflight.add(id);
  queued.push(id);
  // Called while rendering the list: fetch after it.
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

/**
 * `describeRun` for `<RunList>`: the run's subject once its trigger is loaded (the row fills in a
 * moment later), else nothing.
 */
export function useRunSubjects(): (run: RunSummary) => string | undefined {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  // A new function per loaded subject, so the list re-renders its rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` marks a cache update.
  return useCallback(
    (run: RunSummary) => {
      const hit = cache.get(run.id);
      if (hit === undefined) request(run.id);
      return hit ?? undefined;
    },
    [version],
  );
}
