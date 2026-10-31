import { z } from "zod";

import type { AuditActor } from "./audit.ts";
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

/** The providers an organization can add a key of its own for, in the order they are offered. */
export const organizationProviderIds = [
  "anthropic",
  "openai",
  "mistral",
  "openrouter",
  "openai-compatible",
] as const;
export const organizationProviderIdSchema = z.enum(organizationProviderIds);
export type OrganizationProviderId = z.infer<
  typeof organizationProviderIdSchema
>;

/**
 * Every provider: an organization's, and ElevenLabs, which only Grasp's
 * own speech feature reaches, on Grasp's key (@grasp-os/shared/platform-ai).
 */
export const aiProviderIds = [
  ...organizationProviderIds,
  "elevenlabs",
] as const;
export const aiProviderIdSchema = z.enum(aiProviderIds);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

/** The APIs a provider speaks, as pi's adapters name them. */
export type AiProviderApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions";

/** The one request header a provider takes its key in. */
export type AiKeyHeader = "x-api-key" | "xi-api-key" | "authorization";

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
   * an OpenAI-compatible endpoint, below its base URL's own path. A `*`
   * segment is one ID of letters and digits, such as a voice's.
   */
  paths: readonly string[];
  /**
   * The queries a model request may carry, each exactly and naming no
   * data; `""` where it may carry none. ElevenLabs's has no `""`: a line
   * without `enable_logging=false` would be kept by ElevenLabs.
   */
  queries: readonly string[];
  /**
   * The paths below its host a realtime WebSocket may open, with the one
   * query each takes, and nothing else: OpenAI's realtime transcription,
   * for Grasp's live listening (platform features only, never an
   * organization's key). Empty for a provider with none.
   */
  realtime: readonly { path: string; query: string }[];
  /** Where its key goes: `x-api-key: <key>`, `xi-api-key: <key>` or `authorization: Bearer <key>`. */
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
    | "ELEVENLABS_API_KEY"
    | undefined;
  /**
   * The model a test of a newly added key asks, one of the cheapest of its
   * catalog; none for an OpenAI-compatible endpoint, which names its own.
   */
  testModel: string | undefined;
  /**
   * Where the provider says how its service is doing, to look at while it
   * isn't answering; none for an endpoint of the organization's own.
   */
  statusPage: string | undefined;
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
    // Anthropic's SDK asks its beta Messages API, which names no data.
    queries: ["", "?beta=true"],
    realtime: [],
    keyHeader: "x-api-key",
    whereItRuns: "Anthropic, United States",
    region: "us",
    platformSecret: "ANTHROPIC_API_KEY",
    testModel: "anthropic/claude-haiku-4-5",
    statusPage: "https://status.anthropic.com",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrls: {
      "openai-responses": "https://api.openai.com/v1",
      "openai-completions": "https://api.openai.com/v1",
    },
    // Its audio endpoints too, for Grasp's own speech and transcription
    // (@grasp-os/shared/platform-ai): models, never files or an account's.
    paths: [
      "/v1/responses",
      "/v1/chat/completions",
      "/v1/audio/transcriptions",
    ],
    queries: [""],
    realtime: [{ path: "/v1/realtime", query: "?intent=transcription" }],
    keyHeader: "authorization",
    whereItRuns: "OpenAI, United States",
    region: "us",
    platformSecret: "OPENAI_API_KEY",
    testModel: "openai/gpt-5-mini",
    statusPage: "https://status.openai.com",
  },
  mistral: {
    id: "mistral",
    label: "Mistral AI",
    baseUrls: { "openai-completions": "https://api.mistral.ai/v1" },
    paths: ["/v1/chat/completions"],
    queries: [""],
    realtime: [],
    keyHeader: "authorization",
    whereItRuns: "Mistral AI, European Union (France)",
    region: "eu",
    platformSecret: "MISTRAL_API_KEY",
    testModel: "mistral/mistral-small-latest",
    statusPage: "https://status.mistral.ai",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrls: {
      "anthropic-messages": "https://openrouter.ai/api",
      "openai-completions": "https://openrouter.ai/api/v1",
    },
    paths: ["/api/v1/messages", "/api/v1/chat/completions"],
    queries: [""],
    realtime: [],
    keyHeader: "authorization",
    whereItRuns:
      "OpenRouter, United States, passing each call on to the model's provider",
    region: "us",
    platformSecret: "OPENROUTER_API_KEY",
    testModel: "openrouter/openai/gpt-5-mini",
    statusPage: "https://status.openrouter.ai",
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    baseUrls: {},
    paths: ["/chat/completions"],
    queries: [""],
    realtime: [],
    keyHeader: "authorization",
    whereItRuns: "Wherever your endpoint runs",
    region: "custom",
    platformSecret: undefined,
    testModel: undefined,
    statusPage: undefined,
  },
  // Grasp's own speech feature only, never an organization's key: a line
  // said with when each character is said, kept by neither side.
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs",
    baseUrls: {},
    paths: ["/v1/text-to-speech/*/with-timestamps"],
    queries: ["?enable_logging=false&output_format=mp3_44100_128"],
    realtime: [],
    keyHeader: "xi-api-key",
    whereItRuns: "ElevenLabs, United States",
    region: "us",
    platformSecret: "ELEVENLABS_API_KEY",
    testModel: undefined,
    statusPage: "https://status.elevenlabs.io",
  },
};

/** The host a fixed provider's requests go to; none for a custom endpoint. */
export const aiProviderHost = (provider: AiProviderId): string | undefined => {
  const [base] = Object.values(aiProviders[provider].baseUrls);
  return base === undefined ? undefined : new URL(base).hostname;
};

/**
 * Where Grasp's own projects at OpenAI and ElevenLabs keep their data: the
 * EU (data residency projects, each answered at its provider's EU host
 * only) or the US. The platform's AI settings say which
 * (@grasp-os/shared/platform-ai).
 */
export const platformRegions = ["eu", "us"] as const;
export type PlatformRegion = (typeof platformRegions)[number];

/**
 * The hosts Grasp's own key for a provider goes to, by its project's
 * region, for a provider whose host depends on it: OpenAI's and
 * ElevenLabs's.
 */
const platformHosts: Readonly<
  Partial<Record<AiProviderId, Readonly<Record<PlatformRegion, string>>>>
> = {
  openai: { eu: "eu.api.openai.com", us: "api.openai.com" },
  // ElevenLabs's EU data residency host, for a workspace there.
  elevenlabs: { eu: "api.eu.residency.elevenlabs.io", us: "api.elevenlabs.io" },
};

/** Where a platform feature's requests go on Grasp's own key, and where that is. */
export interface PlatformRoute {
  host: string;
  /** Its region, as the model ledger and the rules take it. */
  region: AiProviderSpec["region"];
  /** Where it runs, in plain words. */
  whereItRuns: string;
}

const regionWords: Readonly<Record<PlatformRegion, string>> = {
  eu: "European Union",
  us: "United States",
};

/**
 * Where Grasp's own key for `provider` sends a platform feature's
 * requests, its project in `region`: the one place a platform region
 * becomes a host. None for a provider without a fixed host.
 */
export const platformRouteOf = (
  provider: AiProviderId,
  region: PlatformRegion
): PlatformRoute | undefined => {
  const regional = platformHosts[provider];
  if (regional !== undefined) {
    return {
      host: regional[region],
      region,
      whereItRuns: `${aiProviders[provider].label}, ${regionWords[region]}`,
    };
  }
  const host = aiProviderHost(provider);
  return host === undefined
    ? undefined
    : {
        host,
        region: aiProviders[provider].region,
        whereItRuns: aiProviders[provider].whereItRuns,
      };
};

/**
 * Every host Grasp's own key for `provider` may be sent to, whichever
 * region its project is in: connect's allow-list for platform requests,
 * whose grant names the one host core chose (`platformRouteOf`).
 */
export const platformHostsOf = (provider: AiProviderId): string[] => {
  const regional = platformHosts[provider];
  if (regional !== undefined) {
    return Object.values(regional);
  }
  const host = aiProviderHost(provider);
  return host === undefined ? [] : [host];
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
  "upgrade",
  "body",
  "stored",
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

/**
 * The organization's models as they stand, each of a provider it still
 * has connected: its default, none once the provider it was of is
 * removed, until an admin chooses another; and its fallbacks.
 */
export const aiModelChoiceNowSchema = z.strictObject({
  defaultModel: aiModelChoiceSchema.shape.defaultModel.nullable(),
  fallbacks: aiModelChoiceSchema.shape.fallbacks,
});
export type AiModelChoiceNow = z.output<typeof aiModelChoiceNowSchema>;

/** A key connect keeps, as it shows it: never the key, only its mask. */
export interface AiProviderKey {
  provider: OrganizationProviderId;
  /** The key's last four characters, such as `…a3f2`: never its start. */
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
  organization: { provider: OrganizationProviderId; baseUrl: string | null }[];
  platform: AiProviderId[];
}

/** How a provider's calls went lately, from the model ledger. */
export interface AiProviderStatus {
  /** When a call last worked, and last failed, in ms since the epoch. */
  lastOkAt: number | null;
  lastFailedAt: number | null;
  /** How it last failed: `auth`, `quota`, `rate_limited`, `refused`, `provider_down`. */
  lastFailure: string | null;
  lastStatus: number | null;
  /**
   * What its calls show now, by what was seen (`ProviderTrouble`); null
   * while the last call worked, or once its key was replaced.
   */
  failingClass: ProviderTrouble | null;
  /**
   * Since when they show it: the first failure of that kind after the
   * last call that worked.
   */
  failingSince: number | null;
}

/** A model an admin can choose, by `<provider>/<model>`, with its name. */
export interface AiProviderModel {
  model: string;
  /** Its name for people, as the provider's catalog has it. */
  name: string;
}

/**
 * What a provider's failing calls show, by the HTTP class seen, never a
 * guess at why: it refuses the key (401, 403), it isn't answering (5xx,
 * a timeout, no answer at all), or it is limiting requests (429, or an
 * account's rate or spending limit).
 */
export const providerTroubles = [
  "refused",
  "not_answering",
  "limiting",
] as const;
export type ProviderTrouble = (typeof providerTroubles)[number];

/** One of the organization's providers, as its admins see it. */
export interface AiProviderListed extends AiProviderKey {
  label: string;
  whereItRuns: string;
  /** None until a call went through it. */
  status: AiProviderStatus | null;
  /**
   * The models it offers to choose from; none for an OpenAI-compatible
   * endpoint, whose models the organization names itself.
   */
  models: AiProviderModel[];
}

/** Grasp's own AI features, which Grasp pays for, on its own keys. */
export const aiPlatformFeatures = [
  "conversion",
  "transcription",
  "speech",
] as const;
export type AiPlatformFeature = (typeof aiPlatformFeatures)[number];

/**
 * Who handles one of Grasp's own AI features for this deployment, whatever
 * provider the organization connected: always on Grasp's key, never its
 * own, so its admins see where that data goes.
 */
export interface AiPlatformUse {
  feature: AiPlatformFeature;
  /** The provider, and where it runs; none when the deployment does it itself. */
  provider: { id: AiProviderId; label: string; whereItRuns: string } | null;
  /**
   * Off on this deployment: it keeps everything in the EU, and Grasp's
   * project for the provider isn't there, so nothing is sent at all.
   */
  off: boolean;
}

/** The organization's AI providers and its choice of models. */
export interface AiProvidersListing {
  providers: AiProviderListed[];
  /** Every provider an admin can add, with where it runs. */
  offered: {
    provider: OrganizationProviderId;
    label: string;
    whereItRuns: string;
  }[];
  /** The models its calls use, as they stand; none until an admin chose. */
  choice: AiModelChoiceNow | null;
  /**
   * Who handles Grasp's own AI features (document conversion,
   * transcription, speech), on Grasp's keys; none of a feature this
   * deployment doesn't have, or whose settings don't parse.
   */
  platform: AiPlatformUse[];
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
  "ai_provider.failed":
    "The key couldn't be saved or removed. Try again, or ask Grasp to check the deployment.",
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
  test: (
    provider: OrganizationProviderId,
    model?: string
  ) => Promise<AiProviderTest>;
  /** Sets the default model and its fallbacks, each a connected provider's. */
  setModels: (choice: z.input<typeof aiModelChoiceSchema>) => Promise<void>;
  /** Removes the provider's key; connect deletes it. */
  remove: (provider: OrganizationProviderId) => Promise<void>;
}

/** A key core hands connect to keep, as an admin gave it. */
export const aiProviderKeySaveSchema = z.strictObject({
  provider: organizationProviderIdSchema,
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
  "ai_key.failed": "The key couldn't be saved or removed.",
});

/**
 * What core reaches in connect for AI providers, over the `CONNECT`
 * service binding. No method returns a key.
 */
export interface AiProviderConnectApi {
  /**
   * Seals and keeps the organization's key for a provider, replacing any,
   * and records it for the audit log in the same write, in `by`'s name.
   */
  saveAiProviderKey: (
    request: AiProviderKeySave,
    by: AuditActor
  ) => Promise<AiProviderKey>;
  /**
   * Deletes the organization's key for a provider, recorded for the audit
   * log in the same write, in `by`'s name; whether it had one.
   */
  removeAiProviderKey: (
    provider: AiProviderId,
    by: AuditActor
  ) => Promise<boolean>;
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
   * (`aiRefusedHeader`). Stops the request, before its answer began, when
   * a byte arrives on `stop` or it breaks; `stop` closing says the
   * answer began (core's model-transport-connect.ts). Without one, only
   * the call's deadline stops it.
   */
  modelFetch: (
    request: Request,
    grant: string,
    stop?: ReadableStream<Uint8Array>
  ) => Promise<Response>;
}

/**
 * The header a realtime WebSocket's upgrade to connect carries its model
 * grant in (connect's `fetch`, `modelSocket`): an upgrade can't go over
 * RPC, so it goes over the service binding's `fetch`, to the provider's
 * own URL, with the placeholder where the key goes.
 */
export const aiGrantHeader = "x-grasp-model-grant";
