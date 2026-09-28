import { describe, expect, it } from "vitest";
import { VERSION } from "./index";

describe("VERSION", () => {
  it("is 0.1.0", () => {
    expect(VERSION).toBe("0.1.0");
  });
});

describe("package entry points", () => {
  it("exports the builder from the main entry", async () => {
    const core = await import("./index");
    expect(typeof core.workflow).toBe("function");
    expect(typeof core.ref).toBe("function");
    expect(typeof core.tpl).toBe("function");
  });

  it("exposes the client at @flowline/core/client", async () => {
    const client = await import("@flowline/core/client");
    expect(typeof client.createClient).toBe("function");
    expect(typeof client.FlowlineHttpError).toBe("function");
  });
});
