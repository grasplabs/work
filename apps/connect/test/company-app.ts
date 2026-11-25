import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { clientOrigin, stateOf } from "./connect.ts";
import {
  sampleCompanyHostField,
  sampleCompanyLoginHost,
} from "./fixtures/sample-company-connector.ts";
import { json } from "./internet.ts";
import { appClients } from "./provider-config.ts";

// The sample company app (test/fixtures/sample-company-connector.ts) at
// its authorization server and at each company's host under its name:
// what egress-credentials.test.ts and the connectors' tests connect it
// through.

const client = appClients["sample-company"];
const vendorSuffix = ".sample-company.test";

/** An account at the app, and what its token response names as its host. */
export interface CompanyAccount {
  id: string;
  name: string;
  email: string;
  /** The token response's `api_domain`; `undefined` leaves it out. */
  apiDomain: string | undefined;
}

/** One request that reached the app, at its login or a company's host. */
export interface CompanyRequest {
  method: string;
  host: string;
  path: string;
  authorization: string | null;
  body: string;
}

interface Holder {
  account: CompanyAccount;
  host: string | undefined;
}

interface Code {
  challenge: string;
  redirectUri: string;
  account: CompanyAccount;
}

export const companyItems = [{ id: "item-1", title: "First" }];

const s256 = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

/** The host a token response's `api_domain` stands for at the app. */
const hostOf = (apiDomain: string | undefined): string | undefined =>
  apiDomain === undefined
    ? undefined
    : (URL.parse(apiDomain.includes("://") ? apiDomain : `https://${apiDomain}`)
        ?.hostname ?? undefined);

/**
 * The app: its token endpoint, which redeems a code only with Grasp's
 * client in the form, the verifier of its challenge and its redirect URI,
 * or a refresh token once, and answers with the account's `api_domain`
 * (`options.refreshedApiDomain` instead on a refresh, when set); and each
 * company's host, which answers only a token issued for that host. Registered after the
 * internet, so it sees every request first and hands on the rest.
 */
export const fakeCompanyApp = () => {
  const requests: CompanyRequest[] = [];
  /** Every access and refresh token issued, to look for. */
  const issued: string[] = [];
  const codes = new Map<string, Code>();
  /** Access and refresh tokens → the account and host they're for. */
  const holders = new Map<string, Holder>();
  const refreshTokens = new Map<string, Holder>();
  const options: {
    /** The `api_domain` a refresh's answer names, if not the account's. */
    refreshedApiDomain: string | undefined;
  } = { refreshedApiDomain: undefined };

  const tokens = (holder: Holder, apiDomain: string | undefined): Response => {
    const accessToken = `company-access-${crypto.randomUUID()}`;
    const refreshToken = `company-refresh-${crypto.randomUUID()}`;
    issued.push(accessToken, refreshToken);
    holders.set(accessToken, holder);
    refreshTokens.set(refreshToken, holder);
    return Response.json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      ...(apiDomain === undefined
        ? {}
        : { [sampleCompanyHostField]: apiDomain }),
    });
  };

  const tokenEndpoint = async (form: URLSearchParams): Promise<Response> => {
    if (
      form.get("client_id") !== client.id ||
      form.get("client_secret") !== client.secret
    ) {
      return json({ error: "invalid_client" }, 401);
    }
    if (form.get("grant_type") === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const holder = refreshTokens.get(token);
      refreshTokens.delete(token);
      return holder === undefined
        ? json({ error: "invalid_grant" }, 400)
        : tokens(
            holder,
            options.refreshedApiDomain ?? holder.account.apiDomain
          );
    }
    const code = form.get("code") ?? "";
    const issuedFor = codes.get(code);
    codes.delete(code);
    if (
      form.get("grant_type") !== "authorization_code" ||
      issuedFor === undefined ||
      (await s256(form.get("code_verifier") ?? "")) !== issuedFor.challenge ||
      form.get("redirect_uri") !== issuedFor.redirectUri
    ) {
      return json({ error: "invalid_grant" }, 400);
    }
    const { account } = issuedFor;
    return tokens(
      { account, host: hostOf(account.apiDomain) },
      account.apiDomain
    );
  };

  const api = (url: URL, authorization: string | null): Response => {
    const holder = holders.get(authorization?.replace(/^Bearer /u, "") ?? "");
    if (holder?.host !== url.hostname) {
      return json({ message: "Unauthorized" }, 401);
    }
    const { id, name, email } = holder.account;
    return url.pathname === "/v1/me"
      ? json({ id, name, email })
      : json({ items: companyItems });
  };

  beforeEach(() => {
    requests.length = 0;
    issued.length = 0;
    codes.clear();
    holders.clear();
    refreshTokens.clear();
    options.refreshedApiDomain = undefined;
    const passThrough =
      vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!url.hostname.endsWith(vendorSuffix)) {
        return await passThrough(input, init);
      }
      const body = new TextDecoder().decode(await request.arrayBuffer());
      const authorization = request.headers.get("authorization");
      requests.push({
        method: request.method,
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        authorization,
        body,
      });
      if (url.hostname !== sampleCompanyLoginHost) {
        return api(url, authorization);
      }
      return url.pathname === "/oauth/token"
        ? await tokenEndpoint(new URLSearchParams(body))
        : new Response("Not found", { status: 404 });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    requests,
    issued,
    options,
    /** The code the app sends back once `account` consents at `url`. */
    authorize: (url: URL, account: CompanyAccount): string => {
      const code = `company-code-${crypto.randomUUID()}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        account,
      });
      return code;
    },
  };
};

/** The person's own account at the app, its token response naming `apiDomain`. */
export const companyAccountOf = (
  person: ConnectionPerson,
  apiDomain: string | undefined,
  id = `company-account-${crypto.randomUUID()}`
): CompanyAccount => ({
  id,
  name: `Account ${id}`,
  email: person.email,
  apiDomain,
});

/** Starts connecting the app, as core does. */
export const startCompanyApp = async (
  person: ConnectionPerson
): Promise<URL> => {
  const { url } = await exports.default.startConnection({
    person,
    provider: "sample-company",
    scope: "personal",
    origin: clientOrigin,
    returnTo: "/connectors",
  });
  return new URL(url);
};

/** Connects `account` end to end: start, consent, come back with the code. */
export const connectCompanyApp = async (
  app: ReturnType<typeof fakeCompanyApp>,
  person: ConnectionPerson,
  account: CompanyAccount
): Promise<string> => {
  const url = await startCompanyApp(person);
  const { connectionId } = await exports.default.finishConnection({
    person,
    state: stateOf(url),
    code: app.authorize(url, account),
  });
  return connectionId;
};
