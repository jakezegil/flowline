import { runStorageConformance } from "@flowline/engine/conformance";
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./index";

runStorageConformance("memory", async () => ({ storage: createMemoryStorage() }));

describe("createMemoryStorage", () => {
  it("creates independent instances", async () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    await a.recordDedupeKey("t", "k", 0, 1000);
    expect(await b.recordDedupeKey("t", "k", 0, 1000)).toBe(true);
  });
});
