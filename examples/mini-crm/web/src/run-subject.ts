/**
 * What a run is about, for the run list: the contact or deal (or webhook lead) its trigger
 * carried, so sixteen "Lead intake" rows can be told apart. The list only has run summaries, so
 * each run's trigger is fetched once (a trigger never changes) and cached for the page's life.
 *
 * Each fetch is a full run detail (journal and events included), not a small read, so the store
 * keeps it cheap: one request per run at a time, at most {@link SubjectStoreOptions.concurrency}
 * in flight, a failed run retried only after a growing backoff, and a bounded cache. A real app
 * would store the subject on the run summary instead, so the list needs no per-row reads.
 *
 * @module
 */
import type { RunSummary } from "@flowlinejs/core/client";
import { useCallback, useEffect, useState } from "react";
import { flowline } from "./api";

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

/** Tuning for {@link createSubjectStore}. */
export interface SubjectStoreOptions {
  /** Loads a run's trigger payload. */
  fetchTrigger: (runId: string) => Promise<unknown>;
  /** Most fetches in flight at once. Default 4. */
  concurrency?: number;
  /** Wait before retrying a failed run; doubles per failure up to 16x. Default 30 s. */
  retryMs?: number;
  /** Most subjects kept; the least recently used go first. Default 500. */
  maxEntries?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Runs `fn` after the current render, for tests. */
  schedule?: (fn: () => void) => void;
}

/** A subject cache with deduped, rate-capped fetches. */
export interface SubjectStore {
  /** The run's subject: a string, `null` when it has none, `undefined` when not loaded (yet). */
  get(runId: string): string | null | undefined;
  /** {@link get}, queueing a fetch when the subject is unknown and not backing off. */
  request(runId: string): string | null | undefined;
  /** Called after each loaded subject. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Build a {@link SubjectStore}. The app uses one per page load; tests make their own. */
export function createSubjectStore(options: SubjectStoreOptions): SubjectStore {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const retryMs = options.retryMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 500;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn) => setTimeout(fn, 0));

  /** Subject per run ID, in least-recently-used order. */
  const cache = new Map<string, string | null>();
  /** Failed runs: when they may be retried, and how many times they failed. */
  const failed = new Map<string, { retryAt: number; failures: number }>();
  const pending = new Set<string>();
  const queue: string[] = [];
  const listeners = new Set<() => void>();
  let active = 0;
  let scheduled = false;

  const touch = (id: string, value: string | null) => {
    cache.delete(id);
    cache.set(id, value);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  };

  const pump = () => {
    scheduled = false;
    while (active < concurrency && queue.length > 0) {
      const id = queue.shift() as string;
      active++;
      options.fetchTrigger(id).then(
        (trigger) => {
          failed.delete(id);
          touch(id, subjectOf(trigger) ?? null);
          settle(id);
          for (const l of listeners) l();
        },
        () => {
          const failures = (failed.get(id)?.failures ?? 0) + 1;
          failed.set(id, { retryAt: now() + retryMs * 2 ** Math.min(failures - 1, 4), failures });
          while (failed.size > maxEntries) failed.delete(failed.keys().next().value as string);
          settle(id);
        },
      );
    }
  };

  const settle = (id: string) => {
    pending.delete(id);
    active--;
    pump();
  };

  return {
    get(id) {
      const hit = cache.get(id);
      if (hit !== undefined) touch(id, hit);
      return hit;
    },
    request(id) {
      const hit = this.get(id);
      if (hit !== undefined || pending.has(id)) return hit;
      const f = failed.get(id);
      if (f && now() < f.retryAt) return undefined;
      pending.add(id);
      queue.push(id);
      // Called while rendering the list: fetch after it.
      if (!scheduled) {
        scheduled = true;
        schedule(pump);
      }
      return undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const store = createSubjectStore({
  fetchTrigger: async (id) => (await flowline.getRun(id)).run.trigger,
});

/**
 * `describeRun` for `<RunList>`: the run's subject once its trigger is loaded (the row fills in a
 * moment later), else nothing.
 */
export function useRunSubjects(): (run: RunSummary) => string | undefined {
  const [version, setVersion] = useState(0);
  useEffect(() => store.subscribe(() => setVersion((v) => v + 1)), []);
  // A new function per loaded subject, so the list re-renders its rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` marks a cache update.
  return useCallback((run: RunSummary) => store.request(run.id) ?? undefined, [version]);
}
