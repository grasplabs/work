import type { RouterHost } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";

/** The value tests give the router's key in the local Secrets Store. */
export const testRouterKey = "test-router-key";

/** What the local Secrets Store (Miniflare) offers tests to manage a secret. */
interface SecretsStoreAdmin {
  create: (value: string) => Promise<string>;
  delete: (id: string) => Promise<void>;
}

/**
 * The local Secrets Store's admin API for the router's key: how a test puts
 * the key in the store, or takes it out, as an operator would.
 */
export const routerKeyAdmin = async (): Promise<SecretsStoreAdmin> => {
  // SAFETY: Miniflare's local Secrets Store binding answers this method with
  // its admin API, whose `create` and `delete` have these signatures.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const admin = Reflect.get(
    env.ROUTER_KEY,
    "SecretsStoreSecret::admin_api"
  ) as () => Promise<SecretsStoreAdmin>;
  return await admin();
};

/** Puts `entry` in the hostname map, as the admin does. */
export const mapHost = async (
  host: string,
  entry: RouterHost | Record<string, unknown>
): Promise<void> => {
  await env.HOSTS.put(host, JSON.stringify(entry));
};

/** A request as it reached a core. */
interface Forwarded {
  url: string;
  method: string;
  redirect: string;
  headers: Headers;
  body: string;
}

type Answer = (request: Request) => Response | Promise<Response>;

/** How a core answers by default: WebSocket upgrades get an echo socket. */
const echo: Answer = (request) => {
  if (request.headers.get("upgrade") === "websocket") {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", (event) => {
      server.send(`echo: ${String(event.data)}`);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  return new Response(`core at ${new URL(request.url).host}`);
};

/**
 * A stand-in for the clients' core Workers, the only outside system the
 * router talks to: answers every forwarded request and records what arrived.
 */
export const fakeCores = () => {
  const received: Forwarded[] = [];
  let answer = echo;

  beforeEach(() => {
    received.length = 0;
    answer = echo;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      // Read here: a body can't be read outside the request that sent it.
      received.push({
        url: request.url,
        method: request.method,
        redirect: request.redirect,
        headers: new Headers(request.headers),
        body: await request.clone().text(),
      });
      return await answer(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    received,
    /** Makes every core answer with `respond` instead, for this test. */
    answerWith: (respond: Answer): void => {
      answer = respond;
    },
  };
};

/** A script's core by default: the core stand-in Worker (vite.config.ts). */
const throughStandIn: Answer = async (request) => {
  // SAFETY: vite.config.ts binds the core stand-in Worker as CORE_STAND_IN.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const core = Reflect.get(env, "CORE_STAND_IN") as Fetcher;
  return await core.fetch(request);
};

/** A request as it reached a client's script through the dispatch namespace. */
interface Dispatched extends Forwarded {
  script: string;
}

/**
 * A stand-in for the router's dispatch namespace (`DISPATCHER`), which runs
 * only on Cloudflare: `get(script)` hands back the client's core for each
 * of `scripts`, recording what reaches it, and throws for any other, as a
 * namespace does for a script it doesn't have. By default each core is
 * the core stand-in Worker (vite.config.ts), reached as a script is.
 */
export const fakeNamespace = (scripts: readonly string[]) => {
  const received: Dispatched[] = [];
  const asked: string[] = [];
  const known = new Set(scripts);
  let answer: Answer = throughStandIn;

  beforeEach(() => {
    received.length = 0;
    asked.length = 0;
    vi.spyOn(env.DISPATCHER, "get").mockImplementation((script) => {
      asked.push(script);
      if (!known.has(script)) {
        throw new Error(`Worker not found: ${script}`);
      }
      const userWorker: Pick<Fetcher, "fetch"> = {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          received.push({
            script,
            url: request.url,
            method: request.method,
            redirect: request.redirect,
            headers: new Headers(request.headers),
            body: await request.clone().text(),
          });
          return await answer(request);
        },
      };
      // SAFETY: a stand-in user Worker: only `fetch`, which the router calls.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return userWorker as Fetcher;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    received,
    /** Every script the router asked the namespace for, in order. */
    asked,
    /** Makes every script answer with `respond` instead, for this test. */
    answerWith: (respond: Answer): void => {
      answer = respond;
    },
  };
};
