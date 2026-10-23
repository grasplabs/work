/**
 * Microsoft's side of a client's Teams bot, as connect reaches it for
 * core's chat adapters (src/channels.ts): Entra's token endpoint in the
 * client's tenant, which issues the bot's token for its secret, and the
 * Bot Connector on its `serviceUrl` host, which takes activities only
 * with a token Entra issued. Any other host takes whatever it is sent, as
 * an attacker's would. Tests read back every request, and choose how the
 * next ones fare.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { teamsBot } from "./provider-config.ts";

/** Where the Bot Connector serves Teams in Europe. */
export const botConnectorHost = "smba.trafficmanager.net";

/** The `serviceUrl` a Teams activity names, as Teams sends it. */
export const serviceUrl = `https://${botConnectorHost}/emea/`;

const loginHost = "login.microsoftonline.com";

const botFrameworkScope = "https://api.botframework.com/.default";

/** One request that reached Microsoft's hosts or an attacker's. */
export interface SentRequest {
  method: string;
  host: string;
  path: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: string;
}

/** How the Bot Connector answers the next request instead. */
export interface Failure {
  status: number;
  headers?: HeadersInit;
  /**
   * The request was carried out before the failure, as when a gateway
   * times out on a send Teams went on to post.
   */
  carriedOut?: boolean;
}

const activityPath =
  /\/v3\/conversations\/(?<conversation>[^/]+)\/activities(?:\/(?<activity>[^/]+))?$/u;

/** The fake, for each test in the file. */
export const fakeBotConnector = () => {
  // Kept across tests, as Entra keeps them: connect caches the token it
  // got for a secret, so each test takes a bot of its own (`bot()`).
  const secrets = new Set<string>([teamsBot.secret]);
  const issued = new Set<string>();
  const sent: SentRequest[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const removed = new Set<string>();
  let failures: Failure[] = [];
  let expiresIn = 3600;
  let activities = 0;
  // The activities posted, as the conversation shows them.
  const posted: string[] = [];

  const token = async (request: Request, url: URL): Promise<Response> => {
    const form = new URLSearchParams(
      new TextDecoder().decode(await request.arrayBuffer())
    );
    tokenRequests.push(form);
    const valid =
      request.method === "POST" &&
      url.pathname === `/${teamsBot.tenant}/oauth2/v2.0/token` &&
      form.get("grant_type") === "client_credentials" &&
      form.get("client_id") === teamsBot.id &&
      secrets.has(form.get("client_secret") ?? "") &&
      form.get("scope") === botFrameworkScope;
    if (!valid) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const value = `bot-token-${crypto.randomUUID()}`;
    issued.add(value);
    return Response.json({
      token_type: "Bearer",
      expires_in: expiresIn,
      ext_expires_in: expiresIn,
      access_token: value,
    });
  };

  const carryOut = async (request: Request, url: URL): Promise<Response> => {
    const bearer = request.headers.get("authorization") ?? "";
    if (!issued.has(bearer.replace(/^Bearer /u, ""))) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const found = activityPath.exec(url.pathname)?.groups;
    if (found?.conversation === undefined) {
      return Response.json({ error: { code: "NotFound" } }, { status: 404 });
    }
    if (removed.has(decodeURIComponent(found.conversation))) {
      return Response.json(
        { error: { code: "BotNotInConversationRoster" } },
        { status: 403 }
      );
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      return Response.json({ id: found.activity });
    }
    activities += 1;
    posted.push(await request.text());
    return Response.json({ id: `activity-${activities}` }, { status: 201 });
  };

  const botConnector = async (
    request: Request,
    url: URL
  ): Promise<Response> => {
    const failure = failures.shift();
    if (failure?.carriedOut === true) {
      await carryOut(request, url);
    }
    if (failure !== undefined) {
      return Response.json(
        { error: { code: "Failure" } },
        { status: failure.status, headers: failure.headers }
      );
    }
    return await carryOut(request, url);
  };

  beforeEach(() => {
    sent.length = 0;
    posted.length = 0;
    tokenRequests.length = 0;
    removed.clear();
    failures = [];
    expiresIn = 3600;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === loginHost && url.pathname.endsWith("/token")) {
        return await token(request, url);
      }
      sent.push({
        method: request.method,
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      });
      if (url.hostname === loginHost) {
        return Response.json({ issuer: `https://${loginHost}/` });
      }
      if (url.hostname === botConnectorHost) {
        return await botConnector(request, url);
      }
      return new Response("Taken");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    /** Every request but the token's, Microsoft's or not. */
    sent,
    /** The activities the Bot Connector posted, as their bodies. */
    posted,
    /** The token requests Entra got, as their forms. */
    tokenRequests,
    /** The tokens Entra issued. */
    issued,
    /** A bot of its own, with a secret Entra knows: connect's env vars. */
    bot: (): Partial<Env> => {
      const secret = `acme-teams-bot-secret-${crypto.randomUUID()}`;
      secrets.add(secret);
      return {
        TEAMS_BOT_ID: teamsBot.id,
        TEAMS_BOT_TENANT_ID: teamsBot.tenant,
        TEAMS_BOT_SECRET: secret,
      };
    },
    /** The Bot Connector answers the next requests with these instead. */
    fail: (...next: Failure[]) => {
      failures = next;
    },
    /** The bot was removed from this conversation: sends to it get a 403. */
    remove: (conversation: string) => {
      removed.add(conversation);
    },
    /** Tokens issued from now on last this long. */
    expireIn: (seconds: number) => {
      expiresIn = seconds;
    },
    /** Every token issued so far stops working, as when Entra revokes it. */
    revoke: () => {
      issued.clear();
    },
  };
};
