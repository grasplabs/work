import { auth, signInSchema } from "@grasp-os/runtime/connector";
import type { OAuth2Declaration } from "@grasp-os/runtime/connector";
import type {
  CompanyToolClass,
  ConnectionPerson,
} from "@grasp-os/shared/connect";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { connections, connectionTokens } from "../src/db/schema.ts";
import { exchangeCode } from "../src/oauth-client.ts";
import type { TokenSet } from "../src/oauth-client.ts";
import { startConnection } from "../src/oauth.ts";
import { holdsClassRights } from "../src/provider-rights.ts";
import {
  appProvider,
  grantedAsAsked,
  providerFor,
  providers,
} from "../src/providers.ts";
import type { OAuthProviderConfig } from "../src/providers.ts";
import {
  auditEvents,
  clientOrigin,
  outcome,
  runMaintenance,
  someone,
  stateOf,
} from "./connect.ts";
import sampleTenant, {
  sampleTenantApiHost,
  sampleTenantLoginHost,
  sampleTenantScopePrefix,
} from "./fixtures/sample-tenant-connector.ts";
import { fakeInternet, json } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  acmeDomain,
  acmeTenant,
  appClients,
  clients,
  otherTenant,
} from "./provider-config.ts";
import { callTool } from "./tool-calls.ts";

// A connector's own sign-in saying all a suite's config says, run by
// connect as it runs the suites': test/fixtures/sample-tenant-connector.ts,
// written on @grasp-os/sdk/connector, pinned to the organization's tenant,
// its account from the ID token, asked by tool class. AP1 to AP9
// (test/app-sign-in.test.ts) hold for it as for any record; the threat
// model of what it adds comes first, each case a way it could fail, or be
// made to by a connector gone wrong (runtime's sign-in.test.ts checks the
// declarations; these, connect's side):
//
// AP10 The tenant leaving its place: a template putting it in a host, or
//      a tenant that carries a path, a query, a host or a dot segment
//      into an endpoint; a tenant of a kind the record didn't declare.
// AP11 An account from the wrong ID token: another issuer, another
//      tenant's, another client's (or several clients'), a B2B guest
//      signed in by another tenant; and a refused account's grant left
//      live.
// AP12 A pinned sign-in whose check never names the tenant (no claim, and
//      an issuer of any tenant among its issuers), or that takes an
//      account from a lookup: any tenant's account would do.
// AP13 Claims read more loosely than the suites' own configs read them:
//      a claim that's missing, of another type, in another case, or
//      `"true"` for `true`.
// AP14 More access than its scopes, or than the classes on ask for: a
//      class, an implied right, a shared mailbox or a renewal asking a
//      scope it doesn't declare; a consent asking a class that is off; a
//      scope no consent ever asks; a renewal requiring a class's scope,
//      which no consent asks once the class is off.
// AP15 A scope prefix stripping one scope into another's name: a prefix
//      no URL, one its own scopes start with, or stripped anywhere but
//      at the start.
// AP16 A provider ID taking another's place: a suite's config or client
//      (MICROSOFT_CLIENT_*), the directory's, the documents', an HR
//      platform's, Composio's or a URL connector's; two connectors for
//      one provider.
// AP17 Revoking one token where the grant is the account's: an owed
//      revoke ending the grant the same account consented to again.
// AP18 A grant connect can't read counted as held: a consent whose answer
//      lists no grant kept as holding nothing, forever; a renewal that
//      dropped what it must hold.

const login = `https://${sampleTenantLoginHost}`;
const client = appClients["sample-tenant"];
const issuerOf = (tenant: string): string => `${login}/${tenant}/v2.0`;

/** An account at the app, in a tenant, and what its ID token says besides. */
interface Account {
  id: string;
  email: string;
  tenant: string;
  /** Claims its ID token has instead; `undefined` leaves one out. */
  claims?: Record<string, unknown>;
}

const items = [{ id: "item-1", title: "First" }];

const unsignedJwt = (claims: unknown): string =>
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
  account: Account;
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
const fakeTenantApp = () => {
  const requests: { url: string; form: URLSearchParams }[] = [];
  /** The authorization each call to the API carried. */
  const calls: (string | null)[] = [];
  const codes = new Map<string, Code>();
  const holders = new Map<string, Account>();
  const refreshScopes = new Map<string, string | null>();
  const options: {
    /** The scope a consent's answer lists: as asked, unless set; null, none. */
    granted: string | null | undefined;
    /** The scope a renewal's answer lists: as before, unless set. */
    renewed: string | null | undefined;
  } = { granted: undefined, renewed: undefined };

  const issue = (prefix: string, account: Account): string => {
    const token = `${prefix}-${crypto.randomUUID()}`;
    holders.set(token, account);
    return token;
  };

  const tokens = (account: Account, scope: string | null): Response => {
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
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === sampleTenantApiHost) {
        const authorization = request.headers.get("authorization");
        calls.push(authorization);
        const token = authorization?.replace(/^Bearer /u, "") ?? "";
        return holders.has(token)
          ? json({ items, next: null })
          : json({ message: "Unauthorized" }, 401);
      }
      if (url.hostname !== sampleTenantLoginHost) {
        return await passThrough(input, init);
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
    authorize: (url: URL, account: Account): string => {
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
    tokensOf: (account: Account): string[] =>
      [...holders]
        .filter(([, holder]) => holder.id === account.id)
        .map(([token]) => token),
  };
};

// The suites' fakes, then the internet, which nothing here should reach.
fakeProviders();
const internet = fakeInternet(() => new Response("Not found", { status: 404 }));
const app = fakeTenantApp();
const audit = auditEvents();
const revokeUrl = `${login}/oauth2/revoke`;

/** The person's own account at the app, in the organization's tenant. */
const accountOf = (
  person: ConnectionPerson,
  fields: Partial<Account> = {}
): Account => ({
  id: `oid-${crypto.randomUUID()}`,
  email: person.email,
  tenant: acmeTenant,
  ...fields,
});

interface StartOptions {
  tenant?: string;
  classes?: CompanyToolClass[];
  sharedMailbox?: boolean;
}

/** Starts connecting the app, as core does for a pinned provider. */
const start = async (
  person: ConnectionPerson,
  { tenant = acmeTenant, ...rest }: StartOptions = {}
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
const connect = async (
  person: ConnectionPerson,
  account: Account,
  options: StartOptions = {}
): Promise<string> => {
  const url = await start(person, options);
  const { connectionId } = await exports.default.finishConnection({
    person,
    state: stateOf(url),
    code: app.authorize(url, account),
  });
  return connectionId;
};

const listItems = async (id: string, person: ConnectionPerson) =>
  await callTool(
    { id, person },
    "v1.boards.items.list",
    { board: "board-1" },
    { resource: "board-1" }
  );

const grantOf = async (id: string) => {
  const row = await drizzle(env.DB)
    .select({ granted: connectionTokens.grantedScopes })
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, id))
    .get();
  return row?.granted;
};

const statusOf = async (id: string) => {
  const row = await drizzle(env.DB)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, id))
    .get();
  return row?.status;
};

/** Runs the connection's access token out: its next call renews it. */
const expire = async (id: string): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ accessExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(connectionTokens.connectionId, id));
};

const scopesAsked = (url: URL): string[] =>
  (url.searchParams.get("scope") ?? "").split(" ").toSorted();

const signIn = ["openid", "profile", "email", "offline_access", "Account.Read"];

/** The provider connect makes of `declaration`, under the name `provider`. */
const declared = (
  provider: string,
  declaration: OAuth2Declaration
): OAuthProviderConfig => {
  const config = appProvider({
    provider,
    server: provider,
    signIn: signInSchema.parse({
      ...auth.oauth2(declaration).signIn,
      name: provider,
    }),
  });
  if (config.kind !== "oauth") {
    throw new Error("An OAuth provider");
  }
  return config;
};

describe("a connector's declared sign-in", () => {
  it("connects pinned to the organization's tenant, its account from the ID token, with its provider's own client", async () => {
    const person = someone();
    const account = accountOf(person);
    // Core's tenant, in any case, is the organization's.
    const url = await start(person, { tenant: acmeTenant.toUpperCase() });
    const {
      state: _state,
      code_challenge: _challenge,
      scope: _scope,
      ...params
    } = Object.fromEntries(url.searchParams);
    expect({
      endpoint: url.origin + url.pathname,
      ...params,
      scope: scopesAsked(url),
    }).toStrictEqual({
      endpoint: `${login}/${acmeTenant}/oauth2/authorize`,
      domain_hint: acmeTenant,
      response_type: "code",
      client_id: client.id,
      redirect_uri: `${clientOrigin}/api/connections/callback`,
      code_challenge_method: "S256",
      // The classes on by default: reading and changing their own, the
      // write taking in the read.
      scope: [...signIn, "Items.ReadWrite"].toSorted(),
    });
    const { connectionId } = await exports.default.finishConnection({
      person,
      state: stateOf(url),
      code: app.authorize(url, account),
    });
    await expect(
      drizzle(env.DB)
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
        .get()
    ).resolves.toMatchObject({
      provider: "sample-tenant",
      server: "sample-tenant",
      status: "active",
      tenant: acmeTenant,
      accountId: account.id,
      accountName: account.email,
      accountEmail: account.email,
    });
    expect(app.requests.map(({ url: sent }) => sent)).toStrictEqual([
      `${login}/${acmeTenant}/oauth2/token`,
    ]);
  });

  it("asks only for the rights of the classes on, and a shared mailbox's while one is pointed at", async () => {
    const person = someone();
    expect({
      readOwn: scopesAsked(await start(person, { classes: ["read-own"] })),
      none: scopesAsked(await start(person, { classes: [] })),
      reaching: scopesAsked(
        await start(person, {
          classes: ["read-own", "change-own", "reach-others"],
          sharedMailbox: true,
        })
      ),
      mailboxOnly: scopesAsked(
        await start(person, { classes: ["read-own"], sharedMailbox: true })
      ),
    }).toStrictEqual({
      readOwn: [...signIn, "Items.Read"].toSorted(),
      none: signIn.toSorted(),
      reaching: [
        ...signIn,
        "Items.ReadWrite",
        "Items.Send",
        "Items.Read.Shared",
        "Items.Send.Shared",
      ].toSorted(),
      mailboxOnly: [...signIn, "Items.Read", "Items.Read.Shared"].toSorted(),
    });
  });

  it("calls with its token, and renews it at the tenant's token endpoint", async () => {
    const person = someone();
    const id = await connect(person, accountOf(person));
    await listItems(id, person);
    await expire(id);
    const renewed = await listItems(id, person);
    expect(JSON.parse(renewed.output)).toStrictEqual({ items, next: null });
    expect(
      app.requests.map(({ url, form }) => `${form.get("grant_type")} ${url}`)
    ).toStrictEqual([
      `authorization_code ${login}/${acmeTenant}/oauth2/token`,
      `refresh_token ${login}/${acmeTenant}/oauth2/token`,
    ]);
    const [first, second] = app.calls;
    expect(first).not.toBe(second);
    expect(internet.sent).toStrictEqual([]);
  });

  it("is revoked at its authorization server when disconnected", async () => {
    const person = someone();
    const account = accountOf(person);
    const connectionId = await connect(person, account);
    await expect(
      exports.default.disconnect({ person, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(app.tokensOf(account)).toStrictEqual([]);
    expect(app.requests.filter(({ url }) => url === revokeUrl)).toHaveLength(1);
  });
});

describe("threat model", () => {
  it("AP10: a tenant is only ever one path segment, or one parameter, of the organization's", async () => {
    const person = someone();
    const tenants = [
      `${acmeTenant}/../evil`,
      `${acmeTenant}?x=1`,
      `${acmeTenant}#x`,
      `evil.test/${acmeTenant}`,
      "evil.test",
      "..",
      acmeTenant.replaceAll("-", ""),
      `${acmeTenant}0`,
    ];
    await expect(
      Promise.all(
        tenants.map(async (tenant) => await outcome(start(person, { tenant })))
      )
    ).resolves.toStrictEqual(
      tenants.map(() => "connection.provider_unavailable")
    );
    expect(app.requests).toStrictEqual([]);
  });

  it("AP11: an account is taken only from an ID token its issuer made for Grasp's client, in the tenant, for no guest", async () => {
    const person = someone();
    const refused: Record<string, Partial<Account>> = {
      otherTenant: { tenant: otherTenant },
      otherTenantsIssuer: { claims: { iss: issuerOf(otherTenant) } },
      otherHost: {
        claims: { iss: `https://login.evil.test/${acmeTenant}/v2.0` },
      },
      noIssuer: { claims: { iss: undefined } },
      guest: { claims: { idp: "https://sts.other.test/guest/" } },
      otherClient: { claims: { aud: clients.microsoft.id } },
      clients: { claims: { aud: [client.id, clients.microsoft.id] } },
      noTenant: { claims: { tid: undefined } },
      noSubject: { claims: { oid: undefined } },
      emptySubject: { claims: { oid: "" } },
      numberSubject: { claims: { oid: 42 } },
      numberEmail: { claims: { email: 42 } },
      // Longer than any account field connect keeps.
      longSubject: { id: "o".repeat(257) },
      longEmail: { claims: { email: `${"a".repeat(250)}@acme.test` } },
    };
    const outcomes = Object.fromEntries(
      await Promise.all(
        Object.entries(refused).map(
          async ([name, fields]): Promise<[string, string]> => [
            name,
            await outcome(connect(person, accountOf(person, fields))),
          ]
        )
      )
    );
    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        Object.keys(refused).map((name) => [name, "connection.wrong_account"])
      )
    );
    // The grant minted for each is revoked, not left behind.
    expect(app.requests.filter(({ url }) => url === revokeUrl)).toHaveLength(
      Object.keys(refused).length
    );
    // Signed in by its own tenant's issuer, a member is no guest.
    await expect(
      outcome(
        connect(
          person,
          accountOf(person, { claims: { idp: issuerOf(acmeTenant) } })
        )
      )
    ).resolves.toBe("ok");
  });

  // AP12 is the declarations' alone: runtime's sign-in.test.ts.

  it("AP13: reads an ID token exactly as the suites' own configs do", async () => {
    const owner = "person:someone";
    // Microsoft 365's, as its connector will declare it. Entra's default
    // response mode for the code flow is `query`, so it needs no
    // `response_mode`, which a record may not set.
    const microsoft = declared("microsoft", {
      authorizeUrl:
        "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: { openid: "", profile: "", email: "", offline_access: "" },
      tenant: "guid",
      idToken: {
        issuer: "https://login.microsoftonline.com/{tenant}/v2.0",
        subject: "oid",
        name: ["preferred_username"],
        email: ["email", "preferred_username"],
        claims: { tid: "{tenant}" },
        sameIssuer: ["idp"],
      },
    });
    // Google Workspace's, as its connector declares it: the suite's own
    // config it replaced took the same four of these cases, and no other.
    const google = providerFor("google");
    const entraSuite = providers.microsoft;
    if (google?.kind !== "oauth" || entraSuite === undefined) {
      throw new Error("Google Workspace's sign-in and Microsoft 365's config");
    }
    const entra = `https://login.microsoftonline.com/${acmeTenant}/v2.0`;
    const microsoftBase = {
      iss: entra,
      aud: clients.microsoft.id,
      tid: acmeTenant,
      oid: "oid-1",
      preferred_username: "ada@acme.test",
      email: "ada.lovelace@acme.test",
    };
    const microsoftCases: Record<string, unknown> = {
      member: microsoftBase,
      noEmail: { ...microsoftBase, email: undefined },
      noName: { ...microsoftBase, preferred_username: undefined },
      neither: {
        ...microsoftBase,
        email: undefined,
        preferred_username: undefined,
      },
      emptyEmail: { ...microsoftBase, email: "" },
      nullEmail: { ...microsoftBase, email: null },
      numberName: { ...microsoftBase, preferred_username: 7 },
      tenantInCase: { ...microsoftBase, tid: acmeTenant.toUpperCase() },
      otherTenant: { ...microsoftBase, tid: otherTenant },
      otherIssuer: {
        ...microsoftBase,
        iss: entra.replace(acmeTenant, otherTenant),
      },
      sameIssuer: { ...microsoftBase, idp: entra },
      guest: { ...microsoftBase, idp: "https://sts.windows.net/other/" },
      numberGuest: { ...microsoftBase, idp: 1 },
      otherClient: { ...microsoftBase, aud: "someone-else" },
      clients: { ...microsoftBase, aud: [clients.microsoft.id] },
      emptySubject: { ...microsoftBase, oid: "" },
      noSubject: { ...microsoftBase, oid: undefined },
      numberSubject: { ...microsoftBase, oid: 1 },
      googles: { ...microsoftBase, iss: "https://accounts.google.com" },
      notAnObject: [microsoftBase],
    };
    const googleBase = {
      iss: "https://accounts.google.com",
      aud: clients.google.id,
      sub: "g-1",
      hd: acmeDomain,
      email: "ada@acme.test",
      email_verified: true,
    };
    const googleCases: Record<string, unknown> = {
      member: googleBase,
      bareIssuer: { ...googleBase, iss: "accounts.google.com" },
      issuerInCase: { ...googleBase, iss: "https://Accounts.Google.com" },
      otherIssuer: { ...googleBase, iss: "https://accounts.evil.test" },
      domainInCase: { ...googleBase, hd: "ACME.test" },
      otherDomain: { ...googleBase, hd: "evil.test" },
      noDomain: { ...googleBase, hd: undefined },
      numberDomain: { ...googleBase, hd: 1 },
      unverified: { ...googleBase, email_verified: false },
      verifiedAsText: { ...googleBase, email_verified: "true" },
      notVerified: { ...googleBase, email_verified: undefined },
      noEmail: { ...googleBase, email: undefined },
      numberEmail: { ...googleBase, email: 1 },
      otherClient: { ...googleBase, aud: clients.microsoft.id },
      emptySubject: { ...googleBase, sub: "" },
    };
    /** The cases \`ours\` and \`theirs\` read differently. */
    const differing = async (
      ours: OAuthProviderConfig,
      theirs: OAuthProviderConfig,
      tenant: string,
      clientId: string,
      cases: Record<string, unknown>
    ) => {
      const results = await Promise.all(
        Object.entries(cases).map(async ([name, claims]) => {
          const tokens: TokenSet = {
            accessToken: "access",
            expiresAt: Date.now() + 3_600_000,
            idToken: unsignedJwt(claims),
          };
          return {
            name,
            declared: await ours.account(tokens, tenant, clientId, owner),
            suite: await theirs.account(tokens, tenant, clientId, owner),
            subjects: [ours.subject?.(tokens), theirs.subject?.(tokens)],
          };
        })
      );
      return results.filter(
        ({ declared: one, suite, subjects: [ourSubject, theirSubject] }) =>
          JSON.stringify(one) !== JSON.stringify(suite) ||
          ourSubject !== theirSubject
      );
    };
    await expect(
      differing(
        microsoft,
        entraSuite,
        acmeTenant,
        clients.microsoft.id,
        microsoftCases
      )
    ).resolves.toStrictEqual([]);
    const googleAccounts = await Promise.all(
      Object.entries(googleCases).map(async ([name, claims]) => {
        const tokens: TokenSet = {
          accessToken: "access",
          expiresAt: Date.now() + 3_600_000,
          idToken: unsignedJwt(claims),
        };
        const account = await google.account(
          tokens,
          acmeDomain,
          clients.google.id,
          owner
        );
        return account === null
          ? []
          : [{ name, account, subject: google.subject?.(tokens) }];
      })
    );
    expect(googleAccounts.flat()).toStrictEqual([
      {
        name: "member",
        account: { id: "g-1", name: "ada@acme.test", email: "ada@acme.test" },
        subject: "g-1",
      },
      {
        name: "bareIssuer",
        account: { id: "g-1", name: "ada@acme.test", email: "ada@acme.test" },
        subject: "g-1",
      },
      {
        name: "domainInCase",
        account: { id: "g-1", name: "ada@acme.test", email: "ada@acme.test" },
        subject: "g-1",
      },
      {
        name: "noEmail",
        account: { id: "g-1", name: null, email: null },
        subject: "g-1",
      },
    ]);
    // The one difference: an issuer is compared exactly, as OpenID
    // Connect has it (Core `3.1.3.7), where Entra's config read it without
    // case. Entra writes the tenant's GUID in lower case.
    const upper = await differing(
      microsoft,
      entraSuite,
      acmeTenant,
      clients.microsoft.id,
      { issuerInCase: { ...microsoftBase, iss: entra.toUpperCase() } }
    );
    expect(
      upper.map(({ declared: one, suite }) => [one, suite === null])
    ).toStrictEqual([[null, false]]);
  });

  it("AP14: a consent never asks for more than the declared scopes of the classes on", async () => {
    const person = someone();
    const declaredScopes = new Set([
      ...signIn,
      "Items.Read",
      "Items.ReadWrite",
      "Items.Send",
      "Items.Read.Shared",
      "Items.Send.Shared",
    ]);
    const everything = await start(person, {
      classes: [
        "read-own",
        "change-own",
        "read-company",
        "change-company",
        "reach-others",
        "read-others",
      ],
      sharedMailbox: true,
    });
    expect(
      scopesAsked(everything).filter((scope) => !declaredScopes.has(scope))
    ).toStrictEqual([]);
    // Sending from a shared mailbox is asked only with Reach others on.
    expect(
      scopesAsked(
        await start(person, { classes: ["change-own"], sharedMailbox: true })
      )
    ).not.toContain("Items.Send.Shared");
  });

  it("AP15: rights are read past the prefix at their start only, and only by their own names", async () => {
    const grants = {
      prefixed: `openid ${sampleTenantScopePrefix}Items.ReadWrite`,
      // The prefix anywhere but at the start is part of another name.
      inside: `openid Items.${sampleTenantScopePrefix}ReadWrite`,
      // Names an object has of its own: no right, and nothing they take in.
      inherited: "openid constructor __proto__ hasOwnProperty",
    };
    const ids: Record<string, string> = {};
    for (const [name, granted] of Object.entries(grants)) {
      app.options.granted = granted;
      const person = someone();
      // oxlint-disable-next-line no-await-in-loop -- each with its own grant
      ids[name] = await connect(person, accountOf(person));
    }
    await exports.default.requireClassRights({ classes: ["read-own"] });
    expect({
      prefixed: await statusOf(ids.prefixed ?? ""),
      inside: await statusOf(ids.inside ?? ""),
      inherited: await statusOf(ids.inherited ?? ""),
    }).toStrictEqual({
      prefixed: "active",
      inside: "needs_reauth",
      inherited: "needs_reauth",
    });
    // A class whose rights it was never granted asks it again too.
    await exports.default.requireClassRights({ classes: ["reach-others"] });
    await expect(statusOf(ids.prefixed ?? "")).resolves.toBe("needs_reauth");
  });

  it("AP18: a consent whose answer lists no grant is refused, and its grant revoked", async () => {
    const refused: Record<string, string> = {};
    const kept: Record<string, unknown> = {};
    for (const granted of [null, "", "  ", "\t"]) {
      const person = someone();
      const account = accountOf(person);
      app.options.granted = granted;
      // oxlint-disable-next-line no-await-in-loop -- each with its own grant
      refused[String(granted)] = await outcome(connect(person, account));
      kept[String(granted)] = app.tokensOf(account);
    }
    expect({ refused, kept }).toStrictEqual({
      refused: {
        null: "connection.scopes_refused",
        "": "connection.scopes_refused",
        "  ": "connection.scopes_refused",
        "\t": "connection.scopes_refused",
      },
      kept: { null: [], "": [], "  ": [], "\t": [] },
    });
  });

  it("AP18: a record joined with commas reads its answer's grant by them too", async () => {
    const provider = appProvider({
      provider: "sample-tenant",
      server: "sample-tenant",
      signIn: signInSchema.parse({
        ...sampleTenant.manifest.signIn,
        scopeSeparator: ",",
      }),
    });
    if (provider.kind !== "oauth") {
      throw new Error("An OAuth provider");
    }
    const answered = async (scope: string): Promise<TokenSet> => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json({ access_token: "tenant-access", scope })
      );
      return await exchangeCode(provider, client, acmeTenant, {
        code: "code",
        redirectUri: "https://grasp.example.test/callback",
        verifier: "verifier",
      });
    };
    const joined = await answered(
      "openid,profile,email,offline_access,Account.Read,Items.Read,Items.ReadWrite"
    );
    // A comma alone lists none.
    const none = await answered(",");
    expect({
      asAsked: grantedAsAsked(provider, joined),
      holds: holdsClassRights("sample-tenant", joined.scope ?? null, [
        "read-own",
        "change-own",
      ]),
      none: grantedAsAsked(provider, none),
    }).toStrictEqual({ asAsked: true, holds: true, none: false });
  });

  it("AP18: a renewal that no longer holds what it requires asks its person to reconnect", async () => {
    const person = someone();
    const lost = await connect(person, accountOf(person));
    app.options.renewed = "openid profile email offline_access Items.ReadWrite";
    await expire(lost);
    await expect(outcome(listItems(lost, person))).resolves.toBe(
      "connect.connection_inactive"
    );
    await expect(statusOf(lost)).resolves.toBe("needs_reauth");
    // Named with the prefix, it is held.
    const other = someone();
    const kept = await connect(other, accountOf(other));
    app.options.renewed = `openid ${sampleTenantScopePrefix}Account.Read`;
    await expire(kept);
    await expect(outcome(listItems(kept, other))).resolves.toBe("ok");
  });

  it("AP18: a renewal that lists no grant keeps the one it renews", async () => {
    const person = someone();
    const held = await connect(person, accountOf(person));
    const before = await grantOf(held);
    app.options.renewed = "";
    await expire(held);
    await expect(outcome(listItems(held, person))).resolves.toBe("ok");
    await expect(grantOf(held)).resolves.toBe(before);
    expect(before).toContain("Account.Read");
  });

  it("AP16: a suite's own config stands, and a declared provider's client is its own entry", async () => {
    const person = someone();
    const request = {
      person,
      scope: "personal",
      origin: clientOrigin,
      returnTo: "/",
      tenant: acmeTenant,
    } as const;
    // An apps' entry under a suite's name changes nothing of the suite's
    // flow: connect's own config, its endpoint and its client.
    const { url } = await startConnection(
      {
        ...env,
        APP_OAUTH_CLIENTS: JSON.stringify({
          microsoft: { id: "apps-microsoft", secret: "apps-microsoft-secret" },
        }),
      },
      { ...request, provider: "microsoft" }
    );
    const suite = new URL(url);
    expect({
      endpoint: suite.origin + suite.pathname,
      client: suite.searchParams.get("client_id"),
    }).toStrictEqual({
      endpoint: `https://login.microsoftonline.com/${acmeTenant}/oauth2/v2.0/authorize`,
      client: clients.microsoft.id,
    });
    // The fixture's client is its own entry, found by its name only.
    await expect(
      outcome(
        startConnection(
          {
            ...env,
            APP_OAUTH_CLIENTS: JSON.stringify({
              "sample-oauth": client,
              microsoft: client,
            }),
          },
          { ...request, provider: "sample-tenant" }
        )
      )
    ).resolves.toBe("connection.provider_unavailable");
  });

  it("AP17: an owed revoke never ends the grant its account consented to again", async () => {
    const person = someone();
    const account = accountOf(person);
    const connectionId = await connect(person, account);
    // Turning a class on asks it to connect again: its old grant is owed
    // a revoke.
    await exports.default.requireClassRights({ classes: ["reach-others"] });
    await expect(statusOf(connectionId)).resolves.toBe("needs_reauth");
    // The same account comes back, in place, before the revoke is tried.
    await expect(
      connect(person, account, { classes: ["reach-others"] })
    ).resolves.toBe(connectionId);
    // Its owed revoke comes due.
    await env.DB.prepare(
      "UPDATE token_revocations SET retry_at = 0 WHERE connection_id = ?"
    )
      .bind(connectionId)
      .run();
    await runMaintenance();
    // Revoking the old token would have ended the new grant with it.
    expect(app.requests.filter(({ url }) => url === revokeUrl)).toStrictEqual(
      []
    );
    await expect(audit.events()).resolves.toContainEqual(
      expect.objectContaining({
        action: "connection.revoke_superseded",
        target: { type: "connection", id: connectionId },
      })
    );
    await expect(outcome(listItems(connectionId, person))).resolves.toBe("ok");
  });
});
