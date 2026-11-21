import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    env: {
      // Tests never call a real LLM and never wait for demo pacing.
      GLD_FORCE_FALLBACK: "1",
      GLD_STEP_DELAY_MS: "0",
    },
  },
});
