import type { MisconfiguredRuns } from "./misconfigured.ts";
import type { BudgetedRuns, TestRuns } from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      RUNS: DurableObjectNamespace<TestRuns>;
      BUDGETED_RUNS: DurableObjectNamespace<BudgetedRuns>;
      MISCONFIGURED: DurableObjectNamespace<MisconfiguredRuns>;
    }
  }
}
