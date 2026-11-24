import type {
  BreakableEmbedder,
  CustomEmbedder,
  DotEmbedder,
  FloatEmbedder,
  Int8Embedder,
  PairsEmbedder,
  TrappingEmbedder,
} from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      MODEL_FILES: R2Bucket;
      FLOAT: DurableObjectNamespace<FloatEmbedder>;
      INT8: DurableObjectNamespace<Int8Embedder>;
      DOT: DurableObjectNamespace<DotEmbedder>;
      PAIRS: DurableObjectNamespace<PairsEmbedder>;
      CUSTOM: DurableObjectNamespace<CustomEmbedder>;
      TRAPPING: DurableObjectNamespace<TrappingEmbedder>;
      BREAKABLE: DurableObjectNamespace<BreakableEmbedder>;
    }
  }
}
