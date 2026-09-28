import { createRegistry } from "@flowlinejs/core";
// Test-only: the package itself never imports nodes-builtin (the browser only sees the manifest).
import { builtinPlugin } from "@flowlinejs/nodes-builtin";
import { Box } from "lucide-react";
import { expect, test } from "vitest";
import { bundledIconNames, resolveIconIn } from "./icons";

test("every icon the built-in plugin, nodes and triggers use is bundled", () => {
  const manifest = createRegistry([builtinPlugin]).manifest();
  const used = [
    ...manifest.plugins.map((p) => p.icon),
    ...manifest.nodes.map((n) => n.icon),
    ...manifest.triggers.map((t) => t.icon),
  ].filter((name): name is string => name !== undefined);
  expect(used.length).toBeGreaterThan(10);
  const missing = used.filter((name) => resolveIconIn(undefined, name) === Box);
  expect(missing).toEqual([]);
  for (const name of ["route", "log-in", "calendar-clock", "blocks"]) {
    expect(bundledIconNames).toContain(name);
  }
});
