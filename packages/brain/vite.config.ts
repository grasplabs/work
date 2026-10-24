import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// The Brain on its own: a plain Worker with a D1 database and an R2
// bucket, the Brain's migrations, and fake ports (test/host.ts) standing
// in for a host. Nothing of Grasp runs, so what passes here is what the
// package does by itself.
const migrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/migrations`
);

export default defineProject({
  test: {
    // Fails the suite when it isn't running in workerd.
    setupFiles: ["../../scripts/assert-workerd.ts", "./test/migrate.ts"],
  },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        d1Databases: { BRAIN: "brain" },
        r2Buckets: { BLOBS: "blobs" },
        bindings: { BRAIN_MIGRATIONS: migrations },
      },
    }),
  ],
});
