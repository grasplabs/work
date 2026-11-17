import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncItem, SyncPageRequest } from "@grasp-os/shared/sync";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { connections, erasedPeople } from "../src/db/schema.ts";
import {
  addConnection,
  connectAccount,
  ownAccount,
  someone,
} from "./connect.ts";
import { sampleHost } from "./fixtures/sample-connector.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// Native sync's read (src/sync.ts): one page of a source's changes, read
// by a connector's sync (here `sample-sync`, test/fixtures) against the
// sample provider, the one outside system mocked. The ways it can fail
// come first: a place the connection may not sync, a shared connection
// read before anyone picked a place, a cursor that is a link (from core or
// from the provider), a sync sending a request it didn't declare, a
// connector of another provider, a connection disconnected or of someone
// being erased.

const providers = fakeProviders();

/** What the sample provider's change feed answers, for each test to set. */
const feed: { answer: () => Response } = {
  answer: () => Response.json({ changes: [], next: "1", more: false }),
};

const internet = fakeInternet(() => feed.answer());

/** What reached the sample provider. */
const sentToProvider = () =>
  internet.sent.filter(({ host }) => host === sampleHost);

/** A person's own Microsoft account, connected to `server`. */
const ownConnection = async (server = "sample-sync"): Promise<string> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  await drizzle(env.DB)
    .update(connections)
    .set({ server })
    .where(eq(connections.id, id));
  return id;
};

const read = async (request: SyncPageRequest) =>
  await exports.default.readSyncPage(request);

/** The code a read was refused with, or "ok". */
const outcomeOf = async (request: SyncPageRequest): Promise<string> => {
  try {
    await read(request);
    return "ok";
  } catch (error) {
    return syncErrors.codeOf(error) ?? String(error);
  }
};

/** The first page of `connectionId`'s own files. */
const firstPage = (connectionId: string): SyncPageRequest => ({
  connectionId,
  feed: "files",
  place: "own",
  cursor: null,
});

const shared: SyncItem = {
  gone: false,
  id: "file-1",
  kind: "file",
  version: "7",
  changedAt: "2026-11-17T09:00:00.000Z",
  title: "Price list",
  content: { type: "text", text: "Coffee 3.20" },
  readers: [
    { kind: "account", id: "oid-owner" },
    { kind: "group", id: "group-sales" },
    { kind: "tenant", id: "acme.test" },
  ],
  changedBy: "oid-owner",
  partOf: null,
};

const binned: SyncItem = { gone: true, id: "file-2", kind: "file" };

describe("reading a page of a sync", () => {
  it("reads the first listing of a person's own account, then the changes from its cursor", async () => {
    const connectionId = await ownConnection();
    feed.answer = () =>
      Response.json({ changes: [shared], next: "41", more: true });
    const first = await read({
      connectionId,
      feed: "files",
      place: "own",
      cursor: null,
    });
    expect(first).toStrictEqual({ items: [shared], cursor: "41", more: true });

    feed.answer = () =>
      Response.json({ changes: [binned], next: "42", more: false });
    const next = await read({
      connectionId,
      feed: "files",
      place: "own",
      cursor: first.cursor,
    });
    expect(next).toStrictEqual({ items: [binned], cursor: "42", more: false });

    // The cursor went to the provider as a position, with the
    // connection's token, which only the egress added.
    const [listing, changes] = sentToProvider();
    expect(listing?.path).toBe("/v1/me/changes");
    expect(changes?.path).toBe("/v1/me/changes?from=41");
    expect(changes?.headers.authorization).toMatch(/^Bearer \S+$/u);
  });

  it("refuses a place other than the connection's own account, before anything leaves", async () => {
    const connectionId = await ownConnection();
    await expect(
      outcomeOf({
        connectionId,
        feed: "files",
        place: "someone-elses-drive",
        cursor: null,
      })
    ).resolves.toBe("sync.place_refused");
    expect(sentToProvider()).toStrictEqual([]);
  });

  it("refuses every place of a shared connection while none is picked", async () => {
    const connectionId = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "sample-sync",
      tenant: "acme",
    });
    await expect(
      outcomeOf({
        connectionId,
        feed: "files",
        place: "own",
        cursor: null,
      })
    ).resolves.toBe("sync.place_refused");
    expect(sentToProvider()).toStrictEqual([]);
  });

  it("refuses a cursor that is a link, before anything leaves", async () => {
    const connectionId = await ownConnection();
    const links = [
      "https://elsewhere.test/changes?token=1",
      "//elsewhere.test/changes",
      "41?from=0",
      "41%2F..",
    ];
    await expect(
      Promise.all(
        links.map(
          async (cursor) =>
            await outcomeOf({
              connectionId,
              feed: "files",
              place: "own",
              cursor,
            })
        )
      )
    ).resolves.toStrictEqual(links.map(() => "sync.invalid"));
    expect(sentToProvider()).toStrictEqual([]);
  });

  it("never hands core a link the provider gave as the next position", async () => {
    const connectionId = await ownConnection();
    feed.answer = () =>
      Response.json({
        changes: [shared],
        next: "https://elsewhere.test/changes?token=1",
        more: false,
      });
    await expect(
      outcomeOf({
        connectionId,
        feed: "files",
        place: "own",
        cursor: null,
      })
    ).resolves.toBe("sync.provider_failed");
  });

  it("lets a sync send only the requests it declares", async () => {
    const connectionId = await ownConnection();
    await expect(
      outcomeOf({
        connectionId,
        feed: "files",
        place: "own",
        cursor: "probe-mailboxes",
      })
    ).resolves.toBe("sync.provider_failed");
    expect(sentToProvider()).toStrictEqual([]);
  });

  it("says when to list again, when to wait and when to reconnect, as the provider does", async () => {
    const connectionId = await ownConnection();
    const request = {
      connectionId,
      feed: "files",
      place: "own",
      cursor: "41",
    };
    feed.answer = () => new Response(null, { status: 410 });
    await expect(outcomeOf(request)).resolves.toBe("sync.restart");

    feed.answer = () =>
      new Response(null, { status: 429, headers: { "retry-after": "30" } });
    const throttled = await read(request).catch((error: unknown) => error);
    expect(syncErrors.codeOf(throttled)).toBe("sync.throttled");
    expect(throttled).toMatchObject({ details: { retryAfterMs: 30_000 } });

    feed.answer = () => new Response(null, { status: 401 });
    await expect(outcomeOf(request)).resolves.toBe("sync.inactive");
  });

  it("reads only a sync the connection's own connector declares", async () => {
    const connectionId = await ownConnection();
    await expect(
      outcomeOf({
        connectionId,
        feed: "mail",
        place: "own",
        cursor: null,
      })
    ).resolves.toBe("sync.not_found");

    // A connector for another provider than the connection's never gets
    // its token.
    const google = await ownConnection("sample-sync");
    await drizzle(env.DB)
      .update(connections)
      .set({ provider: "google" })
      .where(eq(connections.id, google));
    await expect(
      outcomeOf({
        connectionId: google,
        feed: "files",
        place: "own",
        cursor: null,
      })
    ).resolves.toBe("sync.not_found");
    expect(sentToProvider()).toStrictEqual([]);
  });

  it("reads nothing of a connection disconnected, needing reconnecting, or of someone being erased", async () => {
    const disconnected = await ownConnection();
    await drizzle(env.DB)
      .update(connections)
      .set({ status: "disconnected" })
      .where(eq(connections.id, disconnected));
    await expect(outcomeOf(firstPage(disconnected))).resolves.toBe(
      "sync.not_found"
    );

    const lapsed = await ownConnection();
    await drizzle(env.DB)
      .update(connections)
      .set({ status: "needs_reauth" })
      .where(eq(connections.id, lapsed));
    await expect(outcomeOf(firstPage(lapsed))).resolves.toBe("sync.inactive");

    const erased = await ownConnection();
    const owner = await drizzle(env.DB)
      .select({ userId: connections.ownerUserId })
      .from(connections)
      .where(eq(connections.id, erased))
      .get();
    await drizzle(env.DB)
      .insert(erasedPeople)
      .values({ userId: owner?.userId ?? "", beganAt: new Date() });
    await expect(outcomeOf(firstPage(erased))).resolves.toBe("sync.not_found");
    expect(sentToProvider()).toStrictEqual([]);
  });
});
