import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// Expressions are evaluated inside workerd, so the tests run there, on the
// metered jq.wasm itself, without Node compatibility.
export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-15",
        // A .wasm import is a compiled module, as in Wrangler's default
        // rules (core's tests get them from its wrangler.jsonc).
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
      },
    }),
  ],
});
