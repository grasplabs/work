import { aiProviderIdSchema } from "@grasp-os/shared/ai-providers";

// Which providers a real-model run reaches (brain-real-provider.ts sends
// each request on to their own API), apart from it so a script in Node
// can ask before a run without loading the Worker's types.

/** The providers whose API a run sends on to. */
const takenProviders: ReadonlySet<string> = new Set([
  "anthropic",
  "mistral",
  "openrouter",
]);

/**
 * Whether a real run can reach `model` (`<provider>/<model>`): one of a
 * provider whose API a run speaks, which a run, and the plan before
 * it, check before anything is sent.
 */
export const realProviderTakes = (model: string): boolean => {
  const provider = aiProviderIdSchema.safeParse(
    model.slice(0, model.indexOf("/"))
  );
  return provider.success && takenProviders.has(provider.data);
};

/**
 * Why a run refuses `model`: one `realProviderTakes` doesn't take. Said
 * alike by a run and by the free plan before it (scripts/brain-eval-model.ts).
 */
export const unreachableModel = (model: string): string =>
  `A run reaches Anthropic, Mistral and OpenRouter models of the gateway's catalog, not ${model}`;
