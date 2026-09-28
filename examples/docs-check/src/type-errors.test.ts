/**
 * Compile errors a developer sees from the builder: compiled with the real tsc so the message
 * text (not just "it's an error") stays readable.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "../..");
const DIR = join(PKG, ".generated", "type-errors");
const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const PROBE = `import { defineNode, workflow } from "@flowline/core";
import { eventTrigger } from "@flowline/nodes-builtin";
import { z } from "zod";

const send = defineNode({
  type: "x.send",
  name: "Send",
  input: z.object({ baseUrl: z.string(), token: z.string() }),
  output: z.object({ messageId: z.string() }),
  run: async () => ({ messageId: "m" }),
});

workflow("probe").trigger(eventTrigger, { event: "x" }).step("s", send, { baseUrl: "u" });
`;

let output = "";
beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "probe.ts"), PROBE);
  const tsconfig = { extends: join(REPO, "tsconfig.base.json"), include: ["probe.ts"] };
  writeFileSync(join(DIR, "tsconfig.json"), JSON.stringify(tsconfig));
  try {
    await promisify(execFile)(process.execPath, [tscBin, "-p", DIR]);
  } catch (err) {
    output = (err as { stdout?: string }).stdout ?? String(err);
  }
}, 60_000);

describe("missing step config", () => {
  it("names the config by its field types, not the node's generic type", () => {
    expect(output).toContain("Property 'token' is missing");
    expect(output).toContain("StepConfig<{ baseUrl: string; token: string; }>");
    expect(output).not.toContain("NodeDefinition<");
  });
});
