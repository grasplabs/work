// The conformance Worker's bindings (vite.conformance.config.ts). Declared
// beside the engine tests' (env.d.ts): one tsconfig types both projects.
import type { EngineRuns, ReferenceParams } from "./conformance-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      ENGINE: DurableObjectNamespace<EngineRuns>;
      REFERENCE: Workflow<ReferenceParams>;
    }
  }
}
