import { bindings } from "cf/config";
import { defineConfig } from "vite-plus";

import { adminPlugins, localEnv } from "./vite.config.ts";

/** How many client databases the fake Cloudflare API holds at once. */
const clientDatabases = 24;

/**
 * The admin the browser journeys run (e2e/admin-rollout.e2e.ts): the
 * dev server's, with test/e2e-worker.ts as its Worker's entry, which puts
 * the admin's tests' fakes around src/server.ts. Its state is kept where
 * the journeys' Playwright config says (`ADMIN_E2E_STATE`), apart from
 * `vp dev`'s.
 */
export default defineConfig({
  plugins: adminPlugins({
    persistState: { path: process.env.ADMIN_E2E_STATE ?? ".wrangler/e2e" },
    config: (worker) => ({
      entrypoint: "./test/e2e-worker.ts",
      env: {
        ...worker.env,
        // Who every request comes from: the dev bypass (src/access.ts).
        DEV_ACCESS_EMAIL: bindings.text("staff@grasp.test"),
        // Where provisioned clients are served (src/deploy/context.ts).
        CLIENT_DOMAIN: bindings.text("grasp.test"),
        // Grasp's OAuth apps, which clients' sign-in names (src/deploy/core-config.ts).
        ENTRA_CLIENT_ID: bindings.text("test-entra-app"),
        GOOGLE_CLIENT_ID: bindings.text(
          "test-google-app.apps.googleusercontent.com"
        ),
        // What the dev server runs with beyond wrangler.jsonc: no
        // jurisdiction for the admin's runs on Workerflow, which workerd
        // lacks. The e2e config sets its own vars, so it takes them here.
        ...localEnv,
        // Where the fake Cloudflare API runs client D1 queries
        // (test/cloudflare-api-workers.ts), as in vite.test.config.ts.
        ...Object.fromEntries(
          Array.from({ length: clientDatabases }, (_, slot) => [
            `CLIENT_D1_${slot}`,
            bindings.d1({ name: `client-d1-${slot}` }),
          ])
        ),
      },
    }),
  }),
});
