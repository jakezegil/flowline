import { defineConfig } from "vitest/config";
import { sourceConditions } from "../../source-conditions.ts";

export default defineConfig({
  ...sourceConditions,
  test: {
    name: "react",
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
