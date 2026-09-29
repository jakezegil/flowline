import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { VERSION } from "./index";

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(version);
  });
});

describe("package entry points", () => {
  it("exports the builder from the main entry", async () => {
    const core = await import("./index");
    expect(typeof core.workflow).toBe("function");
    expect(typeof core.ref).toBe("function");
    expect(typeof core.tpl).toBe("function");
  });

  it("exposes the client at @flowlinejs/core/client", async () => {
    const client = await import("@flowlinejs/core/client");
    expect(typeof client.createClient).toBe("function");
    expect(typeof client.FlowlineHttpError).toBe("function");
  });
});
