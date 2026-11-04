import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// Workflows are checked and generated inside core's Worker, so the tests
// run in workerd too.
export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: "2026-09-15" },
    }),
  ],
});
