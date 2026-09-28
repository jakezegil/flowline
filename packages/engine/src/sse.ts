/**
 * Live run events: the in-process event bus behind `engine.subscribe`, and the server-sent event
 * stream of `GET /runs/:id/stream`.
 *
 * @module
 */
import type { Logger, RunEvent, RunEventType } from "@flowlinejs/core";
import type { NewRunEvent, StorageAdapter } from "./storage";

/** Event types after which a run emits nothing more (until a retry). */
const TERMINAL_EVENTS: ReadonlySet<RunEventType> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stopped",
]);

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

/** @internal The in-process pub/sub fed by the engine's commits. */
export interface RunBus {
  /** Report an event this process persisted. */
  notify(e: NewRunEvent): void;
  /** See `Engine.subscribe`. */
  subscribe(runId: string, fn: (e: RunEvent) => void): () => void;
}

interface Listener {
  fn: (e: RunEvent) => void;
  lastSeq: number;
}

/**
 * @internal Create a run bus. Persisted events carry no `seq` until storage assigns one, so a
 * notification makes the bus read the run's events back from storage and hand each listener the
 * ones it has not seen, in `seq` order. Reads are coalesced per run.
 */
export function createRunBus(storage: StorageAdapter, logger?: Logger): RunBus {
  const listeners = new Map<string, Set<Listener>>();
  /** Runs with a read in flight; `true` when another notification arrived meanwhile. */
  const reading = new Map<string, boolean>();

  const deliver = (runId: string, events: RunEvent[]) => {
    for (const listener of listeners.get(runId) ?? []) {
      for (const e of events) {
        if (e.seq <= listener.lastSeq) continue;
        listener.lastSeq = e.seq;
        try {
          listener.fn(e);
        } catch (err) {
          logger?.error("run event listener threw", {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  };

  const read = async (tenantId: string, runId: string) => {
    do {
      reading.set(runId, false);
      try {
        deliver(runId, await storage.listEvents(tenantId, runId));
      } catch (err) {
        logger?.warn("reading run events failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } while (reading.get(runId) === true && listeners.has(runId));
    reading.delete(runId);
  };

  return {
    notify(e) {
      if (!listeners.has(e.runId)) return;
      if (reading.has(e.runId)) {
        reading.set(e.runId, true);
        return;
      }
      void read(e.tenantId, e.runId);
    },
    subscribe(runId, fn) {
      const listener: Listener = { fn, lastSeq: 0 };
      let set = listeners.get(runId);
      if (!set) {
        set = new Set();
        listeners.set(runId, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(runId);
        current?.delete(listener);
        if (current?.size === 0) listeners.delete(runId);
      };
    },
  };
}

/** @internal Inputs of {@link runEventStream}. */
export interface RunEventStreamArgs {
  storage: StorageAdapter;
  subscribe: RunBus["subscribe"];
  tenantId: string;
  runId: string;
  /** Only events with a greater `seq` are sent. */
  after: number;
  /** Aborting it ends the stream (the client went away). */
  signal?: AbortSignal;
  logger?: Logger;
  /** Storage polling interval. Default 1 s. */
  pollMs?: number;
  /** Interval of `:` heartbeat comments. Default 15 s. */
  heartbeatMs?: number;
}

/**
 * @internal The `text/event-stream` response of `GET /runs/:id/stream`: one `event: run` frame
 * (`id: <seq>`, `data: <RunEvent JSON>`) per event with `seq > after`, in order and at most once.
 * Events come from the in-process bus (fast path) and from polling storage, so a worker in another
 * process is seen too. The stream ends once the run's latest event is terminal (`run.completed`,
 * `run.failed`, `run.cancelled`, `run.stopped`), including when that event was sent before
 * `after`. An earlier terminal event that a retry moved past does not end it.
 */
export function runEventStream(a: RunEventStreamArgs): Response {
  const encoder = new TextEncoder();
  let lastSent = a.after;
  let closed = false;
  let polling = false;
  const cleanups: (() => void)[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        if (closed) return;
        closed = true;
        for (const fn of cleanups) fn();
      };
      const close = () => {
        if (closed) return;
        stop();
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by the consumer.
        }
      };
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      /** Sends the events not sent yet; `true` when one of them is terminal. */
      const send = (events: RunEvent[]): boolean => {
        let terminal = false;
        for (const e of events) {
          if (closed) return false;
          if (e.seq <= lastSent || e.runId !== a.runId || e.tenantId !== a.tenantId) continue;
          write(`event: run\nid: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          lastSent = e.seq;
          if (TERMINAL_EVENTS.has(e.type)) terminal = true;
        }
        return terminal;
      };
      // A terminal event ends the stream only while it is the run's latest event: a retried run
      // continues after its old `run.failed`. Only a full read of the log can tell, so the stream
      // closes from `poll`, and a terminal event from the bus triggers an immediate poll.
      let repoll = false;
      const poll = async (): Promise<void> => {
        if (closed) return;
        if (polling) {
          repoll = true;
          return;
        }
        polling = true;
        try {
          const events = await a.storage.listEvents(a.tenantId, a.runId);
          send(events);
          const last = events[events.length - 1];
          // Nothing newer than the snapshot may have been sent: the bus can be ahead of a slow read,
          // and then the snapshot's terminal event is no longer the run's latest.
          if (last && TERMINAL_EVENTS.has(last.type) && lastSent === Math.max(last.seq, a.after)) {
            close();
          }
        } catch (err) {
          a.logger?.warn("run stream poll failed", {
            runId: a.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          polling = false;
        }
        if (repoll) {
          repoll = false;
          await poll();
        }
      };

      cleanups.push(
        a.subscribe(a.runId, (e) => {
          if (send([e])) void poll();
        }),
      );
      const pollTimer = setInterval(poll, a.pollMs ?? DEFAULT_POLL_MS);
      const heartbeat = setInterval(
        () => write(": ping\n\n"),
        a.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      );
      cleanups.push(
        () => clearInterval(pollTimer),
        () => clearInterval(heartbeat),
      );
      if (a.signal) {
        if (a.signal.aborted) return close();
        const onAbort = () => close();
        a.signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => a.signal?.removeEventListener("abort", onAbort));
      }
      void poll();
    },
    cancel() {
      if (closed) return;
      closed = true;
      for (const fn of cleanups) fn();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
