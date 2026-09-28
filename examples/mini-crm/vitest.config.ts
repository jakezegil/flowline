import { defineConfig } from "vitest/config";
import { sourceConditions } from "../../source-conditions.ts";

export default defineConfig({
  ...sourceConditions,
  test: {
    name: "mini-crm",
    environment: "node",
    // Web tests opt into jsdom with a `// @vitest-environment jsdom` comment.
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.tsx"],
  },
});
