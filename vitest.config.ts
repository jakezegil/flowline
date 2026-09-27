import { defineConfig } from "vitest/config";

// Vitest 5 removed the separate `vitest.workspace.ts` mechanism in favor of
// `test.projects` on a single root config. Each package/example still owns
// its own `vitest.config.ts`, referenced here by glob.
export default defineConfig({
  test: {
    projects: ["packages/*", "examples/*"],
  },
});
