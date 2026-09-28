import { defineConfig } from "vitest/config";
import { sourceConditions } from "../../source-conditions.ts";

export default defineConfig({
  ...sourceConditions,
  test: {
    name: "headless",
    environment: "node",
  },
});
