import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// The compatibility matrix (test/conformance.test.ts): the same fixtures on
// Workerflow's run object and on the reference engine, the Workflows engine
// Wrangler ships (miniflare's, pinned in the catalog), in one workerd. Its
// own project: the reference needs a Worker of its own (a workflow binding
// and its entrypoint), which the engine's tests have no use for.
export default defineProject({
  test: {
    name: "@grasp-os/workerflow:conformance",
    root: import.meta.dirname,
    include: ["test/conformance.test.ts"],
    // Fails the suite when it isn't running in workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
    // The reference sleeps and backs off in real time; the polls fail at
    // 10 s first.
    testTimeout: 20_000,
  },
  plugins: [
    cloudflareTest({
      main: "./test/conformance-worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        compatibilityFlags: ["nodejs_als"],
        durableObjects: {
          ENGINE: { className: "EngineRuns", useSQLite: true },
        },
        workflows: {
          REFERENCE: { name: "reference", className: "ReferenceFlow" },
        },
      },
    }),
  ],
});
