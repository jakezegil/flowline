import { commandCatalog } from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { createCrmRegistry } from "./app";

describe("the mini-crm tool catalog", () => {
  const catalog = commandCatalog(createCrmRegistry().manifest());

  test("snapshot", () => {
    expect(catalog).toMatchSnapshot();
  });

  test("fits the size budget", () => {
    expect(JSON.stringify(catalog).length).toBeLessThan(40_000);
  });
});
