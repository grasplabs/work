/**
 * Which vector index provider a deployment uses (vector-index.ts).
 *
 * Vectorize can't be confined to the EU: an index takes no jurisdiction or
 * location, and the Data Localization Suite doesn't cover it. So it serves
 * only a deployment whose model rules keep nothing in the EU. Under any EU
 * rule, or rules that don't parse, every call refuses with `eu_only` and
 * the rule that applies, and nothing falls back to Vectorize; the index
 * that serves such a deployment is the `sqlite` profile, in
 * `jurisdiction("eu")`.
 */
import { deploymentEuRule } from "../models.ts";
import type { ModelsEnv } from "../models.ts";
import {
  refusingProvider,
  unsupportedVectorIndexProvider,
  VectorIndexError,
} from "./vector-index.ts";
import type { VectorIndexProvider } from "./vector-index.ts";
import { vectorizeProvider } from "./vectorize-index.ts";
import type {
  VectorizeGenerationBinding,
  VectorizeOptions,
} from "./vectorize-index.ts";

const euRuleWords = {
  deployment: "keep the whole deployment in the EU",
  connection: "keep some connections' data in the EU",
  workflow: "keep some workflows' AI steps in the EU",
  unreadable: "can't be read, so they are taken to keep data in the EU",
} as const;

/**
 * The deployment's vector index provider: Vectorize over the bound
 * generations where the client's rules allow it, the `unsupported` profile
 * where none is bound.
 */
export const vectorIndexProviderOf = (
  env: ModelsEnv,
  vectorize?: readonly VectorizeGenerationBinding[],
  options?: Pick<VectorizeOptions, "queryDeadlineMs" | "writeDeadlineMs">
): VectorIndexProvider => {
  if (vectorize === undefined) {
    return unsupportedVectorIndexProvider();
  }
  const rule = deploymentEuRule(env);
  if (rule !== undefined) {
    return refusingProvider(
      "vectorize",
      () =>
        new VectorIndexError(
          "eu_only",
          `The deployment's model rules ${euRuleWords[rule]}, and Vectorize can't be kept in the EU, so it isn't used.`
        )
    );
  }
  return vectorizeProvider(vectorize, options);
};
