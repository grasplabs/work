import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// The AI providers an organization can reach its models through, one list
// for core and connect. Core's model gateway decides, meters and audits
// every call (apps/core/src/models.ts); connect holds the credentials and
// makes the provider's HTTP call (apps/connect/src/ai-providers.ts). Two
// credential sources go the same way: the organization's own key per
// provider ("bring your own key", sealed in connect), and Grasp's own keys
// for platform features (connect Worker secrets, named here).
//
// A model is named `<provider>/<model>`, by the provider's catalog in pi
// (`anthropic/claude-sonnet-5-5`, `openai/gpt-5.4`,
// `mistral/mistral-small-latest`, `openrouter/<OpenRouter's ID>`), which
// gives its price. An OpenAI-compatible endpoint's models are named by the
// organization (`openai-compatible/<its name there>`) and have no price.
//
// Where a provider runs is shown, never enforced: the admin chooses.

/** The providers, in the order they are offered. */
export const aiProviderIds = [
  "anthropic",
  "openai",
  "mistral",
  "openrouter",
  "openai-compatible",
] as const;
export const aiProviderIdSchema = z.enum(aiProviderIds);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

/** The APIs a provider speaks, as pi's adapters name them. */
export type AiProviderApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions";

/** The one request header a provider takes its key in. */
export type AiKeyHeader = "x-api-key" | "authorization";

/** One provider, as core routes to it and connect sends to it. */
export interface AiProviderSpec {
  id: AiProviderId;
  /** Its name, for people. */
  label: string;
  /**
   * Its endpoint for each API it speaks; none for an OpenAI-compatible
   * endpoint, whose base URL the organization gives with its key.
   */
  baseUrls: Partial<Record<AiProviderApi, string>>;
  /**
   * The paths below its host a model request may go to, and nothing else
   * its key could reach (files, fine-tuning, an account's settings). For
   * an OpenAI-compatible endpoint, below its base URL's own path.
   */
  paths: readonly string[];
  /** Where its key goes: `x-api-key: <key>` or `authorization: Bearer <key>`. */
  keyHeader: AiKeyHeader;
  /** Where it runs, in plain words, for the admin. */
  whereItRuns: string;
  /** Its region, as the model ledger records each call's route. */
  region: "us" | "eu" | "custom";
  /**
   * The connect Worker secret holding Grasp's own key for it, for platform
   * features; none for an OpenAI-compatible endpoint, which is only ever
   * the organization's.
   */
  platformSecret:
    | "ANTHROPIC_API_KEY"
    | "OPENAI_API_KEY"
    | "MISTRAL_API_KEY"
    | "OPENROUTER_API_KEY"
    | undefined;
  /**
   * The model a test of a newly added key asks, one of the cheapest of its
   * catalog; none for an OpenAI-compatible endpoint, which names its own.
   */
  testModel: string | undefined;
}

/**
 * The providers. Mistral is reached through its OpenAI-compatible chat
 * completions (`https://api.mistral.ai/v1`), which pi's OpenAI adapter
 * speaks with a custom fetch, as every route must here.
 */
export const aiProviders: Readonly<Record<AiProviderId, AiProviderSpec>> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrls: { "anthropic-messages": "https://api.anthropic.com" },
    paths: ["/v1/messages"],
    keyHeader: "x-api-key",
    whereItRuns: "Anthropic, United States",
    region: "us",
    platformSecret: "ANTHROPIC_API_KEY",
    testModel: "anthropic/claude-haiku-4-5",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrls: {
      "openai-responses": "https://api.openai.com/v1",
      "openai-completions": "https://api.openai.com/v1",
    },
    paths: ["/v1/responses", "/v1/chat/completions"],
    keyHeader: "authorization",
    whereItRuns: "OpenAI, United States",
    region: "us",
    platformSecret: "OPENAI_API_KEY",
    testModel: "openai/gpt-5-mini",
  },
  mistral: {
    id: "mistral",
    label: "Mistral AI",
    baseUrls: { "openai-completions": "https://api.mistral.ai/v1" },
    paths: ["/v1/chat/completions"],
    keyHeader: "authorization",
    whereItRuns: "Mistral AI, European Union (France)",
    region: "eu",
    platformSecret: "MISTRAL_API_KEY",
    testModel: "mistral/mistral-small-latest",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrls: {
      "anthropic-messages": "https://openrouter.ai/api",
      "openai-completions": "https://openrouter.ai/api/v1",
    },
    paths: ["/api/v1/messages", "/api/v1/chat/completions"],
    keyHeader: "authorization",
    whereItRuns:
      "OpenRouter, United States, passing each call on to the model's provider",
    region: "us",
    platformSecret: "OPENROUTER_API_KEY",
    testModel: "openrouter/openai/gpt-5-mini",
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    baseUrls: {},
    paths: ["/chat/completions"],
    keyHeader: "authorization",
    whereItRuns: "Wherever your endpoint runs",
    region: "custom",
    platformSecret: undefined,
    testModel: undefined,
  },
};

/** The host a fixed provider's requests go to; none for a custom endpoint. */
export const aiProviderHost = (provider: AiProviderId): string | undefined => {
  const [base] = Object.values(aiProviders[provider].baseUrls);
  return base === undefined ? undefined : new URL(base).hostname;
};

/**
 * What core puts where the key goes, which connect replaces with the real
 * key: a request that carries anything else there is refused, so core can
 * never send a credential of its own, nor learn the real one.
 */
export const aiCredentialPlaceholder = "grasp-connect-ai-credential";

/**
 * The header on connect's own refusal of a model request, naming why: it
 * never reached the provider. Dropped from every provider response, so a
 * provider can't pass one off.
 */
export const aiRefusedHeader = "x-grasp-ai-refused";

/** Why connect refused a model request, as its header names it. */
export const aiRefusals = [
  "grant",
  "no_credential",
  "endpoint",
  "path",
  "method",
  "credential_header",
  "redirect",
  "unreachable",
] as const;
export type AiRefusal = (typeof aiRefusals)[number];

/** Where a credential comes from: the organization's own, or Grasp's. */
export const aiCredentialSourceSchema = z.enum(["organization", "platform"]);
export type AiCredentialSource = z.infer<typeof aiCredentialSourceSchema>;

/** The most characters a key may have. */
export const aiKeyMaxLength = 512;

/**
 * A provider key as an admin pastes it: printable ASCII without spaces, as
 * a request header carries it.
 */
export const aiKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(aiKeyMaxLength)
  .regex(/^[\u0021-\u007E]+$/u);

/** The most characters a custom endpoint's base URL may have. */
export const aiBaseUrlMaxLength = 2048;

/**
 * A model of an OpenAI-compatible endpoint, by the organization's name for
 * it there, as servers name them (`llama-3.3-70b`, `meta-llama/Llama-3`).
 */
export const compatibleModelNamePattern = /^[\w.:@-]+(?:\/[\w.:@-]+)*$/u;

/** A key to add, as the admin's request to core says it. */
export const aiProviderAddSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.enum(["anthropic", "openai", "mistral", "openrouter"]),
    key: aiKeySchema,
  }),
  z.strictObject({
    provider: z.literal("openai-compatible"),
    key: aiKeySchema,
    baseUrl: z.string().trim().min(1).max(aiBaseUrlMaxLength),
  }),
]);
export type AiProviderAdd = z.input<typeof aiProviderAddSchema>;

/** The organization's choice of models: its default, then its fallbacks. */
export const aiModelChoiceSchema = z.strictObject({
  defaultModel: z.string().min(1).max(256),
  /** Tried in order when a call is refused before anything was billed. */
  fallbacks: z.array(z.string().min(1).max(256)).max(5).default([]),
});
export type AiModelChoice = z.output<typeof aiModelChoiceSchema>;

/** A key connect keeps, as it shows it: never the key, only its mask. */
export interface AiProviderKey {
  provider: AiProviderId;
  /** The key's first and last characters, such as `sk-…a3f2`. */
  mask: string;
  /** For an OpenAI-compatible endpoint: the base URL its key goes to. */
  baseUrl: string | null;
  /** When it was added, and last replaced, in ms since the epoch. */
  addedAt: number;
  updatedAt: number;
}

/**
 * What core routes by, from connect: the organization's providers (with a
 * custom endpoint's base URL) and those Grasp has a key for. Never a key.
 */
export interface AiProviderRoutes {
  organization: { provider: AiProviderId; baseUrl: string | null }[];
  platform: AiProviderId[];
}

/** How a provider's calls went lately, from the model ledger. */
export interface AiProviderStatus {
  /** When a call last worked, and last failed, in ms since the epoch. */
  lastOkAt: number | null;
  lastFailedAt: number | null;
  /** How it last failed: `auth`, `rate_limited`, `refused`, `provider_down`. */
  lastFailure: string | null;
  lastStatus: number | null;
}

/** One of the organization's providers, as its admins see it. */
export interface AiProviderListed extends AiProviderKey {
  label: string;
  whereItRuns: string;
  /** None until a call went through it. */
  status: AiProviderStatus | null;
}

/** The organization's AI providers and its choice of models. */
export interface AiProvidersListing {
  providers: AiProviderListed[];
  /** Every provider an admin can add, with where it runs. */
  offered: { provider: AiProviderId; label: string; whereItRuns: string }[];
  /** The models its calls use; none until an admin chose. */
  choice: AiModelChoice | null;
}

/** How a test of a provider went: one tiny call through the gateway. */
export type AiProviderTest =
  | { ok: true; model: string }
  | { ok: false; model: string; code: string };

/** Why core refused an admin's AI provider request. */
export const aiProviderErrors = defineErrorFamily({
  "ai_provider.invalid": "That isn't a valid AI provider request.",
  "ai_provider.endpoint_refused":
    "That address can't be used: it must be a public HTTPS address, not a private or internal one.",
  "ai_provider.not_connected": "That AI provider isn't connected.",
  "ai_provider.model_unavailable":
    "That model isn't one of a connected AI provider's.",
  "ai_provider.vault_unavailable":
    "Keys can't be stored safely right now, so it wasn't saved. Ask Grasp to check the deployment.",
});

/**
 * The organization's AI providers, for its admins (core's `/rpc`): add a
 * key (it goes straight to connect, sealed there, never kept or logged by
 * core), test it with one tiny call through the gateway, choose the
 * models, and remove a key. Every change is audited.
 */
export interface AiProvidersApi {
  list: () => Promise<AiProvidersListing>;
  /** Adds the provider's key, or replaces the one it has. */
  add: (request: AiProviderAdd) => Promise<AiProviderListed>;
  /** One tiny call to `model`, or the provider's own test model. */
  test: (provider: AiProviderId, model?: string) => Promise<AiProviderTest>;
  /** Sets the default model and its fallbacks, each a connected provider's. */
  setModels: (choice: z.input<typeof aiModelChoiceSchema>) => Promise<void>;
  /** Removes the provider's key; connect deletes it. */
  remove: (provider: AiProviderId) => Promise<void>;
}

/** A key core hands connect to keep, as an admin gave it. */
export const aiProviderKeySaveSchema = z.strictObject({
  provider: aiProviderIdSchema,
  key: aiKeySchema,
  /** Only for an OpenAI-compatible endpoint, and required for it. */
  baseUrl: z.string().trim().min(1).max(aiBaseUrlMaxLength).optional(),
});
export type AiProviderKeySave = z.input<typeof aiProviderKeySaveSchema>;

/** Why connect refused to keep a key. */
export const aiKeyErrors = defineErrorFamily({
  "ai_key.invalid": "That isn't a valid AI provider key.",
  "ai_key.endpoint_refused":
    "That address can't be used: it must be a public HTTPS address, not a private or internal one.",
  "ai_key.vault_unavailable":
    "Keys can't be stored safely right now: the deployment has no token key.",
});

/**
 * What core reaches in connect for AI providers, over the `CONNECT`
 * service binding. No method returns a key.
 */
export interface AiProviderConnectApi {
  /** Seals and keeps the organization's key for a provider, replacing any. */
  saveAiProviderKey: (request: AiProviderKeySave) => Promise<AiProviderKey>;
  /** Deletes the organization's key for a provider; whether it had one. */
  removeAiProviderKey: (provider: AiProviderId) => Promise<boolean>;
  /** The organization's keys, as masks. */
  aiProviderKeys: () => Promise<AiProviderKey[]>;
  /** What core routes by (`AiProviderRoutes`). */
  aiProviderRoutes: () => Promise<AiProviderRoutes>;
  /**
   * Sends one provider request of a model call, which core's gateway
   * decided and its ledger admitted, with the credential `grant` names
   * (`signModelGrant`): only to the provider's own host (or the
   * organization's registered base URL), only to its model paths,
   * carrying `aiCredentialPlaceholder` where the key goes, which connect
   * replaces with the key, in that one header. Never follows a redirect.
   * The provider's response as it streams, or connect's own refusal
   * (`aiRefusedHeader`).
   */
  modelFetch: (request: Request, grant: string) => Promise<Response>;
}
