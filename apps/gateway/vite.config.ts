import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  plugins: [
    cloudflareTest({
      // No dispatch namespace runs locally: the tests give the gateway a
      // stand-in for it (test/gateway.test.ts).
      miniflare: {
        compatibilityDate: "2026-09-15",
        compatibilityFlags: [],
      },
      main: "./src/index.ts",
    }),
  ],
});
