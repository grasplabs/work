import type { D1Migration } from "cloudflare:test";

// The bindings vite.config.ts gives the tests' Worker.
declare global {
  namespace Cloudflare {
    interface Env {
      BRAIN: D1Database;
      BLOBS: R2Bucket;
      BRAIN_MIGRATIONS: D1Migration[];
    }
  }
}
