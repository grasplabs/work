import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { connections, connectionTokens } from "../src/db/schema.ts";
import { startConnection } from "../src/oauth.ts";
import { connectApp, fakeApps, startApp } from "./app-provider.ts";
import type { AppAccount } from "./app-provider.ts";
import {
  auditEvents,
  clientOrigin,
  outcome,
  someone,
  stateOf,
} from "./connect.ts";
import {
  sampleKeyApiHost,
  sampleKeyHeader,
} from "./fixtures/sample-key-connector.ts";
import {
  sampleOAuthApiHost,
  sampleOAuthAuthHost,
} from "./fixtures/sample-oauth-connector.ts";
import { fakeInternet, json } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { appClients } from "./provider-config.ts";
import { callTool } from "./tool-calls.ts";

// Signing in to an app that isn't a suite, as its connector's provider
// record describes it: OAuth 2.0 (sample-oauth) or an API key
// (sample-key), each one connector package with its record, and no change
// to connect. The threat model comes first; each case is a way it could
// fail, or be made to:
//
// AP1  A flow finished with the wrong verifier, replayed, past its time,
//      or by someone other than who started it.
// AP2  The code sent somewhere else: a redirect URI the record or a
//      request chose, or one other than the flow's at the exchange.
// AP3  A record pointing its endpoints, or its lookup, at a host that
//      would take the secret or the token: plain HTTP, an address, another
//      port, a host its connector doesn't call (the connector kit's
//      sign-in tests check the record; these check connect's side).
// AP4  More access than the record asks for: scopes added through its
//      parameters or the request.
// AP5  The refresh token reaching anything but the app's token endpoint:
//      the connector's isolate, a call's requests, an answer, a log line.
// AP6  One app's secret reaching another: credentials found by anything
//      but the provider's own name, a key app started as OAuth.
// AP7  An API key leaking: into logs, the audit log, an answer, the URL,
//      another header, or a request to anywhere but the app; the
//      connector replacing it or sending a second one.
// AP8  The wrong account: one the app didn't vouch for (an ID token the
//      app made up), someone else's as a personal connection, one already
//      connected; and a grant left behind that nobody holds.
// AP9  A record changing connect's own paths: taking a suite's name, or
//      starting what it has no record for.

// The suites' fakes come first, as fakeApps hands their requests on.
fakeProviders();
const apps = fakeApps();
const items = [{ id: "item-1", title: "First" }];
// The apps' APIs, for the connectors' calls: they answer only a token or
// key the app issued, in the header the app takes it in.
const internet = fakeInternet((request, url) => {
  const credential =
    url.hostname === sampleKeyApiHost
      ? request.headers.get(sampleKeyHeader)
      : request.headers.get("authorization")?.replace(/^Bearer /u, "");
  if (!apps.holds(credential ?? "")) {
    return json({ message: "Unauthorized" }, 401);
  }
  return json({ items });
});
const audit = auditEvents();

/** A new person whose own account at `provider` has their email. */
const personWithAccount = (
  provider: AppAccount["provider"],
  role: ConnectionPerson["role"] = "user"
): { person: ConnectionPerson; account: AppAccount } => {
  const person = someone(role);
  return { person, account: apps.account(provider, person.email) };
};

const finish = async (person: ConnectionPerson, state: string, code: string) =>
  await outcome(exports.default.finishConnection({ person, state, code }));

const connectionRow = async (id: string) =>
  await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .get();

/** Every log line written while `run` runs, as JSON. */
const logged = async (run: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  for (const method of ["info", "warn", "error", "log", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
  }
  await run();
  return lines.join("\n");
};

/** Lists a board through the connection's connector, as a workflow does. */
const listItems = async (
  connection: { id: string; person: ConnectionPerson },
  action = "items.list"
) =>
  await callTool(
    connection,
    action,
    { board: "board-1" },
    {
      resource: "board-1",
    }
  );

describe("an OAuth app", () => {
  it("connects through its record: PKCE, its scopes, its parameters, and connect's redirect URI", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    const url = await startApp(person);
    const {
      state,
      code_challenge: challenge,
      ...params
    } = Object.fromEntries(url.searchParams);
    expect({ endpoint: url.origin + url.pathname, ...params }).toStrictEqual({
      endpoint: `https://${sampleOAuthAuthHost}/oauth/authorize`,
      access_type: "offline",
      response_type: "code",
      client_id: appClients["sample-oauth"].id,
      redirect_uri: `${clientOrigin}/api/connections/callback`,
      scope: "items:read,items:write,offline",
      code_challenge_method: "S256",
    });
    // 256 random bits each; the verifier stays in connect.
    expect(`${state} ${challenge}`).toMatch(/^[\w-]{43} [\w-]{43}$/u);
    const { connectionId } = await exports.default.finishConnection({
      person,
      state: stateOf(url),
      code: apps.authorize(url.href, account),
    });
    await expect(connectionRow(connectionId)).resolves.toMatchObject({
      provider: "sample-oauth",
      server: "sample-oauth",
      scope: "personal",
      ownerUserId: person.userId,
      status: "active",
      tenant: null,
      accountId: account.id,
      accountName: account.name,
      accountEmail: account.email,
    });
    // The client in HTTP Basic, as the record says; never in the form.
    const [exchange] = apps.tokenRequests("authorization_code");
    expect(exchange?.headers.authorization).toMatch(/^Basic /u);
    expect(
      new URLSearchParams(exchange?.body).has("client_secret")
    ).toBeFalsy();
  });

  it("calls its connector with the access token, and refreshes it at the app", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    const id = await connectApp(apps, person, account);
    const first = await listItems({ id, person });
    expect(JSON.parse(first.output)).toStrictEqual({ items });
    // The access token runs out: the next call refreshes it first.
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(connectionTokens.connectionId, id));
    await listItems({ id, person });
    const [refresh] = apps.tokenRequests("refresh_token");
    expect(refresh?.headers.authorization).toMatch(/^Basic /u);
    const sent = internet.sent.map(({ host, path, headers }) => ({
      host,
      path,
      token: headers.authorization ?? "",
    }));
    expect(sent.map(({ host, path }) => `${host}${path}`)).toStrictEqual([
      `${sampleOAuthApiHost}/v1/boards/board-1/items`,
      `${sampleOAuthApiHost}/v1/boards/board-1/items`,
    ]);
    for (const { token } of sent) {
      expect(token).toMatch(/^Bearer app-access-/u);
    }
    expect(internet.sent[0]?.headers.authorization).not.toBe(
      internet.sent[1]?.headers.authorization
    );
  });

  it("is revoked at the app when disconnected", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    const connectionId = await connectApp(apps, person, account);
    const refreshToken = apps.issued.find((token) =>
      token.startsWith("app-refresh-")
    );
    await expect(
      exports.default.disconnect({ person, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(apps.holds(refreshToken ?? "")).toBeFalsy();
  });
});

describe("an app that takes an API key", () => {
  it("connects once the app takes the key, and calls its connector with it in the record's header", async () => {
    const { person, account } = personWithAccount("sample-key");
    const key = apps.keyFor(account);
    const { connectionId } = await exports.default.connectWithKey({
      person,
      provider: "sample-key",
      scope: "personal",
      key,
    });
    await expect(connectionRow(connectionId)).resolves.toMatchObject({
      provider: "sample-key",
      server: "sample-key",
      ownerUserId: person.userId,
      status: "active",
      accountId: account.id,
      accountEmail: account.email,
    });
    const result = await listItems({ id: connectionId, person });
    expect(JSON.parse(result.output)).toStrictEqual({ items });
    expect(internet.sent).toMatchObject([
      {
        host: sampleKeyApiHost,
        path: "/v1/boards/board-1/items",
        headers: { [sampleKeyHeader]: key },
      },
    ]);
    // Nothing to revoke: the app's own settings do that.
    await expect(
      exports.default.disconnect({ person, connectionId })
    ).resolves.toStrictEqual({ revoked: false });
    await expect(
      outcome(listItems({ id: connectionId, person }))
    ).resolves.toBe("connect.connection_inactive");
  });

  it("is refused when the app doesn't take the key, and nothing is kept", async () => {
    const { person } = personWithAccount("sample-key");
    const before = await drizzle(env.DB).select().from(connections);
    await expect(
      outcome(
        exports.default.connectWithKey({
          person,
          provider: "sample-key",
          scope: "personal",
          key: "a-key-the-app-never-issued",
        })
      )
    ).resolves.toBe("connection.provider_refused");
    await expect(
      drizzle(env.DB).select().from(connections)
    ).resolves.toHaveLength(before.length);
    await expect(audit.events()).resolves.toMatchObject([
      {
        action: "connection.connect",
        detail: {
          provider: "sample-key",
          outcome: "failed",
          reason: "connection.provider_refused",
        },
      },
    ]);
  });
});

describe("threat model", () => {
  it("AP1: a code redeems only with the flow's verifier, once, for the person who started it", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    const mallory = someone();
    // Another person's browser brings the code back: refused, and spent.
    const swapped = await startApp(person);
    const swappedCode = apps.authorize(swapped.href, account);
    // A code whose challenge isn't the flow's (an attacker's own flow).
    const own = await startApp(person);
    const other = await startApp(person);
    const foreignCode = apps.authorize(other.href, account);
    // A state replayed after it finished.
    const replayed = await startApp(person);
    const code = apps.authorize(replayed.href, account);
    expect({
      swapped: await finish(mallory, stateOf(swapped), swappedCode),
      swappedAgain: await finish(person, stateOf(swapped), swappedCode),
      foreign: await finish(person, stateOf(own), foreignCode),
      first: await finish(person, stateOf(replayed), code),
      replayed: await finish(person, stateOf(replayed), code),
    }).toStrictEqual({
      swapped: "connection.flow_invalid",
      swappedAgain: "connection.flow_invalid",
      foreign: "connection.provider_refused",
      first: "ok",
      replayed: "connection.flow_invalid",
    });
  });

  it("AP2: the code goes only to connect's redirect URI, and is exchanged with the flow's", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    // The request can't choose where the code goes: there is no field.
    await expect(
      outcome(
        exports.default.startConnection({
          person,
          provider: "sample-oauth",
          scope: "personal",
          origin: clientOrigin,
          returnTo: "/",
          // @ts-expect-error -- not a field of the request
          redirectUri: "https://evil.test/steal",
        })
      )
    ).resolves.toBe("connection.invalid");
    // A code the app issued for another redirect URI doesn't redeem.
    const url = await startApp(person);
    const tampered = new URL(url);
    tampered.searchParams.set("redirect_uri", "https://evil.test/steal");
    const code = apps.authorize(tampered.href, account);
    await expect(finish(person, stateOf(url), code)).resolves.toBe(
      "connection.provider_refused"
    );
    const [exchange] = apps.tokenRequests("authorization_code");
    expect(new URLSearchParams(exchange?.body).get("redirect_uri")).toBe(
      `${clientOrigin}/api/connections/callback`
    );
  });

  // The record's endpoints themselves (HTTPS, a DNS name, no port) are the
  // connector kit's sign-in tests'; here, connect's side of them.
  it("AP3: the client secret, the code and the tokens go only to the record's endpoints, never through a redirect", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    await connectApp(apps, person, account);
    expect(
      apps.requests.map(({ method, url }) => `${method} ${url}`)
    ).toStrictEqual([
      `POST https://${sampleOAuthAuthHost}/oauth/token`,
      `GET https://${sampleOAuthApiHost}/v1/me`,
    ]);
    // A lookup that redirects isn't followed: its token would go along.
    apps.options.lookup = () =>
      Response.redirect("https://evil.test/collect", 302);
    const other = personWithAccount("sample-oauth");
    await expect(
      outcome(connectApp(apps, other.person, other.account))
    ).resolves.toBe("connection.provider_refused");
    expect(internet.sent.map(({ host }) => host)).not.toContain("evil.test");
  });

  it("AP4: asks for the record's scopes only, whatever the request says", async () => {
    const { person } = personWithAccount("sample-oauth");
    await expect(
      outcome(
        exports.default.startConnection({
          person,
          provider: "sample-oauth",
          scope: "personal",
          origin: clientOrigin,
          returnTo: "/",
          // @ts-expect-error -- not a field of the request
          scopes: ["admin"],
        })
      )
    ).resolves.toBe("connection.invalid");
    const url = await startApp(person);
    expect(url.searchParams.getAll("scope")).toStrictEqual([
      "items:read,items:write,offline",
    ]);
  });

  it("AP5: the refresh token goes only to the app's token endpoint", async () => {
    const answers: unknown[] = [];
    const lines = await logged(async () => {
      const { person, account } = personWithAccount("sample-oauth");
      const id = await connectApp(apps, person, account);
      await drizzle(env.DB)
        .update(connectionTokens)
        .set({ accessExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(connectionTokens.connectionId, id));
      answers.push(
        await listItems({ id, person }),
        await exports.default.listConnections(person),
        await exports.default.connectionOwners([id])
      );
    });
    const refreshTokens = apps.issued.filter((token) =>
      token.startsWith("app-refresh-")
    );
    // The first grant's, and the one its refresh rotated to.
    expect(refreshTokens).toHaveLength(2);
    const elsewhere = [
      ...internet.sent.map((sent) => JSON.stringify(sent)),
      ...apps.requests
        .filter(({ url }) => !url.endsWith("/oauth/token"))
        .map((sent) => JSON.stringify(sent)),
      lines,
      JSON.stringify(answers),
      JSON.stringify(await audit.events()),
    ].join("\n");
    expect(
      refreshTokens.filter((token) => elsewhere.includes(token))
    ).toStrictEqual([]);
  });

  it("AP6: an app's client is its own entry, found by its name only", async () => {
    const { person } = personWithAccount("sample-oauth");
    const request = {
      person,
      provider: "sample-oauth",
      scope: "personal",
      origin: clientOrigin,
      returnTo: "/",
    } as const;
    const unset = [
      { ...env, APP_OAUTH_CLIENTS: undefined },
      // Another app's entry, or the suites', aren't this app's.
      {
        ...env,
        APP_OAUTH_CLIENTS: JSON.stringify({
          "sample-key": appClients["sample-oauth"],
        }),
      },
      // Not the map: every app is unset, and the value isn't logged.
      { ...env, APP_OAUTH_CLIENTS: '{"sample-oauth": "not-a-client"}' },
      { ...env, APP_OAUTH_CLIENTS: "not json, with a secret in it" },
    ];
    const lines = await logged(async () => {
      await expect(
        Promise.all(
          unset.map(
            async (without) => await outcome(startConnection(without, request))
          )
        )
      ).resolves.toStrictEqual(
        unset.map(() => "connection.provider_unavailable")
      );
    });
    expect(lines).toContain("APP_OAUTH_CLIENTS");

    expect(lines).not.toContain("secret in it");
    expect(lines).not.toContain("not-a-client");
    // An app that takes a key has no OAuth to start, and an OAuth app
    // takes no key.
    await expect(
      outcome(startConnection(env, { ...request, provider: "sample-key" }))
    ).resolves.toBe("connection.provider_unavailable");
    await expect(
      outcome(
        exports.default.connectWithKey({
          person,
          provider: "sample-oauth",
          scope: "personal",
          key: "some-key",
        })
      )
    ).resolves.toBe("connection.provider_unavailable");
  });

  it("AP6: a broken entry of another app's leaves an app's own client as it is", async () => {
    const { person } = personWithAccount("sample-oauth");
    const request = {
      person,
      provider: "sample-oauth",
      scope: "personal",
      origin: clientOrigin,
      returnTo: "/",
    } as const;
    await expect(
      outcome(
        startConnection(
          {
            ...env,
            APP_OAUTH_CLIENTS: JSON.stringify({
              ...appClients,
              "Not An App": "broken",
            }),
          },
          request
        )
      )
    ).resolves.toBe("ok");
  });

  it("AP7: an API key goes only to the app, in its header, and nowhere else", async () => {
    const { person, account } = personWithAccount("sample-key");
    const key = apps.keyFor(account);
    const lines = await logged(async () => {
      const { connectionId } = await exports.default.connectWithKey({
        person,
        provider: "sample-key",
        scope: "personal",
        key,
      });
      const connection = { id: connectionId, person };
      const answered = await listItems(connection);
      // The connector sends a key and a token of its own: the egress
      // replaces the one and drops the other.
      const forged = await listItems(connection, "items.forge");
      const listed = await exports.default.listConnections(person);
      const owners = await exports.default.connectionOwners([connectionId]);
      // A key the app refuses, and one that isn't a key, fail without it.
      const refused = await outcome(
        exports.default.connectWithKey({
          person,
          provider: "sample-key",
          scope: "personal",
          key: `${key}-revoked`,
        })
      );
      const invalid = await outcome(
        exports.default.connectWithKey({
          person,
          provider: "sample-key",
          scope: "personal",
          key: `${key}\nx-other: header`,
        })
      );
      const disconnected = await exports.default.disconnect({
        person,
        connectionId,
      });
      expect({ refused, invalid }).toStrictEqual({
        refused: "connection.provider_refused",
        invalid: "connection.invalid",
      });
      console.info(
        JSON.stringify([
          answered,
          forged,
          listed,
          owners,
          refused,
          invalid,
          disconnected,
        ])
      );
    });
    expect(
      internet.sent.map(({ host, path, headers }) => ({
        host,
        path,
        key: headers[sampleKeyHeader],
        authorization: headers.authorization,
      }))
    ).toStrictEqual([
      {
        host: sampleKeyApiHost,
        path: "/v1/boards/board-1/items",
        key,
        authorization: undefined,
      },
      {
        host: sampleKeyApiHost,
        path: "/v1/boards/board-1/items",
        key,
        authorization: undefined,
      },
    ]);
    // Only to the app's lookup, in its header, besides the calls.
    expect(
      apps.requests
        .filter(({ url, headers, body }) =>
          `${url} ${JSON.stringify(headers)} ${body}`.includes(key)
        )
        .map(({ url, headers }) => ({ url, key: headers[sampleKeyHeader] }))
    ).toStrictEqual([
      { url: `https://${sampleKeyApiHost}/v1/whoami`, key },
      { url: `https://${sampleKeyApiHost}/v1/whoami`, key: `${key}-revoked` },
    ]);
    const [stored] = await drizzle(env.DB)
      .select()
      .from(connectionTokens)
      .innerJoin(connections, eq(connections.id, connectionTokens.connectionId))
      .where(eq(connections.accountId, account.id));
    const seen = [
      lines,
      JSON.stringify(await audit.events()),
      JSON.stringify(stored ?? {}),
      ...internet.sent.map(({ path }) => path),
    ].join("\n");
    expect(seen).not.toContain(key);
  });

  it("AP7: a person's key is used only for their own calls", async () => {
    const { person, account } = personWithAccount("sample-key");
    const connectionId = await connectApp(apps, person, account);
    const colleague = someone();
    await expect(
      outcome(listItems({ id: connectionId, person: colleague }))
    ).resolves.not.toBe("ok");
    expect(internet.sent).toStrictEqual([]);
  });

  it("AP8: the account is the one the app's lookup names, never an ID token's", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    // An ID token the app made up for someone else is ignored.
    const claims = { sub: "someone-else", email: "boss@acme.test" };
    apps.options.idToken = [
      toBase64Url(new TextEncoder().encode('{"alg":"none"}')),
      toBase64Url(new TextEncoder().encode(JSON.stringify(claims))),
      "",
    ].join(".");
    const connectionId = await connectApp(apps, person, account);
    await expect(connectionRow(connectionId)).resolves.toMatchObject({
      accountId: account.id,
      accountEmail: account.email,
    });
  });

  it("AP8: a personal connection is to an account with the person's own email, and a refused one's tokens are revoked", async () => {
    const anna = someone();
    const colleagues = apps.account("sample-oauth", "ben@acme.test");
    const unnamed = apps.account("sample-oauth");
    const keyed = apps.account("sample-key", "ben@acme.test");
    expect({
      colleagues: await outcome(connectApp(apps, anna, colleagues)),
      unnamed: await outcome(connectApp(apps, anna, unnamed)),
      keyed: await outcome(connectApp(apps, anna, keyed)),
    }).toStrictEqual({
      colleagues: "connection.not_own_account",
      unnamed: "connection.not_own_account",
      keyed: "connection.not_own_account",
    });
    // What was minted for the refused accounts holds nothing.
    const minted = apps.issued.filter((token) =>
      token.startsWith("app-refresh-")
    );
    expect(minted.filter((token) => apps.holds(token))).toStrictEqual([]);
    // An admin connects such an account as a shared one.
    const ada = someone("admin");
    await expect(
      outcome(connectApp(apps, ada, unnamed, "shared"))
    ).resolves.toBe("ok");
    await expect(
      outcome(connectApp(apps, someone(), unnamed, "shared"))
    ).resolves.toBe("role.forbidden");
  });

  it("AP8: an account already connected can't be connected again, but a key connection takes its account's new key", async () => {
    const ada = someone("admin");
    const shared = apps.account("sample-oauth");
    await connectApp(apps, ada, shared, "shared");
    await expect(
      outcome(connectApp(apps, someone("admin"), shared, "shared"))
    ).resolves.toBe("connection.already_connected");
    // A key rotated at the app: the same connection, with the new key.
    const { person, account } = personWithAccount("sample-key");
    const first = await connectApp(apps, person, account);
    const second = await connectApp(apps, person, account);
    expect(second).toBe(first);
    await listItems({ id: first, person });
    const keys = apps.issued.filter((token) => token.startsWith("app-key-"));
    expect(
      internet.sent.map(({ headers }) => headers[sampleKeyHeader])
    ).toStrictEqual([keys.at(-1)]);
    // Nobody else gives it a key: not as their own, nor as a shared one.
    expect({
      colleague: await outcome(connectApp(apps, someone(), account)),
      asShared: await outcome(
        connectApp(apps, someone("admin"), account, "shared")
      ),
    }).toStrictEqual({
      colleague: "connection.not_own_account",
      asShared: "connection.already_connected",
    });
    await listItems({ id: first, person });
    expect(internet.sent.at(-1)?.headers[sampleKeyHeader]).toBe(keys.at(-1));
  });

  it("AP8: a lookup that fails refuses the connection, and revokes nothing a live connection might hold", async () => {
    const { person, account } = personWithAccount("sample-oauth");
    apps.options.lookup = () => json({ error: "unavailable" }, 503);
    await expect(outcome(connectApp(apps, person, account))).resolves.toBe(
      "connection.provider_refused"
    );
    // An answer without an ID names no account either.
    apps.options.lookup = () => json({ data: { name: "No ID" } });
    await expect(outcome(connectApp(apps, person, account))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(apps.revocations()).toStrictEqual([]);
  });

  it("AP9: a record can't take a suite's path, and a provider without one can't be started", async () => {
    const { person } = personWithAccount("sample-oauth");
    const start = async (provider: string, tenant?: string) =>
      await outcome(
        exports.default.startConnection({
          person,
          provider,
          scope: "personal",
          origin: clientOrigin,
          returnTo: "/",
          ...(tenant === undefined ? {} : { tenant }),
        })
      );
    expect({
      // No connector in the release carries its record.
      unknown: await start("no-such-app"),
      composio: await start("composio"),
      // A suite is pinned to the organization's tenant: none, none.
      suite: await start("microsoft"),
      // An app has no tenant to choose.
      withTenant: await start("sample-oauth", "evil.test"),
    }).toStrictEqual({
      unknown: "connection.provider_unavailable",
      composio: "connection.invalid",
      suite: "connection.provider_unavailable",
      withTenant: "ok",
    });
    // The tenant a request named for an app is no part of its flow.
    const url = await startApp(person);
    expect(url.searchParams.has("hd")).toBeFalsy();
    expect(url.searchParams.has("tenant")).toBeFalsy();
  });
});
