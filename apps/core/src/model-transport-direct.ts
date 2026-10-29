import type {
  Api,
  FetchFunction,
  Model,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import type {
  ModelProviderKeys,
  ModelTransport as TransportConfig,
} from "@grasp-os/shared/model-transport";

import { isRouteApi, maxTokensOf, providerNames } from "./model-catalog.ts";
import type { ModelRef, Provider } from "./model-catalog.ts";
import { checkEndpoint } from "./model-endpoint-guard.ts";
import type { EndpointPolicy } from "./model-endpoint-guard.ts";
import type { ModelTransport, TransportRoute } from "./model-transport.ts";

// The transports that reach a model over HTTPS from core itself, with a
// provider key: each provider's own API (`direct`), OpenRouter, and an
// OpenAI-compatible endpoint such as a client's Azure OpenAI. They run on
// plain workerd as on Cloudflare: only `fetch`. Threat model, and how each
// is closed:
//
// - A key leaks: keys come from the `MODEL_PROVIDER_KEYS` secret only
//   (@grasp-os/shared/model-transport), go in the request's auth header to
//   the one host its route names, and nowhere else. The host is checked on
//   every request (`pinnedFetch`), so no redirect, SDK default or
//   misconfiguration sends a key elsewhere; nothing logs a header, and a
//   refusal's body is read for its error codes only (models.ts).
// - A prompt or an answer leaks into a log: each request asks the
//   endpoint not to keep or train on it where the endpoint takes such a
//   request (OpenRouter's `provider.data_collection`, OpenAI's
//   `store: false`, which pi sets); the gateway's own logs are metadata
//   only, whatever the transport.
// - A custom endpoint aims core's fetch elsewhere (SSRF):
//   src/model-endpoint-guard.ts, on the route and on every request.
// - A request is re-sent after it may have been billed: these transports
//   leave retries to the gateway (`sdkRetries: false`), which retries only
//   what the endpoint refused before taking it on (models.ts).

/** Each provider's own endpoint for the API its models speak. */
const directHosts: Readonly<Partial<Record<Provider, string>>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  // Claude in Amazon Bedrock, Frankfurt: the Messages API, through each
  // model's EU inference profile (model-catalog.ts).
  "bedrock-eu": "https://bedrock-mantle.eu-central-1.api.aws/anthropic",
};

/** OpenRouter's endpoint for each API. */
const openRouterBases: Readonly<Partial<Record<Api, string>>> = {
  "anthropic-messages": "https://openrouter.ai/api",
  "openai-completions": "https://openrouter.ai/api/v1",
};

/** Whether an HTTP status sends the client elsewhere. */
const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/** The URL a fetch is asked for, whatever form it came in. */
const urlOf = (input: Parameters<FetchFunction>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/**
 * A fetch that sends only to `host`, checked by the endpoint guard under
 * `policy`, follows no redirect (a 3xx is a refusal), and throws for
 * anything else before a byte is sent.
 */
export const pinnedFetch =
  (host: string, policy: EndpointPolicy): FetchFunction =>
  async (input, init) => {
    const checked = checkEndpoint(urlOf(input), policy);
    if ("refused" in checked || checked.host !== host) {
      throw new Error("The model request's endpoint isn't its route's");
    }
    const answered = await fetch(checked.url, { ...init, redirect: "manual" });
    if (isRedirect(answered.status)) {
      // Never followed: an endpoint that moves is refused, its body unread.
      await answered.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return answered;
  };

/** The request ID a direct request carries, for the endpoint's own logs. */
const tagged = (init: RequestInit | undefined, id: string): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", id);
  return { ...init, headers };
};

/** The ID the endpoint logged a request under: its own request ID. */
const logIdOf = (headers: Record<string, string>): string | undefined =>
  headers["request-id"] ??
  headers["x-request-id"] ??
  headers["x-amzn-requestid"] ??
  headers["apim-request-id"];

/** The headers that carry `key` to an endpoint speaking `api`. */
const authHeaders = (api: Api, key: string): ProviderHeaders => {
  // The Messages API takes its key as `x-api-key`; Bedrock's mantle
  // endpoint takes a Bedrock API key as a bearer token.
  const bearer = { Authorization: `Bearer ${key}` };
  return api === "anthropic-messages"
    ? { "x-api-key": key, ...bearer }
    : bearer;
};

/** A route's fields that don't depend on the transport. */
interface RouteParts {
  transport: TransportRoute["transport"];
  label: string;
  ref: ModelRef;
  model: Model<Api>;
  key: string;
  policy: EndpointPolicy;
  extraHeaders?: ProviderHeaders;
  onPayload?: TransportRoute["onPayload"];
  euAttested?: boolean;
}

/** The route `parts` describe, or none for an endpoint the guard refuses. */
const routeOf = ({
  transport,
  label,
  ref,
  model,
  key,
  policy,
  extraHeaders,
  onPayload,
  euAttested = false,
}: RouteParts): TransportRoute | undefined => {
  const { api } = model;
  const checked = checkEndpoint(model.baseUrl, policy);
  if ("refused" in checked || !isRouteApi(api)) {
    return undefined;
  }
  return {
    transport,
    label,
    provider: ref.provider,
    privateHost: checked.privateHost,
    euAttested,
    model,
    api,
    host: checked.host,
    headers: { ...authHeaders(api, key), ...extraHeaders },
    fetch: pinnedFetch(checked.host, policy),
    onPayload,
    tagged,
    logIdOf,
  };
};

/** What a keyless endpoint is sent in place of a key. */
const keylessToken = "none";

/** No transport here offers voice models, nor retries on its own. */
const httpsCapabilities = (providers: readonly Provider[]) => ({
  providers,
  payloadLoggingOff: true,
  sharedCacheOff: true,
  voice: false,
  sdkRetries: false,
});

/** The provider key named `name`, if the deployment has it. */
const keyNamed = (
  keys: ModelProviderKeys,
  name: string | undefined
): string | undefined =>
  name !== undefined && Object.hasOwn(keys, name) ? keys[name] : undefined;

/** Each provider's own API, with the keys `config` names. */
export const directTransport = (
  config: Extract<TransportConfig, { kind: "direct" }>,
  keys: ModelProviderKeys,
  policy: EndpointPolicy
): ModelTransport => {
  const configured: Partial<Record<Provider, string>> = {
    anthropic: config.anthropic?.key,
    openai: config.openai?.key,
    "bedrock-eu": config["bedrock-eu"]?.key,
  };
  const reachable = providerNames.filter(
    (provider) =>
      directHosts[provider] !== undefined && configured[provider] !== undefined
  );
  return {
    kind: "direct",
    label: "direct",
    capabilities: httpsCapabilities(reachable),
    // oxlint-disable-next-line require-await -- the interface's
    route: async (ref): Promise<TransportRoute | undefined> => {
      const base = directHosts[ref.provider];
      const key = keyNamed(keys, configured[ref.provider]);
      if (base === undefined || key === undefined) {
        return undefined;
      }
      return routeOf({
        transport: "direct",
        label: "direct",
        ref,
        model: { ...ref.catalog, baseUrl: base, maxTokens: maxTokensOf(ref) },
        key,
        policy,
      });
    },
  };
};

/** A version's two numbers at the end of a model's ID, such as `-5-5`. */
const versionPattern = /-(?<major>\d+)-(?<minor>\d+)$/u;

/**
 * A model's name at OpenRouter: the provider's, with a dot between a
 * version's numbers (`claude-opus-5-5` is `anthropic/claude-opus-5.5`).
 */
const openRouterIdOf = (ref: ModelRef): string =>
  `${ref.provider}/${ref.id.replace(versionPattern, "-$<major>.$<minor>")}`;

/**
 * Asks OpenRouter to route only to endpoints that neither keep nor train
 * on the call (`data_collection: "deny"`, zero data retention).
 */
const openRouterPayload = (payload: unknown): unknown =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? {
        ...payload,
        provider: { data_collection: "deny", zdr: true },
      }
    : undefined;

/** OpenRouter, with the key `config` names: Anthropic's and OpenAI's models. */
export const openRouterTransport = (
  config: Extract<TransportConfig, { kind: "openrouter" }>,
  keys: ModelProviderKeys,
  policy: EndpointPolicy
): ModelTransport => ({
  kind: "openrouter",
  label: "openrouter",
  capabilities: httpsCapabilities(["anthropic", "openai"]),
  route: async (ref): Promise<TransportRoute | undefined> => {
    const key = keyNamed(keys, config.key);
    if (
      key === undefined ||
      (ref.provider !== "anthropic" && ref.provider !== "openai")
    ) {
      return undefined;
    }
    // Loaded the first time: OpenRouter's catalog is large.
    const { OPENROUTER_MODELS } =
      await import("@earendil-works/pi-ai/providers/openrouter.models");
    const catalog: Readonly<Record<string, Model<Api>>> = OPENROUTER_MODELS;
    const id = openRouterIdOf(ref);
    const entry = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    const base = entry === undefined ? undefined : openRouterBases[entry.api];
    if (entry === undefined || base === undefined) {
      return undefined;
    }
    return routeOf({
      transport: "openrouter",
      label: "openrouter",
      ref,
      // OpenRouter's descriptor for the API and its quirks, the provider's
      // limits and list prices (model-catalog.ts).
      model: {
        ...entry,
        baseUrl: base,
        cost: ref.catalog.cost,
        contextWindow: ref.catalog.contextWindow,
        maxTokens: Math.min(entry.maxTokens, maxTokensOf(ref)),
      },
      key,
      policy,
      onPayload: openRouterPayload,
    });
  },
});

/**
 * An OpenAI-compatible endpoint: chat completions at its base URL, for
 * the allowed models it names, each by its name there.
 */
export const compatibleTransport = (
  config: Extract<TransportConfig, { kind: "openai-compatible" }>,
  keys: ModelProviderKeys,
  policy: EndpointPolicy
): ModelTransport => {
  const label = `openai-compatible/${config.name}`;
  const served = Object.keys(config.models);
  return {
    kind: "openai-compatible",
    label,
    capabilities: httpsCapabilities(
      providerNames.filter((provider) =>
        served.some((ref) => ref.startsWith(`${provider}/`))
      )
    ),
    // oxlint-disable-next-line require-await -- the interface's
    route: async (ref): Promise<TransportRoute | undefined> => {
      const name = `${ref.provider}/${ref.id}`;
      const upstream = Object.hasOwn(config.models, name)
        ? config.models[name]
        : undefined;
      // An endpoint on the deployment's own network may take no key: pi's
      // adapter still wants auth before it sends, so a placeholder.
      const key =
        config.key === undefined ? keylessToken : keyNamed(keys, config.key);
      if (upstream === undefined || key === undefined) {
        return undefined;
      }
      // Chat completions, as the endpoint speaks them, not the provider's
      // own API's quirks.
      const { compat: _compat, ...catalog } = ref.catalog;
      return routeOf({
        transport: "openai-compatible",
        label,
        ref,
        model: {
          ...catalog,
          id: upstream,
          api: "openai-completions",
          baseUrl: config.baseUrl.replace(/\/$/u, ""),
          maxTokens: maxTokensOf(ref),
        },
        key,
        policy,
        // Azure OpenAI takes its key as `api-key`.
        extraHeaders: key === keylessToken ? {} : { "api-key": key },
        euAttested: config.euAttestation !== undefined,
      });
    },
  };
};
