import type { Logger } from "@flowline/core";
import { describe, expect, it, vi } from "vitest";
import type { EngineCore } from "./engine";
import { publishTriggerEvent, type TriggerEvent } from "./trigger-events";

/** A minimal {@link EngineCore} stub: only `opts` and `logger` matter to `publishTriggerEvent`. */
function fakeCore(logger: Logger, onTriggerEvent?: (e: TriggerEvent) => void): EngineCore {
  return {
    opts: { registry: undefined as never, storage: undefined as never, onTriggerEvent },
    registry: undefined as never,
    storage: undefined as never,
    clock: () => 0,
    logger,
    event: () => {
      throw new Error("not used");
    },
    publish: () => {
      throw new Error("not used");
    },
    triggerEvent: () => {
      throw new Error("not used");
    },
  };
}

const rejected: TriggerEvent = {
  type: "trigger.rejected",
  at: 1,
  tenantId: "t1",
  workflowId: "wf",
  version: 1,
  source: { kind: "event", event: "deal.updated" },
  message: "boom",
  issues: [{ code: "config.invalid", severity: "error", message: "boom" }],
};

const deduped: TriggerEvent = {
  type: "trigger.deduped",
  at: 1,
  tenantId: "t1",
  workflowId: "wf",
  runId: "run_1",
  key: "event:wf:evt_1",
  source: { kind: "event", event: "deal.updated" },
};

const pollFailed: TriggerEvent = {
  type: "poll.failed",
  at: 1,
  tenantId: "t1",
  workflowId: "wf",
  since: 0,
  until: 10,
  message: "storage exploded",
  nextAt: 20,
};

const pollCompleted: TriggerEvent = {
  type: "poll.completed",
  at: 1,
  tenantId: "t1",
  workflowId: "wf",
  since: 0,
  until: 10,
  items: 3,
  started: 2,
  rejected: 1,
};

describe("publishTriggerEvent", () => {
  it("logs trigger.rejected at warn and calls onTriggerEvent", () => {
    const warn = vi.fn();
    const onTriggerEvent = vi.fn();
    publishTriggerEvent(
      fakeCore({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, onTriggerEvent),
      rejected,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onTriggerEvent).toHaveBeenCalledWith(rejected);
  });

  it("logs poll.failed at warn", () => {
    const warn = vi.fn();
    publishTriggerEvent(
      fakeCore({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
      pollFailed,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not log trigger.deduped or poll.completed at warn", () => {
    const warn = vi.fn();
    const core = fakeCore({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    publishTriggerEvent(core, deduped);
    publishTriggerEvent(core, pollCompleted);
    expect(warn).not.toHaveBeenCalled();
  });

  it("calls onTriggerEvent for every event type", () => {
    const onTriggerEvent = vi.fn();
    const core = fakeCore(
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onTriggerEvent,
    );
    for (const e of [rejected, deduped, pollFailed, pollCompleted]) publishTriggerEvent(core, e);
    expect(onTriggerEvent).toHaveBeenCalledTimes(4);
  });

  it("without onTriggerEvent, only logs (when applicable) and does not throw", () => {
    const warn = vi.fn();
    expect(() =>
      publishTriggerEvent(
        fakeCore({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
        rejected,
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a throwing onTriggerEvent is caught and logged at warn, not rethrown", () => {
    const warn = vi.fn();
    const core = fakeCore({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, () => {
      throw new Error("listener boom");
    });
    expect(() => publishTriggerEvent(core, deduped)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("onTriggerEvent threw");
  });
});
