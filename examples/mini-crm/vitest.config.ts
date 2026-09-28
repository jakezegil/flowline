import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "mini-crm",
    environment: "node",
    // Web tests opt into jsdom with a `// @vitest-environment jsdom` comment.
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.tsx"],
  },
});
