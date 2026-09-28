import type { WorkflowSummary } from "@flowlinejs/core";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { FlowlineProvider } from "../provider";
import { useWorkflowNames } from "./use-workflow-names";

beforeEach(setupDom);
afterEach(() => vi.restoreAllMocks());

const summary = (id: string, name: string) => ({ id, name }) as WorkflowSummary;

describe("useWorkflowNames", () => {
  it("loads names for unknown IDs, and refreshes stale ones on the next poll", async () => {
    let name = "Lead routing";
    const client = mockClient({ listWorkflows: vi.fn(async () => [summary("leads", name)]) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FlowlineProvider client={client}>{children}</FlowlineProvider>
    );
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useWorkflowNames(ids, true, 60_000),
      { wrapper, initialProps: { ids: ["leads"] } },
    );
    await waitFor(() => expect(result.current.get("leads")).toBe("Lead routing"));
    expect(client.listWorkflows).toHaveBeenCalledTimes(1);

    // A poll soon after: the names are fresh, no reload.
    name = "Inbound leads";
    now += 5_000;
    rerender({ ids: ["leads"] });
    expect(client.listWorkflows).toHaveBeenCalledTimes(1);

    // A poll once they're older than maxAgeMs picks up the rename.
    now += 60_000;
    rerender({ ids: ["leads"] });
    await waitFor(() => expect(result.current.get("leads")).toBe("Inbound leads"));
    expect(client.listWorkflows).toHaveBeenCalledTimes(2);
  });

  it("loads nothing while disabled", () => {
    const client = mockClient({ listWorkflows: vi.fn(async () => []) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FlowlineProvider client={client}>{children}</FlowlineProvider>
    );
    renderHook(() => useWorkflowNames(["a"], false), { wrapper });
    expect(client.listWorkflows).not.toHaveBeenCalled();
  });
});
