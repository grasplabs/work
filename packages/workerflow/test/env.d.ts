import type { TestRuns } from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      RUNS: DurableObjectNamespace<TestRuns>;
    }
  }
}
