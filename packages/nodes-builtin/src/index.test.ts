import { describe, expect, it } from "vitest";
import { VERSION } from "./index";

describe("VERSION", () => {
  it("is 0.1.0", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
