import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vite-plus";

import { oxcParseTestConfig } from "../runtime/oxc-parse-test-config.ts";

// Workflows are checked and generated inside core's Worker, so the tests
// run in workerd too.
export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  resolve: { alias: oxcParseTestConfig.alias },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-15",
        modulesRules: oxcParseTestConfig.modulesRules,
      },
    }),
  ],
});
