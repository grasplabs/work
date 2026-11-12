// The Worker the store's tests run against: the store, and embedders of
// the embed package's test models, each breakable, as core binds its own
// embedder.
import type { EmbedModel } from "@grasp-os/embed/model-files";

import { BreakableEmbedder, floatModel } from "../../embed/test/test-models.ts";

export { BrainStore } from "../src/store.ts";
export { BreakableEmbedder } from "../../embed/test/test-models.ts";

/** Embedders of another build: the float test model, for a change of model. */
export class FloatEmbedder extends BreakableEmbedder {
  protected override readonly model: EmbedModel = floatModel;
}

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
