import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { VERSION } from "./index";

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(version);
  });
});
