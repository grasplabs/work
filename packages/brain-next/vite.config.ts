import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vite-plus";

// The store's own tests run in workerd, through its real boundary, beside
// embedders of the embed package's tiny test model: the Brain's work with
// the embedders it is given, as core gives its own (core's tests reach the
// store through core, where no model ships).
export default defineProject({
  // Fails the suite when it isn't running in workerd, then starts the
  // store before each file's tests (test/warm-store.ts).
  test: {
    setupFiles: ["../../scripts/assert-workerd.ts", "./test/warm-store.ts"],
    // One after another, as listed: the runtime's check reports before
    // warm-store.ts fails on its `cloudflare:` import.
    sequence: { setupFiles: "list" },
    // Integration tests in workerd, as core's are: exports and restores
    // over several parts, ledger replays and erasures through the real
    // store. On a CI runner, six Vitest workers share four CPUs with the
    // workerd they drive and with the shard's long property tests, and the
    // same test took four to seven times as long as on a laptop: one of
    // 0.7 s locally passed 5 s, Vitest's default, twice in a row
    // (November 2026). The same default as core's (apps/core/vite.config.ts).
    testTimeout: 60_000,
  },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        compatibilityFlags: ["nodejs_compat"],
        // The store's migrations as text, the embedder's module compiled,
        // the test model's files as bytes, as a Worker imports them.
        modulesRules: [
          { type: "Text", include: ["**/*.sql"] },
          { type: "CompiledWasm", include: ["**/*.wasm"] },
          { type: "Data", include: ["**/*.bin"] },
        ],
        r2Buckets: ["BRAIN_OBJECTS", "MODEL_FILES"],
        durableObjects: {
          BRAIN_STORE: { className: "BrainStore", useSQLite: true },
          EMBEDDER: { className: "BreakableEmbedder", useSQLite: true },
          OTHER_EMBEDDER: { className: "FloatEmbedder", useSQLite: true },
        },
      },
    }),
  ],
});
