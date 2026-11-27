import type {
  Api,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import {
  aiProviders,
  compatibleModelNamePattern,
} from "@grasp-os/shared/ai-providers";
import type {
  AiProviderId,
  AiProviderModel,
} from "@grasp-os/shared/ai-providers";

// The text models the model gateway offers (models.ts): each by
// `<provider>/<id>`, with pi's catalog entry for its limits and list
// prices. Every one is reached on the provider's own API through connect,
// which holds the key (model-transport-connect.ts): the organization's
// own, or Grasp's for platform features.

/**
 * What Mistral's chat completions take of OpenAI's: it refuses (422) any
 * field it doesn't know, and pi, which can't tell Mistral from OpenAI by
 * its URL, would send OpenAI's own: `store`, `max_completion_tokens`,
 * `stream_options` and the `developer` role. Mistral sends a stream's
 * usage in its last chunk unasked, which pi reads all the same.
 */
const mistralCompat: Model<"openai-completions">["compat"] = {
  supportsStore: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: false,
  supportsDeveloperRole: false,
};

/**
 * pi's Mistral catalog, pointed at Mistral's OpenAI-compatible chat
 * completions (@grasp-os/shared/ai-providers): pi's own Mistral adapter
 * takes no custom fetch, and every request must go through the gateway's.
 */
const mistralModels: Readonly<Record<string, Model<"openai-completions">>> =
  Object.fromEntries(
    Object.entries(MISTRAL_MODELS).map(([id, model]) => [
      id,
      {
        ...model,
        api: "openai-completions",
        baseUrl: aiProviders.mistral.baseUrls["openai-completions"] ?? "",
        compat: mistralCompat,
      },
    ])
  );

/**
 * The providers the gateway offers: pi's catalog of their models, which
 * gives each model's limits, prices and the API its native endpoint
 * speaks.
 */
const providers = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  mistral: mistralModels,
  // By OpenRouter's own ID, its slash and all: `openrouter/openai/gpt-5`.
  openrouter: OPENROUTER_MODELS,
} as const;

/**
 * A provider the gateway offers: one of pi's catalogs, or an
 * organization's OpenAI-compatible endpoint, whose models it names itself.
 */
export type Provider = keyof typeof providers | "openai-compatible";

/** Every provider the gateway offers, in a stable order. */
export const providerNames: readonly Provider[] = [
  "anthropic",
  "openai",
  "mistral",
  "openrouter",
  "openai-compatible",
];

const isCatalogProvider = (value: string): value is keyof typeof providers =>
  Object.hasOwn(providers, value);

/**
 * What the gateway knows of a model an OpenAI-compatible endpoint serves
 * under `name`: chat completions, and no price, so no budget admits it
 * (models.ts, `model.unpriced`). Its window and answers are assumed
 * modest; the endpoint refuses what its model can't take.
 */
const compatibleModel = (name: string): Model<"openai-completions"> => ({
  id: name,
  name,
  api: "openai-completions",
  provider: "openai-compatible",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
});

/** The most characters a custom endpoint's model name may have. */
const compatibleNameMaxLength = 128;

export interface ModelRef {
  provider: Provider;
  id: string;
  /** pi's descriptor, which points at the provider's own endpoint. */
  catalog: Model<Api>;
}

/**
 * A model as the gateway names it: `<provider>/<model>`, such as
 * `anthropic/claude-sonnet-5` or `openrouter/openai/gpt-5`. Only models in
 * pi's catalog, or an organization's OpenAI-compatible endpoint's, which
 * it names itself.
 */
export const parseModelRef = (ref: string): ModelRef | undefined => {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  if (slash === -1) {
    return undefined;
  }
  if (provider === "openai-compatible") {
    return id.length <= compatibleNameMaxLength &&
      compatibleModelNamePattern.test(id)
      ? { provider, id, catalog: compatibleModel(id) }
      : undefined;
  }
  if (!isCatalogProvider(provider)) {
    return undefined;
  }
  const catalog: Readonly<Record<string, Model<Api>>> = providers[provider];
  // Own keys only, so `constructor` and the like are no model.
  const model = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  return model === undefined ? undefined : { provider, id, catalog: model };
};

/**
 * Who makes `ref`'s model: its provider, or on OpenRouter, which passes
 * each call on to the model's maker, the maker its ID names first
 * (`openrouter/anthropic/…`).
 */
const makerOf = ({ provider, id }: ModelRef): string =>
  provider === "openrouter" ? `${provider}/${id.split("/")[0]}` : provider;

/** What a million tokens read and a million written cost, at list price. */
const priceOf = ({ catalog: { cost } }: ModelRef): number =>
  cost.input + cost.output;

/**
 * The model a small call of core's own (a chat's title) goes to for an
 * organization whose default model is `model`: its provider's small model
 * (`AiProviderSpec.smallModel`, the cheapest of its newest generation)
 * where that is of the same maker and cheaper at the catalog's list
 * prices, so the call goes nowhere the default doesn't, and never costs
 * more; else `model` itself. An OpenAI-compatible endpoint's models have
 * no price and no small model: its default.
 */
export const smallModelFor = (model: string): string => {
  const ref = parseModelRef(model);
  const named =
    ref === undefined ? undefined : aiProviders[ref.provider].smallModel;
  const small = named === undefined ? undefined : parseModelRef(named);
  return named !== undefined &&
    ref !== undefined &&
    small !== undefined &&
    makerOf(small) === makerOf(ref) &&
    priceOf(small) < priceOf(ref)
    ? named
    : model;
};

/**
 * The models an admin can choose of `provider`, by `<provider>/<model>`,
 * as `parseModelRef` takes them, with pi's name for each; none for an
 * OpenAI-compatible endpoint, whose models the organization names.
 */
export const catalogModelsOf = (provider: AiProviderId): AiProviderModel[] => {
  // A custom endpoint names its own; ElevenLabs only says Grasp's lines.
  if (provider === "openai-compatible" || provider === "elevenlabs") {
    return [];
  }
  const catalog: Readonly<Record<string, Model<Api>>> = providers[provider];
  return Object.entries(catalog).map(([id, model]) => ({
    model: `${provider}/${id}`,
    name: model.name,
  }));
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
