import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "docs-check",
    environment: "node",
    // `.generated/` holds extracted snippets (some named *.test.ts); only run our own tests.
    include: ["src/**/*.test.ts"],
  },
});
