import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vite-plus";

// The embedder is a Durable Object, so its tests run in workerd, through
// the object's real boundary, on the tiny model in test/fixtures.
export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        // embed.wasm compiled with the bundle, as a Worker imports it; the
        // fixture's model files as bytes, for the tests to put in the bucket.
        modulesRules: [
          { type: "CompiledWasm", include: ["**/*.wasm"] },
          { type: "Data", include: ["**/*.bin"] },
        ],
        r2Buckets: ["MODEL_FILES"],
        durableObjects: {
          FLOAT: { className: "FloatEmbedder", useSQLite: true },
          INT8: { className: "Int8Embedder", useSQLite: true },
          DOT: { className: "DotEmbedder", useSQLite: true },
          PAIRS: { className: "PairsEmbedder", useSQLite: true },
          CUSTOM: { className: "CustomEmbedder", useSQLite: true },
        },
      },
    }),
  ],
});
