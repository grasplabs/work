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
    // Sleeps and waits in the tests last seconds by design, so no margin
    // depends on how fast the machine is; the polls fail at 10 s first.
    testTimeout: 20_000,
  },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        // AsyncLocalStorage, which tells a step call's attempt apart; hosts
        // need it too (`nodejs_als`, or `nodejs_compat`, which includes it).
        compatibilityFlags: ["nodejs_als"],
        durableObjects: {
          RUNS: { className: "TestRuns", useSQLite: true },
        },
      },
    }),
  ],
});
