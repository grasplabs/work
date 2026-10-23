import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { corePort } from "./e2e/stack.ts";

const ci = process.env.CI === "true";

/**
 * The console's port: this checkout's core port (e2e/stack.ts) moved
 * 10000 up, past every checkout's core and IdP pair.
 */
const consolePort = corePort + 10_000;
const consoleOrigin = `http://localhost:${consolePort}`;

/**
 * The staff console's journeys (e2e/console): a stack of their own, as the
 * console runs apart from client deployments. Its dev server runs
 * apps/console/vite.e2e.config.ts, which puts the console's tests' fake
 * Cloudflare API and Access's dev bypass around its unchanged entry.
 */
export default defineConfig({
  testDir: "e2e/console",
  testMatch: "**/*.e2e.ts",
  // A rollout to ring 0, then a rollback: each Worker's gradual stages,
  // held 2 s each, and the page's 5 s refreshes, on a loaded machine.
  timeout: 180_000,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  // One at a time: a rollout reaches every active client in ring 0, and
  // each journey seeds its own as the only one.
  workers: 1,
  reporter: ci ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: consoleOrigin,
    trace: "retain-on-failure",
  },
  // Never a server already running: its state wouldn't be the journeys'.
  webServer: {
    // The dir comes from `env` below, so no path is ever shell syntax.
    command: `rm -rf "$CONSOLE_E2E_STATE" && vp -C apps/console dev --config vite.e2e.config.ts --port ${consolePort} --strictPort`,
    env: {
      CONSOLE_E2E_STATE: path.join(
        import.meta.dirname,
        "apps/console/.wrangler/e2e-state"
      ),
    },
    port: consolePort,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
