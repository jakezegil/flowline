import { testNode } from "@flowkit/engine/testing";
import { describe, expect, it } from "vitest";
import { type Message, main, notify } from "./main";

const silent = () => {};

describe("headless example", () => {
  it("notifies a VIP user and completes", async () => {
    const { status, events, outbox } = await main({ userId: "u1", log: silent });

    expect(status).toBe("completed");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: "ada@example.com", text: "Welcome back, Ada!" });
    expect(outbox[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(events.map((e) => [e.type, e.stepPath])).toContainEqual([
      "step.completed",
      "check/if/notify",
    ]);
  });

  it("stops without notifying a regular user", async () => {
    const { status, events, outbox } = await main({ userId: "u2", log: silent });

    expect(status).toBe("completed");
    expect(outbox).toEqual([]);
    expect(events.at(-1)?.type).toBe("run.stopped");
  });

  it("prints the run status and a seq/type/stepPath audit log", async () => {
    const lines: string[] = [];
    await main({ userId: "u1", log: (line) => lines.push(line) });

    expect(lines[0]).toMatch(/^Run \S+ completed$/);
    expect(lines).toContainEqual(expect.stringMatching(/^\s+1 run\.started\s*$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\s*\d+ step\.completed\s+lookupUser$/));
    expect(lines.slice(-2)).toEqual(["Outbox (1)", "  to ada@example.com: Welcome back, Ada!"]);
  });

  it("prints why a run failed", async () => {
    const lines: string[] = [];
    const { status } = await main({ userId: "nobody", log: (line) => lines.push(line) });

    expect(status).toBe("failed");
    expect(lines[0]).toMatch(/^Run \S+ failed: No user nobody$/);
  });

  it("notify sends once per idempotency key, however often the step runs", async () => {
    const outbox: Message[] = [];
    const services = { users: new Map(), outbox };
    const input = { to: "ada@example.com", text: "Hi" };

    await testNode(notify, input, { services, idempotencyKey: "run-1:notify" });
    await testNode(notify, input, { services, idempotencyKey: "run-1:notify" }); // a retry
    await testNode(notify, input, { services, idempotencyKey: "run-2:notify" });

    expect(outbox.map((m) => m.idempotencyKey)).toEqual(["run-1:notify", "run-2:notify"]);
  });
});
