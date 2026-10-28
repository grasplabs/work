import type { D1Migration } from "cloudflare:test";

// The bindings vite.config.ts gives the tests' Worker.
declare global {
  namespace Cloudflare {
    interface Env {
      BRAIN: D1Database;
      /** A second Brain, empty: what an export is restored into. */
      RESTORED: D1Database;
      BLOBS: R2Bucket;
      BRAIN_MIGRATIONS: D1Migration[];
    }
  }
}
