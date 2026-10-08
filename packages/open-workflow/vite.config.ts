import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// Validation compiles every expression with the metered jq in
// @grasp-os/workflow-expressions, which runs inside workerd: so do the tests.
export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-15",
        // A .wasm import is a compiled module, as in Wrangler's default
        // rules: jq.wasm, reached through the expressions package.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
      },
    }),
  ],
});
