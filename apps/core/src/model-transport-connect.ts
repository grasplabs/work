import type {
  Api,
  FetchFunction,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
  aiCredentialPlaceholder,
  aiGrantHeader,
  aiProviderHost,
  aiProviders,
  aiRefusedHeader,
} from "@grasp-os/shared/ai-providers";
import type {
  AiCredentialSource,
  AiProviderId,
} from "@grasp-os/shared/ai-providers";
import { signModelGrant } from "@grasp-os/shared/capability";
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";

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
// provider, the host, the ledger's ID for it and its body's hash. Core never sees a key:
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

/**
 * The way core tells connect to stop a request it sent (`modelFetch`'s
 * `stop`): an AbortSignal can't cross the service binding, a byte stream
 * can. Connect stops the provider's request when a byte arrives on it, or
 * when it breaks (core went away); it closing means core saw the answer
 * begin, and from then on cancelling the answer's body stops it, as for
 * any fetch.
 */
const stopLine = (): {
  stop: ReadableStream<Uint8Array>;
  /** Asks connect to stop the request. */
  cancel: () => void;
  /** Says the answer began, so there is nothing left to stop this way. */
  close: () => void;
} => {
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();
  // Said once, the first of the two ending the line, and never waited
  // for: the stream holds no byte until connect reads it, and one connect
  // stopped reading (its request ended) has nothing left to tell.
  let said = false;
  const say = async (stopping: boolean): Promise<void> => {
    if (said) {
      return;
    }
    said = true;
    try {
      if (stopping) {
        await writer.write(new Uint8Array([1]));
      }
      await writer.close();
    } catch {
      // Connect stopped reading: the request ended there.
    }
  };
  return {
    stop: readable,
    cancel: () => {
      void say(true);
    },
    close: () => {
      void say(false);
    },
  };
};

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
 * Hands one admitted request to connect with its grant, until `endsAt`,
 * which connect cuts it off at too, or until `signal` is aborted, when
 * connect is told to stop it, so a provider still thinking bills nothing
 * more, and its answer, should one come anyway, is cancelled unread. A
 * request connect couldn't
 * get an answer for throws; one it refused before sending comes back as
 * its refusal.
 */
const sendThroughConnect = async (
  env: ConnectEnv,
  target: ConnectTarget,
  host: string,
  request: Request,
  { ledgerRequest, endsAt, signal }: SentBy
): Promise<Response> => {
  const grant = await signModelGrant(env.CAPABILITY_SIGNING_KEY, {
    credential: target.credential,
    provider: target.provider,
    host,
    request: ledgerRequest,
    notAfter: endsAt,
    body: await sha256HexOfBytes(await request.clone().arrayBuffer()),
  });
  signal?.throwIfAborted();
  const line = stopLine();
  const sent = env.CONNECT.modelFetch(request, grant, line.stop);
  const aborted = Promise.withResolvers<never>();
  const stop = () => {
    line.cancel();
    aborted.reject(signal?.reason);
  };
  signal?.addEventListener("abort", stop, { once: true });
  let answered: Response;
  try {
    answered = await Promise.race([sent, aborted.promise]);
  } catch (error) {
    line.cancel();
    void cancelLate(sent);
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  line.close();
  if (answered.headers.get(aiRefusedHeader) === "unreachable") {
    await answered.body?.cancel();
    throw new ConnectUnansweredError();
  }
  return answered;
};

/** What one request through connect is admitted as: the ledger's ID, the deadline. */
export interface SentBy {
  ledgerRequest: string;
  endsAt: number;
  signal?: AbortSignal;
}

/**
 * The URL of `path` at `target`'s provider, for a platform feature's
 * request of its own (speech, a recording written down): the provider's
 * own host. None for a provider without a fixed one.
 */
const platformUrl = (target: ConnectTarget, path: string): URL | undefined => {
  const host = aiProviderHost(target.provider);
  return host === undefined ? undefined : new URL(path, `https://${host}`);
};

/**
 * Sends one request of a platform feature (speech, a recording written
 * down) to `path` at `target`'s provider through connect, as the ledger
 * admitted it: the placeholder where the key goes, which connect replaces
 * with Grasp's key, and only the headers given.
 */
export const connectRequest = async (
  env: ConnectEnv,
  target: ConnectTarget,
  path: string,
  init: { headers: Record<string, string>; body: BodyInit },
  sentBy: SentBy
): Promise<Response> => {
  const url = platformUrl(target, path);
  if (url === undefined) {
    throw new Error("The provider has no host of its own");
  }
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(
    placeholderHeaders(target.provider)
  )) {
    if (value !== null) {
      headers.set(name, value);
    }
  }
  headers.set("x-request-id", sentBy.ledgerRequest);
  // Read whole first, a form's boundary in its content type, as a body
  // that streams can't cross the service binding with the request.
  const asked = new Request(url, { method: "POST", headers, body: init.body });
  const request = new Request(url, {
    method: "POST",
    headers: asked.headers,
    body: await asked.arrayBuffer(),
  });
  return await sendThroughConnect(
    env,
    target,
    url.hostname.toLowerCase(),
    request,
    sentBy
  );
};

/**
 * Opens a realtime WebSocket of a platform feature (live listening) to
 * `pathAndQuery` at `target`'s provider through connect, which holds the
 * key and relays the socket (connect's `modelSocket`): an upgrade can't
 * go over RPC, so it goes over the service binding's `fetch`, with the
 * grant in its own header. Throws when it won't open.
 */
export const connectSocket = async (
  env: ConnectEnv,
  target: ConnectTarget,
  pathAndQuery: string,
  { ledgerRequest, endsAt, signal }: SentBy
): Promise<WebSocket> => {
  const url = platformUrl(target, pathAndQuery);
  if (url === undefined) {
    throw new Error("The provider has no host of its own");
  }
  const grant = await signModelGrant(env.CAPABILITY_SIGNING_KEY, {
    credential: target.credential,
    provider: target.provider,
    host: url.hostname.toLowerCase(),
    request: ledgerRequest,
    notAfter: endsAt,
    // An upgrade has no body: what it sends goes over the socket.
    body: await sha256HexOfBytes(new ArrayBuffer(0)),
  });
  const headers = new Headers({ upgrade: "websocket", [aiGrantHeader]: grant });
  for (const [name, value] of Object.entries(
    placeholderHeaders(target.provider)
  )) {
    if (value !== null) {
      headers.set(name, value);
    }
  }
  const answered = await env.CONNECT.fetch(url, {
    headers,
    ...(signal === undefined ? {} : { signal }),
  });
  const socket = answered.webSocket;
  if (socket === null) {
    await answered.body?.cancel();
    throw new ConnectUnansweredError();
  }
  socket.accept();
  return socket;
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
    // Without the caller's signal, which can't cross the service binding:
    // `stopLine` carries it.
    const body = asked.method === "GET" ? null : await asked.arrayBuffer();
    const request = new Request(asked.url, {
      method: asked.method,
      headers,
      body,
    });
    return await sendThroughConnect(env, target, host, request, {
      ledgerRequest,
      endsAt,
      signal: asked.signal,
    });
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
