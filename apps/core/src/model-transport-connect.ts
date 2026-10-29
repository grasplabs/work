import type {
  Api,
  FetchFunction,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
  aiCredentialPlaceholder,
  aiProviders,
  aiRefusedHeader,
} from "@grasp-os/shared/ai-providers";
import type {
  AiCredentialSource,
  AiProviderId,
} from "@grasp-os/shared/ai-providers";
import { signModelGrant } from "@grasp-os/shared/capability";

import { isRouteApi, maxTokensOf } from "./model-catalog.ts";
import type { ModelRef } from "./model-catalog.ts";
import type { ModelTransport, TransportRoute } from "./model-transport.ts";

// The provider's own API, reached through connect, which holds every key
// (connect's ai-providers.ts): the organization's own, or Grasp's for
// platform features. Core runs pi's adapter for the provider's API as for
// any route, with a fetch that hands each request, as the adapter made it,
// to connect over the `CONNECT` service binding (`modelFetch`), with a
// grant core signs for exactly that request once the ledger admitted it
// (@grasp-os/shared/capability, `signModelGrant`): the credential, the
// provider, the host and the ledger's ID for it. Core never sees a key:
// where the key goes, the adapter puts `aiCredentialPlaceholder`, which
// connect replaces. It runs on plain workerd as on Cloudflare: one service
// binding, no AI binding.
//
// The SDKs' own retries are off for these routes (`sdkRetries: false`):
// the gateway retries only a rate limit's refusal, within the call's
// deadline (models.ts, `open`).

/** Where an admitted call's requests go, and on whose key. */
export interface ConnectTarget {
  credential: AiCredentialSource;
  provider: AiProviderId;
  /** For an OpenAI-compatible endpoint, the base URL its key goes to. */
  baseUrl: string | null;
}

/**
 * The header `tagged` puts the ledger's ID for a request in, which the
 * route's fetch takes out again into the request's grant: it never reaches
 * connect or the provider as a header.
 */
const ledgerRequestHeader = "x-grasp-ledger-request";

/** The header `tagged` puts the call's deadline in, likewise taken out. */
const endsAtHeader = "x-grasp-ends-at";

/** The provider's own ID for a request, as its log names it. */
const requestIdHeaders = ["request-id", "x-request-id"] as const;

/** The base URL `ref`'s requests go to, for `target`; none when it has none. */
const baseUrlOf = (
  ref: ModelRef,
  target: ConnectTarget
): string | undefined => {
  if (target.provider === "openai-compatible") {
    return target.baseUrl ?? undefined;
  }
  const { api } = ref.catalog;
  return isRouteApi(api)
    ? aiProviders[target.provider].baseUrls[api]
    : undefined;
};

/**
 * The headers every request carries: the placeholder where the key goes,
 * in the one header the provider takes it in, and no SDK's own.
 */
const placeholderHeaders = (provider: AiProviderId): ProviderHeaders =>
  aiProviders[provider].keyHeader === "x-api-key"
    ? { "x-api-key": aiCredentialPlaceholder, Authorization: null }
    : { Authorization: `Bearer ${aiCredentialPlaceholder}`, "x-api-key": null };

/** The core env a connect route needs. */
type ConnectEnv = Pick<Env, "CONNECT" | "CAPABILITY_SIGNING_KEY">;

/** An error that names no URL, body or key: what a refusal of ours says. */
class ConnectUnansweredError extends Error {
  constructor() {
    super("The model's provider didn't answer");
    this.name = "ConnectUnansweredError";
  }
}

/** Cancels, unread, the answer to a request its caller stopped waiting for. */
const cancelLate = async (sent: Promise<Response>): Promise<void> => {
  try {
    const late = await sent;
    await late.body?.cancel();
  } catch {
    // It failed after all: nothing to cancel.
  }
};

/**
 * The fetch that hands each request to connect, with its grant; until
 * the call's deadline (`tagged`), which connect cuts it off at too. A
 * request connect couldn't get an answer for throws, as a fetch that got
 * none does; one it refused before sending comes back as its refusal.
 */
const connectFetch =
  (env: ConnectEnv, target: ConnectTarget, host: string): FetchFunction =>
  async (input, init) => {
    const asked = new Request(input, init);
    const headers = new Headers(asked.headers);
    const ledgerRequest = headers.get(ledgerRequestHeader);
    const endsAt = Number(headers.get(endsAtHeader) ?? Number.NaN);
    if (ledgerRequest === null || !Number.isSafeInteger(endsAt)) {
      // Never expected: the gateway tags every request it admitted.
      throw new Error("A model request reached connect unadmitted");
    }
    headers.delete(ledgerRequestHeader);
    headers.delete(endsAtHeader);
    headers.set("x-request-id", ledgerRequest);
    // Without the caller's signal, which can't cross the service binding.
    const request = new Request(asked.url, {
      method: asked.method,
      headers,
      body: asked.method === "GET" ? null : await asked.arrayBuffer(),
    });
    const { signal } = asked;
    const grant = await signModelGrant(env.CAPABILITY_SIGNING_KEY, {
      credential: target.credential,
      provider: target.provider,
      host,
      request: ledgerRequest,
      notAfter: endsAt,
    });
    // A request cut off here stops being waited for at once, and its
    // answer, should it come, is cancelled unread.
    signal.throwIfAborted();
    const sent = env.CONNECT.modelFetch(request, grant);
    const aborted = Promise.withResolvers<never>();
    const stop = () => {
      aborted.reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    let answered: Response;
    try {
      answered = await Promise.race([sent, aborted.promise]);
    } catch (error) {
      void cancelLate(sent);
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
    if (answered.headers.get(aiRefusedHeader) === "unreachable") {
      await answered.body?.cancel();
      throw new ConnectUnansweredError();
    }
    return answered;
  };

/**
 * The transport to `target`'s provider through connect: a route for each
 * of its models whose API it speaks, at its fixed base URL, or the
 * organization's for an OpenAI-compatible endpoint.
 */
export const connectTransport = (
  env: ConnectEnv,
  target: ConnectTarget
): ModelTransport => ({
  kind: "connect",
  capabilities: {
    providers: [target.provider],
    payloadLoggingOff: true,
    sharedCacheOff: true,
    voice: false,
    sdkRetries: false,
  },
  route: (ref): TransportRoute | undefined => {
    const base =
      ref.provider === target.provider ? baseUrlOf(ref, target) : undefined;
    const api: Api | undefined =
      ref.provider === "openai-compatible"
        ? "openai-completions"
        : ref.catalog.api;
    const host = base === undefined ? undefined : URL.parse(base)?.hostname;
    if (
      base === undefined ||
      host === undefined ||
      api === undefined ||
      !isRouteApi(api)
    ) {
      return undefined;
    }
    return {
      transport: "connect",
      model: {
        ...ref.catalog,
        api,
        baseUrl: base.replace(/\/+$/u, ""),
        maxTokens: maxTokensOf(ref),
      },
      api,
      host: host.toLowerCase(),
      headers: placeholderHeaders(target.provider),
      fetch: connectFetch(env, target, host.toLowerCase()),
      tagged: (init, id, endsAt) => {
        const headers = new Headers(init?.headers);
        headers.set(ledgerRequestHeader, id);
        headers.set(endsAtHeader, String(endsAt));
        return { ...init, headers };
      },
      logIdOf: (headers) =>
        requestIdHeaders
          .map((name) => headers[name])
          .find((value) => value !== undefined),
    };
  },
});
