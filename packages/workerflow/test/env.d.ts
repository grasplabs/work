import type { MisconfiguredRuns } from "./misconfigured.ts";
import type {
  BudgetedRuns,
  MiswaitedRuns,
  MistimedRuns,
  ShortTombstoneRuns,
  TestRuns,
} from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      RUNS: DurableObjectNamespace<TestRuns>;
      BUDGETED_RUNS: DurableObjectNamespace<BudgetedRuns>;
      MISCONFIGURED: DurableObjectNamespace<MisconfiguredRuns>;
      SHORT_TOMBSTONES: DurableObjectNamespace<ShortTombstoneRuns>;
      MISWAITED: DurableObjectNamespace<MiswaitedRuns>;

      MISTIMED: DurableObjectNamespace<MistimedRuns>;
    }
  }
}
