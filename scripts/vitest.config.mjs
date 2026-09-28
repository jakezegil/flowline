import { defineConfig } from "vitest/config";

// Tests for the release tooling (`pnpm test:scripts`). Kept out of the root `test.projects`
// globs, which cover packages/* and examples/*.
export default defineConfig({
  test: {
    include: ["**/*.test.mjs"],
  },
});
