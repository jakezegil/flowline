import { runStorageConformance } from "@flowlinejs/engine/conformance";
import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { createMemoryStorage, VERSION } from "./index";

runStorageConformance("memory", async () => ({ storage: createMemoryStorage() }));

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(version);
  });
});

describe("createMemoryStorage", () => {
  it("creates independent instances", async () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    await a.claimDedupeKey("t", "k", "run_a", 0, 1000);
    expect(await b.claimDedupeKey("t", "k", "run_b", 0, 1000)).toEqual({
      runId: "run_b",
      claimed: true,
    });
  });
});
