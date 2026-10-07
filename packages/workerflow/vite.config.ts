import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineProject } from "vite-plus";

// Run objects are Durable Objects, so their tests run in workerd, through
// the object's real boundary. The process-death tests run plain workerd
// from Node instead (vite.process.config.ts).
export default defineProject({
  test: {
    // Fails the suite when it isn't running in workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
    exclude: [...defaultExclude, "test/process/**"],
  },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        durableObjects: {
          RUNS: { className: "TestRuns", useSQLite: true },
        },
      },
    }),
  ],
});
