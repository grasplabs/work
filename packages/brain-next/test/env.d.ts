import type { BreakableEmbedder } from "../../embed/test/test-models.ts";
import type { BrainStore } from "../src/store.ts";
import type { FloatEmbedder } from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      BRAIN_OBJECTS: R2Bucket;
      MODEL_FILES: R2Bucket;
      BRAIN_STORE: DurableObjectNamespace<BrainStore>;
      EMBEDDER: DurableObjectNamespace<BreakableEmbedder>;
      OTHER_EMBEDDER: DurableObjectNamespace<FloatEmbedder>;
    }
  }
}
