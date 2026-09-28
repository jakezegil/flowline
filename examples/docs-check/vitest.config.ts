import { defineConfig } from "vitest/config";
import { sourceConditions } from "../../source-conditions.ts";

export default defineConfig({
  ...sourceConditions,
  test: {
    name: "docs-check",
    environment: "node",
    // `.generated/` holds extracted snippets (some named *.test.ts); only run our own tests.
    include: ["src/**/*.test.ts"],
  },
});
