import type {
  Api,
  AssistantMessageEventStream,
  FetchFunction,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";

import { adapterFor } from "./model-catalog.ts";
import type { ModelRef, Provider, RouteApi } from "./model-catalog.ts";

// How the model gateway (models.ts) reaches a model: a transport. The
// gateway stays the one choke point whatever the transport: the
// organization's chosen models and the rules (model-rules.ts), the budgets
// (model-budgets.ts), the model ledger's admission of every provider
// request before it is sent, and the audit log all run before and around
// it, never inside it. A transport only says where a request goes and how
// it is authenticated: the endpoint, the model's name there, the headers,
// and the fetch that carries it. Everything a transport sends goes through
// the fetch the gateway wraps around it (`open` in models.ts), so no
// request leaves unadmitted, uncounted or unaudited.
//
// The interface:
// - Streaming and whole answers: `streamRoute` streams one request with
//   pi's adapter for the route's API; a whole answer is the stream read to
//   its end (models.ts, `send`).
// - Cancellation and timeouts: the caller's `AbortSignal`, which the
//   gateway's deadline aborts (`@grasp-os/shared/deadline`), reaches the
//   adapter and the fetch, so a cancelled or late request is cut off at
//   the socket.
// - Typed failures: `failureOfResponse` names a refused response by what
//   it means for the caller (`TransportFailure`), from its status and
//   headers alone, never its body, which may quote the prompt.
// - Capabilities: which providers a transport reaches, and what it can
//   promise about payload logging and caching (`TransportCapabilities`).

/**
 * The ways a deployment can reach its models: the provider's own API,
 * through connect, which holds the key (model-transport-connect.ts).
 */
export const transportKinds = ["connect"] as const;
export type TransportKind = (typeof transportKinds)[number];

/** What a transport can do, as the gateway and the admin read it. */
export interface TransportCapabilities {
  /** The providers whose models it reaches. */
  providers: readonly Provider[];
  /**
   * Whether every request it sends asks for its prompt and answer not to
   * be logged by anything between the gateway and the model.
   */
  payloadLoggingOff: boolean;
  /**
   * Whether every request it sends asks not to be answered from a shared
   * cache: a cached answer is one person's, and would be served to
   * another.
   */
  sharedCacheOff: boolean;
}

/** One model reached one way: everything the gateway needs to send to it. */
export interface TransportRoute {
  transport: TransportKind;
  /** pi's model, pointed at the endpoint, under the name it has there. */
  model: Model<Api>;
  /** The API the endpoint speaks, which picks pi's adapter. */
  api: RouteApi;
  /** The endpoint's host, which every request the route sends must go to. */
  host: string;
  /** The headers every request carries: authentication, logging, caching. */
  headers: ProviderHeaders;
  /** What carries each request to the endpoint. */
  fetch: FetchFunction;
  /** The request's body as the endpoint takes it, where it differs from pi's. */
  onPayload?: (payload: unknown) => unknown;
  /**
   * `init` tagged with the provider request's ID, for the endpoint's own
   * logs, and the call's deadline (ms since the epoch), for a transport
   * that must cut the request off on its own side too.
   */
  tagged: (
    init: RequestInit | undefined,
    providerRequest: string,
    endsAt: number
  ) => RequestInit;
  /** The ID the endpoint logged the request under, from its response's headers. */
  logIdOf: (headers: Record<string, string>) => string | undefined;
}

/** A way to reach models. */
export interface ModelTransport {
  kind: TransportKind;
  capabilities: TransportCapabilities;
  /** The route to `ref`, or `undefined` when this transport doesn't reach it. */
  route: (ref: ModelRef) => TransportRoute | undefined;
}

/**
 * Why a provider request failed, as the gateway acts on it:
 * - `auth`: the endpoint refused the credentials (401, 403). Nothing was
 *   taken on; asking again the same way fails the same way.
 * - `rate_limited`: the endpoint is taking no more for now (429), with how
 *   long it asks to wait. Nothing was taken on.
 * - `refused`: the endpoint refused this request (another 4xx). Nothing
 *   was taken on.
 * - `provider_down`: the endpoint failed (5xx) or didn't answer. It may
 *   have taken the request on, and billed it: never sent again.
 * - `budget`: the model ledger held it back, unsent (models.ts sets this,
 *   never a response).
 */
export type TransportFailure =
  | { kind: "auth"; status: number }
  | { kind: "rate_limited"; status: number; retryAfterSeconds: number }
  | { kind: "refused"; status: number }
  | { kind: "provider_down"; status: number | undefined }
  | { kind: "budget" };

/** Whether a request that failed `failure`'s way can't have been billed. */
export const neverTakenOn = (failure: TransportFailure): boolean =>
  failure.kind !== "provider_down";

/**
 * What a refused response means (`TransportFailure`), from its status and
 * the wait it asks for, as core bounds it (`retryAfterSeconds`).
 */
export const failureOfResponse = (
  status: number,
  retryAfterSeconds: number
): TransportFailure => {
  if (status === 401 || status === 403) {
    return { kind: "auth", status };
  }
  if (status === 429) {
    return { kind: "rate_limited", status, retryAfterSeconds };
  }
  return status < 500
    ? { kind: "refused", status }
    : { kind: "provider_down", status };
};

/** What one streamed request takes beyond its route and conversation. */
export interface StreamOptions {
  /** The gateway's fetch around the route's: admission, accounting. */
  fetch: FetchFunction;
  maxTokens: number;
  reasoning: SimpleStreamOptions["reasoning"];
  signal: AbortSignal;
  onResponse: (response: {
    status: number;
    headers: Record<string, string>;
  }) => void;
}

/**
 * Streams one request along `route`: pi's adapter for its API, with the
 * route's model, headers and payload, and the gateway's fetch. pi reports
 * a failed request as the stream's last event instead of throwing.
 */
export const streamRoute = async (
  route: TransportRoute,
  context: TranscriptContext,
  options: StreamOptions
): Promise<AssistantMessageEventStream> => {
  const adapter = await adapterFor(route.api);
  return adapter(route.model, context, {
    fetch: options.fetch,
    headers: route.headers,
    maxTokens: options.maxTokens,
    // pi's provider SDKs never retry: the gateway retries only what can't
    // have been billed (models.ts), each retry admitted by the ledger.
    maxRetries: 0,
    reasoning: options.reasoning,
    signal: options.signal,
    onPayload: route.onPayload,
    onResponse: options.onResponse,
  });
};
