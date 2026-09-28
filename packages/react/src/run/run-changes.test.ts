import { describe, expect, it, vi } from "vitest";
import { mockClient } from "../../test/dom";
import { publishRunChange, type RunChange, subscribeRunChanges } from "./run-changes";

const change = (id: string, status: RunChange["status"]): RunChange => ({
  id,
  workflowId: "wf",
  status,
  createdAt: 1,
  updatedAt: 2,
});

describe("run changes", () => {
  it("tells listeners the status last seen, undefined on a first sighting", () => {
    const client = mockClient({});
    const heard = vi.fn();
    const off = subscribeRunChanges(client, heard);
    publishRunChange(client, change("r1", "waiting"));
    publishRunChange(client, change("r1", "waiting"));
    publishRunChange(client, change("r1", "cancelled"));
    expect(heard.mock.calls.map(([run, previous]) => [run.status, previous])).toEqual([
      ["waiting", undefined],
      ["cancelled", "waiting"],
    ]);
    off();
  });

  it("remembers a bounded number of runs, forgetting the least recently published", () => {
    const client = mockClient({});
    const heard = vi.fn();
    subscribeRunChanges(client, heard);
    publishRunChange(client, change("first", "running"));
    for (let i = 0; i < 1000; i++) publishRunChange(client, change(`r${i}`, "running"));
    heard.mockClear();
    // "first" was forgotten, so seeing it again is a first sighting.
    publishRunChange(client, change("first", "running"));
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ id: "first" }), undefined);
    // A recent run is still known: the same status is not news.
    publishRunChange(client, change("r999", "running"));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
