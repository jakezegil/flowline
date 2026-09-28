/**
 * Trigger-level outcomes that have no run to attach to: rejected deliveries, deduped deliveries
 * and poll results. Storage never persists these; a host that wants an audit trail persists them
 * itself from `EngineOptions.onTriggerEvent`.
 *
 * @module
 */
import type { Issue, RunOrigin } from "@flowline/core";
import type { EngineCore } from "./engine";
import { errorMessage } from "./util";

/**
 * A trigger-level outcome reported through `EngineOptions.onTriggerEvent`. `trigger.rejected` and
 * `poll.failed` are also logged at `warn`.
 */
export type TriggerEvent =
  | {
      type: "trigger.rejected";
      at: number;
      tenantId: string;
      workflowId: string;
      /** The workflow's published version. */
      version: number;
      /** What delivery was rejected: an event emission, or one item of a poll. */
      source: { kind: "event"; event: string } | { kind: "poll"; itemKey: string };
      /** Why, naming the failing field where relevant. Never includes the delivered payload. */
      message: string;
      /** The validation issues (`code: "config.invalid"` for payload problems). */
      issues: Issue[];
    }
  | {
      type: "trigger.deduped";
      at: number;
      tenantId: string;
      workflowId: string;
      /** The run the key already belongs to. */
      runId: string;
      /** The namespaced key, e.g. `event:deal-won:evt_123`. */
      key: string;
      source: RunOrigin;
    }
  | {
      type: "poll.completed";
      at: number;
      tenantId: string;
      workflowId: string;
      since: number;
      until: number;
      items: number;
      started: number;
      rejected: number;
    }
  | {
      type: "poll.failed";
      at: number;
      tenantId: string;
      workflowId: string;
      since: number;
      until: number;
      message: string;
      nextAt: number;
    };

/**
 * @internal Report a trigger-level outcome: logs `trigger.rejected` and `poll.failed` at `warn`,
 * then calls `EngineOptions.onTriggerEvent`, if set, logging (and swallowing) anything it throws
 * so a broken listener never fails the caller.
 */
export function publishTriggerEvent(core: EngineCore, e: TriggerEvent): void {
  if (e.type === "trigger.rejected") {
    core.logger?.warn("trigger rejected delivery", {
      tenantId: e.tenantId,
      workflowId: e.workflowId,
      version: e.version,
      ...(e.source.kind === "event" ? { event: e.source.event } : { itemKey: e.source.itemKey }),
      message: e.message,
    });
  } else if (e.type === "poll.failed") {
    core.logger?.warn("poll failed", {
      tenantId: e.tenantId,
      workflowId: e.workflowId,
      message: e.message,
    });
  }
  try {
    core.opts.onTriggerEvent?.(e);
  } catch (err) {
    core.logger?.warn("onTriggerEvent threw", { error: errorMessage(err) });
  }
}
