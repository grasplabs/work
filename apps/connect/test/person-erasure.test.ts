import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  composioCleanups,
  connections,
  connectionTokens,
  connectorEvents,
  eventSources,
  idempotentCalls,
} from "../src/db/schema.ts";
import { connectApp, fakeApps } from "./app-provider.ts";
import { auditEvents, outcome, someone } from "./connect.ts";
import { sampleOAuthAuthHost } from "./fixtures/sample-oauth-connector.ts";
import { fakeProviders } from "./oauth-provider.ts";

// Erasing a person in connect (GRA-903, GRA-1183), from its threat model:
// - a grant of theirs left live at its provider behind an erasure: a live
//   connection (a sign-in that finished after they were removed) whose
//   revoke fails, or a Composio deletion still outstanding;
// - their provider's data left in what calls through their connections
//   returned;
// - someone else's touched: another person's connection, or a call made
//   for them through the company's shared connection;
// - an erasure with no record of it.

fakeProviders();
const apps = fakeApps();
const audit = auditEvents();

/** Erases `person` in connect, as core asks. */
const erase = async (person: ConnectionPerson) =>
  await exports.default.erasePersonal({ ownerUserId: person.userId });

/** A connection of the OAuth app, live, for `person`, as a late sign-in leaves one. */
const liveConnection = async (
  person: ConnectionPerson,
  scope: "personal" | "shared" = "personal"
) => {
  const account = apps.account("sample-oauth", person.email);
  const connectionId = await connectApp(apps, person, account, scope);
  const refreshToken = apps.issued.findLast((token) =>
    token.startsWith("app-refresh-")
  );
  return { connectionId, refreshToken: refreshToken ?? "" };
};

/** What connect keeps of connection `id`. */
const keptOf = async (id: string) => {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .get();
  const tokens = await db
    .select()
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, id));
  const calls = await db
    .select()
    .from(idempotentCalls)
    .where(eq(idempotentCalls.connectionId, id));
  return {
    status: row?.status,
    named: [
      row?.accountId,
      row?.accountName,
      row?.accountEmail,
      row?.accountAddresses,
      row?.accountSenders,
    ].some((value) => value !== null && value !== undefined),
    tokens: tokens.length,
    calls: calls.map(({ onBehalfOf }) => onBehalfOf),
  };
};

/** A call through connection `id` made for `userId`, as connect keeps it. */
const madeCall = async (id: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .insert(idempotentCalls)
    .values({
      subjectType: "app",
      subjectId: "app",
      onBehalfOf: userId,
      connectionId: id,
      action: "items.list",
      idempotencyKey: crypto.randomUUID(),
      inputHash: "h",
      state: "done",
      output: JSON.stringify({ items: ["Their item"] }),
      createdAt: new Date(),
    });
};

/**
 * A mailbox of theirs that connection `id` reads for a workflow, with an
 * item read from it still to deliver.
 */
const readsFor = async (id: string, address: string): Promise<void> => {
  const now = new Date();
  await drizzle(env.DB).batch([
    drizzle(env.DB).insert(eventSources).values({
      id: crypto.randomUUID(),
      connectionId: id,
      type: "mail.received",
      resource: address,
      pollAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(env.DB)
      .insert(connectorEvents)
      .values({
        id: crypto.randomUUID(),
        key: crypto.randomUUID(),
        connectionId: id,
        event: JSON.stringify({ from: address, subject: "Their mail" }),
        retryAt: now,
        createdAt: now,
      }),
  ]);
};

/** How many of what connection `id` read are still kept. */
const readOf = async (id: string) => {
  const db = drizzle(env.DB);
  const [sources, events] = await Promise.all([
    db.select().from(eventSources).where(eq(eventSources.connectionId, id)),
    db
      .select()
      .from(connectorEvents)
      .where(eq(connectorEvents.connectionId, id)),
  ]);
  return { sources: sources.length, events: events.length };
};

describe("erasing a person in connect", () => {
  it("revokes a grant still live at its provider before anything is emptied, and empties their connection", async () => {
    const person = someone();
    const { connectionId, refreshToken } = await liveConnection(person);
    await madeCall(connectionId, person.userId);
    await readsFor(connectionId, person.email);
    expect(apps.holds(refreshToken)).toBeTruthy();

    await expect(erase(person)).resolves.toStrictEqual({ connections: 1 });

    expect({
      revoked: apps.holds(refreshToken),
      asked: apps.revocations().length > 0,
      kept: await keptOf(connectionId),
      read: await readOf(connectionId),
    }).toStrictEqual({
      revoked: false,
      asked: true,
      kept: { status: "disconnected", named: false, tokens: 0, calls: [] },
      read: { sources: 0, events: 0 },
    });
  });

  it("refuses, leaving the connection and its tokens, while its provider won't revoke the grant, and finishes once it does", async () => {
    const person = someone();
    const { connectionId, refreshToken } = await liveConnection(person);
    const revokeAt = `https://${sampleOAuthAuthHost}/oauth/revoke`;
    // The fake apps answer every request through fetch's mock already:
    // the provider is made to fail its revocations only, on top of it.
    const through =
      vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
    let providerDown = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const { url } = new Request(input, init);
      return providerDown && url.startsWith(revokeAt)
        ? new Response("Down", { status: 503 })
        : await through(input, init);
    });

    const refused = await outcome(erase(person));
    const meanwhile = await keptOf(connectionId);
    providerDown = false;
    const finished = await erase(person);

    expect({
      refused,
      meanwhile,
      finished,
      revoked: apps.holds(refreshToken),
    }).toStrictEqual({
      refused: "connection.erase_pending",
      meanwhile: { status: "active", named: true, tokens: 1, calls: [] },
      finished: { connections: 1 },
      revoked: false,
    });
  });

  it("refuses while Composio's deletion of one of their connections is outstanding", async () => {
    const person = someone();
    const { connectionId } = await liveConnection(person);
    await exports.default.disconnectPersonal({
      person: null,
      ownerUserIds: [person.userId],
    });
    const db = drizzle(env.DB);
    const serverId = `server-${crypto.randomUUID()}`;
    await db
      .update(connections)
      .set({ composioServerId: serverId })
      .where(eq(connections.id, connectionId));
    const cleanupId = crypto.randomUUID();
    await db.insert(composioCleanups).values({
      id: cleanupId,
      serverId,
      attempts: 0,
      retryAt: new Date(),
      createdAt: new Date(),
    });

    const refused = await outcome(erase(person));
    const meanwhile = await keptOf(connectionId);
    await db.delete(composioCleanups).where(eq(composioCleanups.id, cleanupId));
    const finished = await erase(person);

    expect({ refused, named: meanwhile.named, finished }).toStrictEqual({
      refused: "connection.erase_pending",
      named: true,
      finished: { connections: 1 },
    });
  });

  it("leaves everyone else's as it was: another person's connection, and a call made for them through the company's shared connection", async () => {
    const person = someone();
    const other = someone();
    const admin = someone("admin");
    const theirs = await liveConnection(person);
    const others = await liveConnection(other);
    const shared = await liveConnection(admin, "shared");
    await madeCall(theirs.connectionId, person.userId);
    await madeCall(others.connectionId, other.userId);
    await madeCall(shared.connectionId, person.userId);
    const otherBefore = await keptOf(others.connectionId);
    const sharedBefore = await keptOf(shared.connectionId);

    await erase(person);

    expect({
      theirs: await keptOf(theirs.connectionId),
      others: await keptOf(others.connectionId),
      shared: await keptOf(shared.connectionId),
      othersHeld: apps.holds(others.refreshToken),
      sharedHeld: apps.holds(shared.refreshToken),
    }).toStrictEqual({
      theirs: { status: "disconnected", named: false, tokens: 0, calls: [] },
      others: otherBefore,
      shared: sharedBefore,
      othersHeld: true,
      sharedHeld: true,
    });
    expect(sharedBefore.calls).toStrictEqual([person.userId]);
  });

  it("is recorded each time it erases, by IDs only, even for someone with no connection", async () => {
    const person = someone();

    await expect(erase(person)).resolves.toStrictEqual({ connections: 0 });

    const events = await audit.events();
    const erased = events.filter(
      ({ action }) => action === "connection.person_erased"
    );
    expect(erased).toMatchObject([
      {
        source: "connect",
        actor: { type: "system" },
        detail: { ownerUserId: person.userId, connections: 0 },
      },
    ]);
    expect(JSON.stringify(erased)).not.toContain(person.email);
  });

  it("refuses when a sign-in of theirs finishes as it erases, and stops that connection on the next try", async () => {
    const person = someone();
    const late = `connection-${crypto.randomUUID()}`;
    const trigger = `late_${crypto.randomUUID().replaceAll("-", "_")}`;
    // As its batch lands, a flow of theirs finishes: a live connection,
    // named for their account, there by the time it looks again.
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} AFTER INSERT ON audit_outbox
       WHEN NEW.event LIKE '%connection.person_erased%' AND NEW.event LIKE '%${person.userId}%'
       BEGIN
         INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, account_id, account_email, created_at, updated_at)
         VALUES ('${late}', 'sample-oauth', 'personal', '${person.userId}', 'active', 'native', 'sample-oauth', 'late-account', 'late@acme.test', 0, 0);
       END`
    ).run();

    const refused = await outcome(erase(person));
    await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    const finished = await erase(person);

    expect({
      refused,
      finished,
      late: await keptOf(late),
    }).toStrictEqual({
      refused: "connection.erase_pending",
      finished: { connections: 1 },
      late: { status: "disconnected", named: false, tokens: 0, calls: [] },
    });
  });
});
