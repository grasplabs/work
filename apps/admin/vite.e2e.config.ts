import { defineConfig } from "vite-plus";

import { adminPlugins } from "./vite.config.ts";

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
      main: "./test/e2e-worker.ts",
      vars: {
        ...worker.vars,
        // Who every request comes from: the dev bypass (src/access.ts).
        DEV_ACCESS_EMAIL: "staff@grasp.test",
        // Where provisioned clients are served (src/deploy/context.ts).
        CLIENT_DOMAIN: "grasp.test",
        // Grasp's OAuth apps, which clients' sign-in names (src/deploy/core-config.ts).
        ENTRA_CLIENT_ID: "test-entra-app",
        GOOGLE_CLIENT_ID: "test-google-app.apps.googleusercontent.com",
      },
      // Where the fake Cloudflare API runs client D1 queries
      // (test/cloudflare-api-workers.ts), as in vite.test.config.ts.
      d1_databases: [
        ...worker.d1_databases,
        ...Array.from({ length: clientDatabases }, (_, slot) => ({
          binding: `CLIENT_D1_${slot}`,
          database_name: `client-d1-${slot}`,
          database_id: `client-d1-${slot}`,
        })),
      ],
    }),
  }),
});
