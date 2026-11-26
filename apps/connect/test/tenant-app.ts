import type {
  CompanyToolClass,
  ConnectionPerson,
} from "@grasp-os/shared/connect";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { clientOrigin, stateOf } from "./connect.ts";
import {
  sampleTenantApiHost,
  sampleTenantLoginHost,
} from "./fixtures/sample-tenant-connector.ts";
import { json } from "./internet.ts";
import { acmeTenant, appClients } from "./provider-config.ts";

// The sample tenant app (test/fixtures/sample-tenant-connector.ts) at
// its own authorization server and API: its tenant pinned, its account in
// the ID token. What declared-sign-in.test.ts and the connectors' tests
// connect it through.

const login = `https://${sampleTenantLoginHost}`;
const client = appClients["sample-tenant"];
export const issuerOf = (tenant: string): string => `${login}/${tenant}/v2.0`;

/** An account at the app, in a tenant, and what its ID token says besides. */
export interface TenantAccount {
  id: string;
  email: string;
  tenant: string;
  /** Claims its ID token has instead; `undefined` leaves one out. */
  claims?: Record<string, unknown>;
}

export const items = [{ id: "item-1", title: "First" }];

export const unsignedJwt = (claims: unknown): string =>
  [
    toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256" }))),
    toBase64Url(new TextEncoder().encode(JSON.stringify(claims))),
    "signature",
  ].join(".");

const s256 = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

const oauthError = (error: string, status = 400): Response =>
  Response.json({ error }, { status });

/** The token endpoint's path, under a tenant. */
const tokenPath = /^\/(?<tenant>[^/]+)\/oauth2\/token$/u;

interface Code {
  challenge: string;
  redirectUri: string;
  tenant: string;
  scope: string;
  account: TenantAccount;
}

/**
 * The app: its authorization server, where a code redeems only at its
 * tenant's token endpoint, with Grasp's client in the form, the verifier
 * of its challenge and its redirect URI; whose answers carry an ID token
 * and the scopes granted; and where revoking any token of an account
 * revokes them all (its grant is the account's). And its API, which
 * answers only a token the server holds. Registered after the internet,
 * so it sees every request first and hands on the rest.
 */
export const fakeTenantApp = () => {
  const requests: { url: string; form: URLSearchParams }[] = [];
  /** The authorization each call to the API carried. */
  const calls: (string | null)[] = [];
  const codes = new Map<string, Code>();
  const holders = new Map<string, TenantAccount>();
  const refreshScopes = new Map<string, string | null>();
  const options: {
    /** The scope a consent's answer lists: as asked, unless set; null, none. */
    granted: string | null | undefined;
    /** The scope a renewal's answer lists: as before, unless set. */
    renewed: string | null | undefined;
  } = { granted: undefined, renewed: undefined };

  const issue = (prefix: string, account: TenantAccount): string => {
    const token = `${prefix}-${crypto.randomUUID()}`;
    holders.set(token, account);
    return token;
  };

  const tokens = (account: TenantAccount, scope: string | null): Response => {
    const refreshToken = issue("tenant-refresh", account);
    refreshScopes.set(refreshToken, scope);
    return Response.json({
      token_type: "Bearer",
      access_token: issue("tenant-access", account),
      refresh_token: refreshToken,
      expires_in: 3600,
      ...(scope === null ? {} : { scope }),
      id_token: unsignedJwt({
        iss: issuerOf(account.tenant),
        aud: client.id,
        tid: account.tenant,
        oid: account.id,
        preferred_username: account.email,
        email: account.email,
        ...account.claims,
      }),
    });
  };

  const tokenEndpoint = async (
    tenant: string,
    form: URLSearchParams
  ): Promise<Response> => {
    if (
      form.get("client_id") !== client.id ||
      form.get("client_secret") !== client.secret
    ) {
      return oauthError("invalid_client", 401);
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const issued = codes.get(code);
      codes.delete(code);
      if (
        issued === undefined ||
        issued.tenant !== tenant ||
        (await s256(form.get("code_verifier") ?? "")) !== issued.challenge ||
        form.get("redirect_uri") !== issued.redirectUri
      ) {
        return oauthError("invalid_grant");
      }
      return tokens(
        issued.account,
        options.granted === undefined ? issued.scope : options.granted
      );
    }
    const token = form.get("refresh_token") ?? "";
    const account = holders.get(token);
    const before = refreshScopes.get(token);
    if (account === undefined || before === undefined) {
      return oauthError("invalid_grant");
    }
    holders.delete(token);
    refreshScopes.delete(token);
    return tokens(
      account,
      options.renewed === undefined ? before : options.renewed
    );
  };

  const revoke = (token: string): Response => {
    const account = holders.get(token);
    for (const [each, holder] of holders) {
      if (holder.id === account?.id) {
        holders.delete(each);
      }
    }
    return new Response(null, { status: 200 });
  };

  beforeEach(() => {
    requests.length = 0;
    calls.length = 0;
    codes.clear();
    holders.clear();
    refreshScopes.clear();
    options.granted = undefined;
    options.renewed = undefined;
    const passThrough =
      vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      // Read from the URL alone: a request made of `input` would take its
      // body from the one handed on.
      const url = new URL(input instanceof Request ? input.url : input);
      if (
        url.hostname !== sampleTenantApiHost &&
        url.hostname !== sampleTenantLoginHost
      ) {
        return await passThrough(input, init);
      }
      const request = new Request(input, init);
      if (url.hostname === sampleTenantApiHost) {
        const authorization = request.headers.get("authorization");
        calls.push(authorization);
        const token = authorization?.replace(/^Bearer /u, "") ?? "";
        return holders.has(token)
          ? json({ items, next: null })
          : json({ message: "Unauthorized" }, 401);
      }
      const form = new URLSearchParams(await request.text());
      requests.push({ url: url.href, form });
      if (url.pathname === "/oauth2/revoke") {
        return revoke(form.get("token") ?? "");
      }
      const tenant = tokenPath.exec(url.pathname)?.groups?.tenant;
      return tenant === undefined
        ? new Response("Not found", { status: 404 })
        : await tokenEndpoint(tenant, form);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    requests,
    calls,
    options,
    /** The code the app sends back once `account` consents at `url`. */
    authorize: (url: URL, account: TenantAccount): string => {
      const code = `tenant-code-${crypto.randomUUID()}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        tenant: url.pathname.split("/")[1] ?? "",
        scope: url.searchParams.get("scope") ?? "",
        account,
      });
      return code;
    },
    /** The tokens issued to `account` that still work. */
    tokensOf: (account: TenantAccount): string[] =>
      [...holders]
        .filter(([, holder]) => holder.id === account.id)
        .map(([token]) => token),
  };
};

/** The person's own account at the app, in the organization's tenant. */
export const tenantAccountOf = (
  person: ConnectionPerson,
  fields: Partial<TenantAccount> = {}
): TenantAccount => ({
  id: `oid-${crypto.randomUUID()}`,
  email: person.email,
  tenant: acmeTenant,
  ...fields,
});

export interface TenantStartOptions {
  tenant?: string;
  classes?: CompanyToolClass[];
  sharedMailbox?: boolean;
}

/** Starts connecting the app, as core does for a pinned provider. */
export const startTenantApp = async (
  person: ConnectionPerson,
  { tenant = acmeTenant, ...rest }: TenantStartOptions = {}
): Promise<URL> => {
  const { url } = await exports.default.startConnection({
    person,
    provider: "sample-tenant",
    scope: "personal",
    origin: clientOrigin,
    returnTo: "/connectors",
    tenant,
    ...rest,
  });
  return new URL(url);
};

/** Connects `account` end to end: start, consent, come back with the code. */
export const connectTenantApp = async (
  app: ReturnType<typeof fakeTenantApp>,
  person: ConnectionPerson,
  account: TenantAccount,
  options: TenantStartOptions = {}
): Promise<string> => {
  const url = await startTenantApp(person, options);
  const { connectionId } = await exports.default.finishConnection({
    person,
    state: stateOf(url),
    code: app.authorize(url, account),
  });
  return connectionId;
};
