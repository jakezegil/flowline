import type { RunEvent, RunEventType } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import { runEventStream } from "./sse";
import type { StorageAdapter } from "./storage";

const ev = (seq: number, type: RunEventType): RunEvent =>
  ({ seq, type, runId: "r1", tenantId: "a", ts: seq, data: {} }) as unknown as RunEvent;

describe("runEventStream", () => {
  it("does not close on a stale snapshot once the bus sent a newer non-terminal event", async () => {
    const history = [
      ev(1, "run.started"),
      ev(2, "step.started"),
      ev(3, "step.failed"),
      ev(4, "run.failed"),
    ];
    let releaseFirst: (events: RunEvent[]) => void = () => {};
    let calls = 0;
    const storage = {
      listEvents: () => {
        calls++;
        if (calls === 1) return new Promise<RunEvent[]>((r) => (releaseFirst = r));
        return Promise.resolve([...history, ev(5, "run.resumed")]);
      },
    } as unknown as StorageAdapter;
    let push: (e: RunEvent) => void = () => {};
    const res = runEventStream({
      storage,
      subscribe: (_runId, fn) => {
        push = fn;
        return () => {};
      },
      tenantId: "a",
      runId: "r1",
      after: 0,
      pollMs: 60_000,
      heartbeatMs: 60_000,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // The retry commits while the first read is in flight: the bus delivers 1-5.
    for (const e of [...history, ev(5, "run.resumed")]) push(e);
    releaseFirst(history);
    const decoder = new TextDecoder();
    let text = "";
    let done = false;
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (next === null) break;
      if (next.done) {
        done = true;
        break;
      }
      text += decoder.decode(next.value);
    }
    expect(text).toContain("id: 5\n");
    expect(done).toBe(false);
    await reader.cancel();
  });
});
