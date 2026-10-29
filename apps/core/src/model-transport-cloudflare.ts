import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";

import { isRouteApi, maxTokensOf, providerNames } from "./model-catalog.ts";
import type { Provider } from "./model-catalog.ts";
import type {
  ModelTransport,
  RouteMetadata,
  TransportRoute,
} from "./model-transport.ts";

// Cloudflare AI Gateway over the AI binding: the deployment's gateway
// (`MODEL_GATEWAY.gateway`) pays with Workers AI, Unified Billing
// (Cloudflare credits) or the client's own keys stored in the gateway, and
// core reaches it over the AI binding, which needs no token either: core
// holds no provider key. The gateway logs metadata only and never answers
// from its cache (`gatewayHeaders`).
//
// Only providers whose pi adapter takes a custom fetch can ride the
// binding. Google's refuses one, so Google models would need a gateway
// token over HTTPS, and aren't offered.
//
// Claude in the EU (GRA-702): AI Gateway reaches Claude in Amazon Bedrock
// as a custom provider of the deployment's gateway, `custom-bedrock-eu`,
// whose base URL is Frankfurt's endpoint
// (`https://bedrock-mantle.eu-central-1.api.aws/anthropic`) and which holds
// the Bedrock key, as `custom-elevenlabs-eu` does for ElevenLabs's EU host.
// Each model is asked for by its EU inference profile
// (`eu.anthropic.<model>`), which routes only within the EU's regions.

/** The host the AI binding's requests name; the binding carries the account. */
export const aiBindingHost = "workers-binding.ai";

/**
 * Each provider's route at the gateway: its native API's path, or the
 * custom provider for Bedrock's EU endpoint. Workers AI's own
 * OpenAI-compatible endpoint, not the gateway's cross-provider /compat
 * layer, which drops provider features.
 */
const gatewayPaths: Readonly<Record<Provider, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  "bedrock-eu": "custom-bedrock-eu",
  "workers-ai": "workers-ai/v1",
};

/** The gateway's base URL over the AI binding, the account left to the binding. */
export const gatewayBase = (gateway: string): string =>
  `https://${aiBindingHost}/ai-gateway/gateways/${gateway}`;

/**
 * The headers every request to the gateway carries, a voice model's too
 * (models.ts): no prompt or answer logged, no cached answer, and its
 * metadata for the gateway's log, identifiers only.
 */
export const gatewayHeaders = (metadata: RouteMetadata): ProviderHeaders => ({
  // The binding authenticates the request. pi still wants auth before it
  // sends, and the gateway strips this placeholder. The nulls drop the
  // SDKs' own auth headers, which the gateway would take for a caller's
  // provider key instead of using its stored ones.
  "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
  Authorization: null,
  "x-api-key": null,
  // The gateway logs metadata, never prompts or answers.
  "cf-aig-collect-log-payload": "false",
  // Never an answer from the gateway's cache, whatever the gateway is set
  // to (one the admin adopted keeps its settings): a cached answer is
  // one person's, and would be served to another.
  "cf-aig-skip-cache": "true",
  // So the gateway's log can be searched by why and for what kind of
  // caller; identifiers only, like the audit event.
  "cf-aig-metadata": JSON.stringify({
    purpose: metadata.purpose,
    actor: metadata.actor,
    ...(metadata.requestId === undefined
      ? {}
      : { requestId: metadata.requestId }),
    // One entry, not two: the gateway keeps five, and the provider
    // request's ID (`withRequestId`) comes after these. A run ID holds no
    // slash, so the first one splits it from the step.
    ...(metadata.runStep === undefined
      ? {}
      : { runStep: `${metadata.runStep.runId}/${metadata.runStep.step}` }),
  }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `init` with the provider request's ID in the gateway log's metadata. */
export const withRequestId = (
  init: RequestInit | undefined,
  id: string
): RequestInit => {
  const headers = new Headers(init?.headers);
  let metadata: unknown = undefined;
  try {
    metadata = JSON.parse(headers.get("cf-aig-metadata") ?? "{}");
  } catch {
    metadata = {};
  }
  headers.set(
    "cf-aig-metadata",
    JSON.stringify({
      ...(isRecord(metadata) ? metadata : {}),
      providerRequest: id,
    })
  );
  return { ...init, headers };
};

/**
 * The request as Workers AI takes it. pi sends an assistant message that
 * only calls tools with `null` content, as OpenAI's API allows, but Workers
 * AI's models take text only and refuse the request (400, "Type mismatch
 * of '/messages/2/content', 'string' not in 'null'"): every request after
 * an agent's first tool call failed. Such content goes as empty text.
 */
const workersAiPayload = (payload: unknown): unknown => {
  if (!(isRecord(payload) && Array.isArray(payload.messages))) {
    return undefined;
  }
  return {
    ...payload,
    messages: payload.messages.map((message: unknown) =>
      isRecord(message) &&
      message.role === "assistant" &&
      message.content === null
        ? { ...message, content: "" }
        : message
    ),
  };
};

/**
 * The deployment's AI Gateway `gateway`, over the AI binding `ai`: every
 * provider the gateway offers, through the gateway's route for its
 * native API, the same path as over HTTPS minus the account.
 */
export const cloudflareAiGateway = (
  ai: AiBinding,
  gateway: string
): ModelTransport => {
  const fetch = createAiBindingFetch(ai);
  return {
    kind: "cloudflare-ai-gateway",
    label: "cloudflare-ai-gateway",
    capabilities: {
      providers: providerNames,
      payloadLoggingOff: true,
      sharedCacheOff: true,
      voice: true,
      sdkRetries: true,
    },
    // oxlint-disable-next-line require-await -- the interface's: other transports load their catalogs
    route: async (ref, metadata): Promise<TransportRoute | undefined> => {
      const { api } = ref.catalog;
      if (!isRouteApi(api)) {
        return undefined;
      }
      return {
        transport: "cloudflare-ai-gateway",
        label: "cloudflare-ai-gateway",
        provider: ref.provider,
        privateHost: false,
        euAttested: false,
        model: {
          ...ref.catalog,
          baseUrl: `${gatewayBase(gateway)}/${gatewayPaths[ref.provider]}`,
          maxTokens: maxTokensOf(ref),
        },
        api,
        host: aiBindingHost,
        headers: gatewayHeaders(metadata),
        fetch,
        onPayload: ref.provider === "workers-ai" ? workersAiPayload : undefined,
        tagged: withRequestId,
        logIdOf: (headers) => headers["cf-aig-log-id"],
      };
    },
  };
};
