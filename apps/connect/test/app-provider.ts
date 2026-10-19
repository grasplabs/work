/**
 * Stand-ins for the apps that sign in with their own provider records
 * (test/fixtures/sample-oauth-connector.ts, sample-key-connector.ts): the
 * OAuth app's authorization server (token and revocation endpoints) and
 * both apps' account lookups. The token endpoint checks what a real one
 * does: the client, in HTTP Basic as the record says; PKCE, so a code only
 * redeems with the verifier whose challenge the authorization carried; and
 * the redirect URI the authorization named. Tests read back every request,
 * headers and bodies too, to look for a token or key where it shouldn't
 * be; and choose how the lookup answers.
 *
 * Registered after `fakeProviders` and before `fakeInternet`, which hands
 * these hosts' requests on here (`appProviderUrls`): requests to the apps'
 * other routes (their connectors' calls) go on to the internet.
 */
import type {
  ConnectionPerson,
  ConnectionScope,
} from "@grasp-os/shared/connect";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { clientOrigin, stateOf } from "./connect.ts";
import {
  sampleKeyApiHost,
  sampleKeyHeader,
} from "./fixtures/sample-key-connector.ts";
import {
  sampleOAuthApiHost,
  sampleOAuthAuthHost,
} from "./fixtures/sample-oauth-connector.ts";
import { appClients } from "./provider-config.ts";

export type AppName = "sample-oauth" | "sample-key";

/** An account at one of the apps. */
export interface AppAccount {
  provider: AppName;
  id: string;
  name: string;
  /** As the app says it; absent when its lookup names none. */
  email?: string;
}

/** One request connect sent to an app's sign-in or lookup. */
export interface AppRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** How a lookup fares instead of answering, when a test says so. */
export type Answer = () => Response | Promise<Response>;

const tokenUrl = `https://${sampleOAuthAuthHost}/oauth/token`;
const revokeUrl = `https://${sampleOAuthAuthHost}/oauth/revoke`;
const oauthLookupUrl = `https://${sampleOAuthApiHost}/v1/me`;
const keyLookupUrl = `https://${sampleKeyApiHost}/v1/whoami`;

/** The URLs these fakes answer; every other one goes on. */
export const appProviderUrls: ReadonlySet<string> = new Set([
  tokenUrl,
  revokeUrl,
  oauthLookupUrl,
  keyLookupUrl,
]);

const s256 = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

/** A request's body, as text: a form, mostly. */
const bodyOf = async (request: Request): Promise<string> =>
  new TextDecoder().decode(await request.arrayBuffer());

const oauthError = (error: string, status = 400): Response =>
  Response.json({ error, error_description: "Refused" }, { status });

const client = appClients["sample-oauth"];
const basic = `Basic ${btoa(`${client.id}:${client.secret}`)}`;

interface Code {
  challenge: string;
  redirectUri: string;
  account: AppAccount;
}

/** The apps, for each test in the file. */
export const fakeApps = () => {
  const requests: AppRequest[] = [];
  /** Every token and key issued, to look for. */
  const issued: string[] = [];
  const codes = new Map<string, Code>();
  /** Access and refresh tokens, and keys → the account they're for. */
  const holders = new Map<string, AppAccount>();
  const refreshTokens = new Map<string, AppAccount>();
  const options: {
    lookup: Answer | undefined;
    /** An ID token the token endpoint adds: no app's is trusted. */
    idToken: string | undefined;
  } = { lookup: undefined, idToken: undefined };

  const issue = (prefix: string, account: AppAccount): string => {
    const token = `${prefix}-${crypto.randomUUID()}`;
    issued.push(token);
    holders.set(token, account);
    return token;
  };

  const tokens = (account: AppAccount): Response => {
    const refreshToken = issue("app-refresh", account);
    refreshTokens.set(refreshToken, account);
    return Response.json({
      token_type: "bearer",
      access_token: issue("app-access", account),
      refresh_token: refreshToken,
      expires_in: 3600,
      ...(options.idToken === undefined ? {} : { id_token: options.idToken }),
    });
  };

  const tokenEndpoint = async (
    request: Request,
    form: URLSearchParams
  ): Promise<Response> => {
    // The record says HTTP Basic: a secret in the form is refused.
    if (
      request.headers.get("authorization") !== basic ||
      form.has("client_secret")
    ) {
      return oauthError("invalid_client", 401);
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const issuedFor = codes.get(code);
      codes.delete(code);
      if (
        issuedFor === undefined ||
        (await s256(form.get("code_verifier") ?? "")) !== issuedFor.challenge ||
        form.get("redirect_uri") !== issuedFor.redirectUri
      ) {
        return oauthError("invalid_grant");
      }
      return tokens(issuedFor.account);
    }
    if (form.get("grant_type") === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const account = refreshTokens.get(token);
      refreshTokens.delete(token);
      return account === undefined
        ? oauthError("invalid_grant")
        : tokens(account);
    }
    return oauthError("unsupported_grant_type");
  };

  const lookup = async (
    request: Request,
    credential: string | null
  ): Promise<Response> => {
    if (options.lookup !== undefined) {
      const answered = await options.lookup();
      const location = answered.headers.get("location");
      // As fetch does, unless asked not to: it follows a redirect, its
      // headers (the token or key too) along.
      return answered.status >= 300 &&
        answered.status < 400 &&
        location !== null &&
        request.redirect !== "manual"
        ? await globalThis.fetch(location, { headers: request.headers })
        : answered;
    }
    const account = holders.get(credential ?? "");
    if (account === undefined) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const fields = {
      id: account.id,
      name: account.name,
      ...(account.email === undefined ? {} : { email: account.email }),
    };
    return new URL(request.url).hostname === sampleKeyApiHost
      ? Response.json({ account: fields })
      : Response.json({ data: fields });
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const href = url.origin + url.pathname;
    if (href === tokenUrl || href === revokeUrl) {
      const form = new URLSearchParams(await bodyOf(request));
      if (href === tokenUrl) {
        return await tokenEndpoint(request, form);
      }
      if (request.headers.get("authorization") !== basic) {
        return oauthError("invalid_client", 401);
      }
      refreshTokens.delete(form.get("token") ?? "");
      holders.delete(form.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (href === oauthLookupUrl) {
      const bearer = request.headers.get("authorization") ?? "";
      return await lookup(
        request,
        bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : null
      );
    }
    return await lookup(request, request.headers.get(sampleKeyHeader));
  };

  beforeEach(() => {
    requests.length = 0;
    issued.length = 0;
    codes.clear();
    holders.clear();
    refreshTokens.clear();
    options.lookup = undefined;
    options.idToken = undefined;
    // The fake suites' spy (registered first) takes the rest.
    const passThrough =
      vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!appProviderUrls.has(url.origin + url.pathname)) {
        return await passThrough(input, init);
      }
      requests.push({
        method: request.method,
        url: url.href,
        headers: Object.fromEntries(request.headers),
        body: await bodyOf(request.clone()),
      });
      return await answer(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    requests,
    issued,
    options,
    /** A new account at `provider`, with `email` unless it says none. */
    account: (
      provider: AppName,
      email: string | undefined = `account-${crypto.randomUUID()}@acme.test`
    ): AppAccount => {
      const id = `${provider}-account-${crypto.randomUUID()}`;
      return {
        provider,
        id,
        name: `Account ${id}`,
        ...(email === undefined ? {} : { email }),
      };
    },
    /** An API key the key app issued for `account`. */
    keyFor: (account: AppAccount): string => issue("app-key", account),
    /**
     * The code the OAuth app sends back after `account` consents at
     * `authorizationUrl`, bound to its PKCE challenge and redirect URI.
     */
    authorize: (authorizationUrl: string, account: AppAccount): string => {
      const url = new URL(authorizationUrl);
      const code = `app-code-${crypto.randomUUID()}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        account,
      });
      return code;
    },
    /** The token requests connect sent, by grant type. */
    tokenRequests: (grantType: string): AppRequest[] =>
      requests.filter(
        ({ url, body }) =>
          url === tokenUrl &&
          new URLSearchParams(body).get("grant_type") === grantType
      ),
    revocations: (): AppRequest[] =>
      requests.filter(({ url }) => url === revokeUrl),
    /** Whether a token or key still works at the app. */
    holds: (token: string): boolean => holders.has(token),
  };
};

/** Starts connecting the OAuth app, as core would for `person`. */
export const startApp = async (
  person: ConnectionPerson,
  scope: ConnectionScope = "personal"
): Promise<URL> => {
  const { url } = await exports.default.startConnection({
    person,
    provider: "sample-oauth",
    scope,
    origin: clientOrigin,
    returnTo: "/connections",
  });
  return new URL(url);
};

/**
 * Connects `account` end to end, as `person`'s browser and core would: for
 * the OAuth app, start, consent as the account, come back with the code;
 * for the key app, give a key the app issued for the account.
 */
export const connectApp = async (
  apps: ReturnType<typeof fakeApps>,
  person: ConnectionPerson,
  account: AppAccount,
  scope: ConnectionScope = "personal"
): Promise<string> => {
  if (account.provider === "sample-key") {
    const { connectionId } = await exports.default.connectWithKey({
      person,
      provider: account.provider,
      scope,
      key: apps.keyFor(account),
    });
    return connectionId;
  }
  const url = await startApp(person, scope);
  const { connectionId } = await exports.default.finishConnection({
    person,
    state: stateOf(url),
    code: apps.authorize(url.href, account),
  });
  return connectionId;
};
