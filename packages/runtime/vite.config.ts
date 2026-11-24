import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vite-plus";

import { oxcParseTestConfig } from "./oxc-parse-test-config.ts";

// The runtime runs inside workerd (workflow runs, and `describeWorkflow` when core
// saves a workflow), so its tests run there too, without Node compatibility.
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
