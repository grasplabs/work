import type {
  Api,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";

import { regionalPricesOf } from "./model-prices.ts";

// The text models the model gateway offers (models.ts), whatever way a
// deployment reaches them (model-transport.ts): each by `<provider>/<id>`,
// with pi's catalog entry for its limits and list prices. The provider
// names the model and its prices, never the way to it: Claude Sonnet 5.5
// is `anthropic/claude-sonnet-5-5` through AI Gateway, OpenRouter or
// Anthropic's own API alike, and costs its list price on each.

/**
 * The Claude models Bedrock serves through its EU inference profile, by
 * their Anthropic IDs. Not Claude Fable 5.1 (regional only in us-east-1)
 * or Claude Fable 5, which Anthropic serves only with 30-day retention.
 */
const euClaudeModels = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
] as const;

/**
 * pi's Anthropic catalog entry for each EU model, pointed at Bedrock: sent
 * as its EU inference profile, at Bedrock's regional prices.
 */
const bedrockEuModels: Readonly<Record<string, Model<"anthropic-messages">>> =
  Object.fromEntries(
    euClaudeModels.map((id) => {
      const model = ANTHROPIC_MODELS[id];
      return [
        id,
        {
          ...model,
          id: `eu.anthropic.${id}`,
          cost: regionalPricesOf(model.cost),
        },
      ];
    })
  );

/**
 * The providers the gateway offers: pi's catalog of their models, which
 * gives each model's limits, prices and the API its native endpoint
 * speaks.
 */
const providers = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  // Claude in Amazon Bedrock, in the EU, through its EU inference profile.
  "bedrock-eu": bedrockEuModels,
  "workers-ai": CLOUDFLARE_WORKERS_AI_MODELS,
} as const;

export type Provider = keyof typeof providers;

/** Every provider the gateway offers, in a stable order. */
export const providerNames: readonly Provider[] = [
  "anthropic",
  "openai",
  "bedrock-eu",
  "workers-ai",
] satisfies readonly (keyof typeof providers)[];

const isProvider = (value: string): value is Provider =>
  Object.hasOwn(providers, value);

export interface ModelRef {
  provider: Provider;
  id: string;
  /** pi's descriptor, which points at the provider's own endpoint. */
  catalog: Model<Api>;
}

/**
 * A model as the gateway names it: `<provider>/<model>`, such as
 * `anthropic/claude-sonnet-5` or
 * `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Only models in pi's
 * catalog, so every call has a price.
 */
export const parseModelRef = (ref: string): ModelRef | undefined => {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  if (slash === -1 || !isProvider(provider)) {
    return undefined;
  }
  const catalog: Readonly<Record<string, Model<Api>>> = providers[provider];
  // Own keys only, so `constructor` and the like are no model.
  const model = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  return model === undefined ? undefined : { provider, id, catalog: model };
};

/**
 * The context window of the model pi named `model` answered with, in
 * tokens, from the catalog of the providers the gateway offers; none for
 * a model it doesn't offer.
 */
export const catalogWindowOf = (model: string): number | undefined => {
  for (const catalog of Object.values(providers)) {
    const models: Readonly<Record<string, Model<Api>>> = catalog;
    const found = Object.hasOwn(models, model) ? models[model] : undefined;
    if (found !== undefined && found.contextWindow > 0) {
      return found.contextWindow;
    }
  }
  return undefined;
};

/**
 * Workers AI counts the answer's cap against the model's window and refuses
 * a request whose total is over it, so answers are capped well below.
 */
const workersAiMaxTokens = 32_768;

/** The most tokens `ref`'s answers may take, as the gateway sends them. */
export const maxTokensOf = (ref: ModelRef): number =>
  ref.provider === "workers-ai"
    ? Math.min(ref.catalog.maxTokens, workersAiMaxTokens)
    : ref.catalog.maxTokens;

/*
 * pi's adapter for each API, loaded the first time a model is called: they
 * bring the providers' SDKs, which would cost every isolate's startup
 * (Cloudflare caps the CPU a Worker's startup may use).
 */
const adapters = {
  "anthropic-messages": async () => {
    const { streamSimple } =
      await import("@earendil-works/pi-ai/api/anthropic-messages");
    return streamSimple;
  },
  "openai-responses": async () => {
    const { streamSimple } =
      await import("@earendil-works/pi-ai/api/openai-responses");
    return streamSimple;
  },
  "openai-completions": async () => {
    const { streamSimple } =
      await import("@earendil-works/pi-ai/api/openai-completions");
    return streamSimple;
  },
} as const;

/** The APIs a route may speak: those whose pi adapter takes a custom fetch. */
export type RouteApi = keyof typeof adapters;

export const isRouteApi = (api: string): api is RouteApi =>
  Object.hasOwn(adapters, api);

/**
 * pi's adapter for `api`. Only the APIs whose adapter takes a custom
 * fetch, so every request goes through the gateway's own (`open`).
 */
export const adapterFor = async (
  api: RouteApi
): Promise<StreamFunction<Api, SimpleStreamOptions>> => {
  const adapter = await adapters[api]();
  // SAFETY: a route's model always speaks its adapter's API (its `api`
  // picks the adapter), which pi's types can't tie together.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return adapter as StreamFunction<Api, SimpleStreamOptions>;
};
