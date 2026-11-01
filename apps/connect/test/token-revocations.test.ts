import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { owedForMs } from "../src/revocations.ts";
import { connectApp, fakeApps } from "./app-provider.ts";
import {
  addConnection,
  auditEvents,
  connectAccount,
  outcome,
  ownAccount,
  runMaintenance,
  someone,
} from "./connect.ts";
import { sampleOAuthAuthHost } from "./fixtures/sample-oauth-connector.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { callTool } from "./tool-calls.ts";

// A disconnect's revoke at the provider, owed until it goes (GRA-1191),
// from its threat model first:
// - a grant left live at its provider for good: the provider was down
//   when the connection was disconnected, and the token to revoke it with
//   is gone, so nothing can try again, and nothing knows;
// - a token kept longer than it must be, or usable meanwhile: kept only
//   while its revoke is owed, of a disconnected connection nothing calls
//   with, and given up at the latest after a while, on record;
// - a retry loop against a provider that is down: each try waits longer
//   than the last, and a try under way isn't made twice at once;
// - a revoke racing a reconnect: where the grant is the account's
//   (Google), the same account connected again holds the grant the old
//   token would revoke, so the owed revoke is dropped, not made, and a
//   reconnect that lands as it is made is marked for signing in again;
//   where each token is its own grant, the old one is revoked all the same;
// - a kept token that no longer opens counted as revoked;
// - an owed revoke nobody can see: the disconnect says it is owed, and
//   how it ended is on record.

const providers = fakeProviders();
const apps = fakeApps();
const audit = auditEvents();

const revokeAt = `https://${sampleOAuthAuthHost}/oauth/revoke`;

/**
 * The OAuth app's revocation endpoint, down while `down()` says so; how
 * many revokes it was asked for.
 */
const providerDown = (down: () => boolean) => {
  const through =
    vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
  const asked = { revokes: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const { url } = new Request(input, init);
    if (url.startsWith(revokeAt)) {
      asked.revokes += 1;
    }
    return down() && url.startsWith(revokeAt)
      ? new Response("Down", { status: 503 })
      : await through(input, init);
  });
  return asked;
};

/** A live connection of the OAuth app for `person`, and its refresh token. */
const connected = async (person: ConnectionPerson) => {
  const account = apps.account("sample-oauth", person.email);
  const connectionId = await connectApp(apps, person, account);
  const refreshToken = apps.issued.findLast((token) =>
    token.startsWith("app-refresh-")
  );
  return { account, connectionId, refreshToken: refreshToken ?? "" };
};

/** What connect keeps of connection `id`'s revoke: its tokens, and whether it is owed. */
const keptOf = async (id: string) => {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT status FROM connections WHERE id = ?1) AS status,
       (SELECT count(*) FROM connection_tokens WHERE connection_id = ?1) AS tokens,
       (SELECT attempts FROM token_revocations WHERE connection_id = ?1) AS attempts`
  )
    .bind(id)
    .first<{ status: string; tokens: number; attempts: number | null }>();
  return {
    status: row?.status,
    tokens: row?.tokens,
    owed: row?.attempts !== null && row?.attempts !== undefined,
  };
};

/** When connection `id`'s owed revoke is tried next, in ms. */
const retryAtOf = async (id: string): Promise<number | undefined> => {
  const row = await env.DB.prepare(
    "SELECT retry_at AS at FROM token_revocations WHERE connection_id = ?"
  )
    .bind(id)
    .first<{ at: number }>();
  return row?.at;
};

/** Time passes: connection `id`'s owed revoke is due. */
const due = async (id: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE token_revocations SET retry_at = 0 WHERE connection_id = ?"
  )
    .bind(id)
    .run();
};

/** The recorded events of `action`, by their target and detail. */
const recorded = async (action: string) => {
  const events = await audit.events();
  return events
    .filter((event) => event.action === action)
    .map(({ target, detail }) => ({ target, detail }));
};

describe("a disconnect's revoke at the provider, owed until it goes", () => {
  it("owes the revoke with a sealed copy of the token while its provider won't revoke, and nothing calls with it", async () => {
    const person = someone();
    const { connectionId, refreshToken } = await connected(person);
    providerDown(() => true);

    const disconnected = await exports.default.disconnect({
      person,
      connectionId,
    });
    const call = await outcome(
      callTool(
        { id: connectionId, person },
        "items.list",
        { board: "board-1" },
        { resource: "board-1" }
      )
    );

    expect({
      disconnected,
      kept: await keptOf(connectionId),
      call,
      live: apps.holds(refreshToken),
      said: await recorded("connection.disconnect"),
    }).toMatchObject({
      disconnected: { revoked: false },
      kept: { status: "disconnected", tokens: 0, owed: true },
      call: "connect.connection_inactive",
      live: true,
      said: [{ detail: { revoked: false, revokePending: true } }],
    });
  });

  it("tries the revoke again from connect's clock, waiting longer after each failure, and deletes the token once it goes, on record", async () => {
    const person = someone();
    const { connectionId, refreshToken } = await connected(person);
    let down = true;
    const provider = providerDown(() => down);
    await exports.default.disconnect({ person, connectionId });

    await due(connectionId);
    const before = provider.revokes;
    await runMaintenance();
    const firstWait = ((await retryAtOf(connectionId)) ?? 0) - Date.now();
    // Not due yet: no try.
    await runMaintenance();
    const asked = provider.revokes - before;
    await due(connectionId);
    await runMaintenance();
    const secondWait = ((await retryAtOf(connectionId)) ?? 0) - Date.now();
    const meanwhile = await keptOf(connectionId);

    down = false;
    await due(connectionId);
    await runMaintenance();

    expect({
      asked,
      waitsLonger: secondWait > firstWait && firstWait > 0,
      meanwhile,
      after: await keptOf(connectionId),
      live: apps.holds(refreshToken),
      ended: await recorded("connection.revoked"),
    }).toMatchObject({
      asked: 1,
      waitsLonger: true,
      meanwhile: { tokens: 0, owed: true },
      after: { status: "disconnected", tokens: 0, owed: false },
      live: false,
      ended: [
        {
          target: { type: "connection", id: connectionId },
          detail: { outcome: "revoked", attempts: 3 },
        },
      ],
    });
  });

  it("revokes a per-token grant's old token though the same account is connected again, and leaves the new one", async () => {
    const person = someone();
    const { account, connectionId, refreshToken } = await connected(person);
    let down = true;
    providerDown(() => down);
    await exports.default.disconnect({ person, connectionId });
    // Connected again: a new connection, with a grant of its own.
    const again = await connectApp(apps, person, account);
    const newToken =
      apps.issued.findLast((token) => token.startsWith("app-refresh-")) ?? "";
    down = false;

    await due(connectionId);
    await runMaintenance();

    expect({
      old: await keptOf(connectionId),
      oldLive: apps.holds(refreshToken),
      current: await keptOf(again),
      newLive: apps.holds(newToken),
      ended: await recorded("connection.revoked"),
      superseded: await recorded("connection.revoke_superseded"),
    }).toMatchObject({
      old: { tokens: 0, owed: false },
      oldLive: false,
      current: { status: "active", tokens: 1, owed: false },
      newLive: true,
      ended: [{ target: { type: "connection", id: connectionId } }],
      superseded: [],
    });
  });

  it("drops a Google revoke when the account is connected again, by its ID or its email, and leaves the account's grant live", async () => {
    const person = someone();
    const account = ownAccount(person, "google");
    const first = await connectAccount(providers, person, account);
    providers.state.revoke = () => providers.oauthError("server_error", 503);
    await exports.default.disconnect({ person, connectionId: first });
    // Where the old connection names the account by email alone.
    await env.DB.prepare(
      "UPDATE connections SET account_id = NULL WHERE id = ?"
    )
      .bind(first)
      .run();
    const again = await connectAccount(providers, person, account);
    providers.state.revoke = undefined;
    const asked = providers.revocations().length;

    await due(first);
    await runMaintenance();

    expect({
      old: await keptOf(first),
      current: await keptOf(again),
      grant: providers.grantHolds(account),
      revokes: providers.revocations().length - asked,
      superseded: await recorded("connection.revoke_superseded"),
    }).toMatchObject({
      old: { tokens: 0, owed: false },
      current: { status: "active", tokens: 1 },
      grant: true,
      revokes: 0,
      superseded: [{ target: { type: "connection", id: first } }],
    });
  });

  it("revokes a Google grant though another account with the same email but its own ID is connected", async () => {
    const person = someone();
    const account = ownAccount(person, "google");
    const first = await connectAccount(providers, person, account);
    providers.state.revoke = () => providers.oauthError("server_error", 503);
    await exports.default.disconnect({ person, connectionId: first });
    // Another account, once given the same address: its ID tells it apart.
    const other = { ...account, subject: `g-other-${person.userId}` };
    const again = await connectAccount(providers, person, other);
    providers.state.revoke = undefined;

    await due(first);
    await runMaintenance();

    expect({
      old: await keptOf(first),
      current: await keptOf(again),
      oldGrant: providers.grantHolds(account),
      otherGrant: providers.grantHolds(other),
      superseded: await recorded("connection.revoke_superseded"),
    }).toMatchObject({
      old: { tokens: 0, owed: false },
      current: { status: "active", tokens: 1 },
      oldGrant: false,
      otherGrant: true,
      superseded: [],
    });
  });

  it("revokes a Google Workspace grant though the same account is live on the directory, a client and grant of its own, and leaves the directory as it is", async () => {
    const person = someone("admin");
    const account = ownAccount(person, "google");
    const workspace = await connectAccount(providers, person, account);
    providers.state.revoke = () => providers.oauthError("server_error", 503);
    await exports.default.disconnect({ person, connectionId: workspace });
    const named = await env.DB.prepare(
      "SELECT account_id AS id, account_email AS email FROM connections WHERE id = ?"
    )
      .bind(workspace)
      .first<{ id: string; email: string }>();
    const directory = await addConnection({
      provider: "google-directory",
      serverKind: "native",
      server: "google-directory",
      tools: null,
      tenant: account.tenant,
      accountId: named?.id ?? null,
      accountEmail: named?.email ?? null,
    });
    providers.state.revoke = undefined;

    await due(workspace);
    await runMaintenance();

    expect({
      workspace: await keptOf(workspace),
      directory: await keptOf(directory),
      revoked: await recorded("connection.revoked"),
      superseded: await recorded("connection.revoke_superseded"),
      marked: await recorded("connection.needs_reauth"),
    }).toMatchObject({
      workspace: { tokens: 0, owed: false },
      directory: { status: "active" },
      revoked: [{ target: { type: "connection", id: workspace } }],
      superseded: [],
      marked: [],
    });
  });

  it("marks a Google reconnect that lands while the revoke is on its way for signing in again, on record", async () => {
    const person = someone();
    const account = ownAccount(person, "google");
    const first = await connectAccount(providers, person, account);
    providers.state.revoke = () => providers.oauthError("server_error", 503);
    await exports.default.disconnect({ person, connectionId: first });
    let again = "";
    // The provider takes the revoke only after the account connects again.
    providers.state.revoke = async () => {
      providers.state.revoke = undefined;
      again = await connectAccount(providers, person, account);
      return new Response(null, { status: 200 });
    };

    await due(first);
    await runMaintenance();

    expect({
      old: await keptOf(first),
      current: await keptOf(again),
      marked: await recorded("connection.needs_reauth"),
    }).toMatchObject({
      old: { tokens: 0, owed: false },
      current: { status: "needs_reauth", tokens: 0 },
      marked: [
        {
          target: { type: "connection", id: again },
          detail: { reason: "grant_revoked" },
        },
      ],
    });
  });

  it("gives up, never counting as revoked, an owed revoke whose token copy no longer opens", async () => {
    const person = someone();
    const { connectionId, refreshToken } = await connected(person);
    let down = true;
    providerDown(() => down);
    await exports.default.disconnect({ person, connectionId });
    await env.DB.prepare(
      "UPDATE token_revocations SET sealed = 'changed at rest' WHERE connection_id = ?"
    )
      .bind(connectionId)
      .run();
    down = false;
    const logged = vi.spyOn(console, "error").mockReturnValue();

    await due(connectionId);
    await runMaintenance();
    logged.mockRestore();

    expect({
      kept: await keptOf(connectionId),
      live: apps.holds(refreshToken),
      revoked: await recorded("connection.revoked"),
      ended: await recorded("connection.revoke_abandoned"),
    }).toMatchObject({
      kept: { tokens: 0, owed: false },
      // Still live at the app: given up, on record, so someone can act.
      live: true,
      revoked: [],
      ended: [{ detail: { reason: "unreadable" } }],
    });
  });

  it("keeps an owed revoke, tried again later, while the key its token was sealed under isn't held", async () => {
    const person = someone();
    const { connectionId, refreshToken } = await connected(person);
    let down = true;
    providerDown(() => down);
    await exports.default.disconnect({ person, connectionId });
    // Sealed under a key the deployment doesn't hold now (a rotation slip).
    await env.DB.prepare(
      "UPDATE token_revocations SET sealed = 'v1.0123456789abcdef.AAAAAAAAAAAAAAAA.AAAA' WHERE connection_id = ?"
    )
      .bind(connectionId)
      .run();
    down = false;
    const logged = vi.spyOn(console, "error").mockReturnValue();

    await due(connectionId);
    await runMaintenance();
    logged.mockRestore();

    expect({
      kept: await keptOf(connectionId),
      retried: ((await retryAtOf(connectionId)) ?? 0) > Date.now(),
      live: apps.holds(refreshToken),
      ended: await recorded("connection.revoke_abandoned"),
    }).toMatchObject({
      kept: { owed: true },
      retried: true,
      live: true,
      ended: [],
    });
  });

  it("gives an owed revoke up after its time, on record, and keeps the token no longer", async () => {
    const person = someone();
    const { connectionId } = await connected(person);
    providerDown(() => true);
    await exports.default.disconnect({ person, connectionId });
    await env.DB.prepare(
      "UPDATE token_revocations SET created_at = ?, retry_at = 0 WHERE connection_id = ?"
    )
      .bind(Date.now() - owedForMs - 1000, connectionId)
      .run();
    // Given up is an error: someone should know a grant may be live.
    const logged = vi.spyOn(console, "error").mockReturnValue();

    await runMaintenance();
    logged.mockRestore();

    expect({
      kept: await keptOf(connectionId),
      ended: await recorded("connection.revoke_abandoned"),
    }).toMatchObject({
      kept: { tokens: 0, owed: false },
      ended: [{ detail: { reason: "expired" } }],
    });
  });

  it("leaves the token a provider handed the account again when it connected again, the same refresh token being its live grant", async () => {
    const person = someone();
    const { account, connectionId, refreshToken } = await connected(person);
    apps.options.sameRefreshToken = true;
    let down = true;
    providerDown(() => down);
    await exports.default.disconnect({ person, connectionId });
    const again = await connectApp(apps, person, account);
    down = false;

    await due(connectionId);
    await runMaintenance();

    expect({
      live: apps.holds(refreshToken),
      current: await keptOf(again),
      old: await keptOf(connectionId),
      superseded: await recorded("connection.revoke_superseded"),
      revoked: await recorded("connection.revoked"),
    }).toMatchObject({
      live: true,
      current: { status: "active", tokens: 1 },
      old: { owed: false },
      superseded: [
        {
          target: { type: "connection", id: connectionId },
          detail: { reason: "same_token" },
        },
      ],
      revoked: [],
    });
  });
});
