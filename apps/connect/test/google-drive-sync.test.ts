import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncPage, SyncPageRequest } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Google Workspace connector's Drive sync (drive-sync.ts), through
// connect's real read (src/sync.ts): a fresh isolate, the egress that adds
// the token, and Google mocked at its host. The ways it can fail come
// first: a file shared with the person synced by their connection (only
// its owner sees its whole reader list), a shared drive read through a
// person's own connection, "anyone with the link" taken as a reader, a
// deletion, a trip to the bin or a lost ownership missed, a change made
// during the first listing lost, a page past what a read may send, a gone
// cursor or a rate limit taken for a failure.

const providers = fakeProviders();

const apisHost = "www.googleapis.com";
const folder = "application/vnd.google-apps.folder";
const doc = "application/vnd.google-apps.document";
const form = "application/vnd.google-apps.form";

type DriveFile = Record<string, unknown> & { id: string };

/** What Drive holds, for each test to set. */
interface Drive {
  start: string;
  /** Every file the person owns, in listing order. */
  owned: DriveFile[];
  /** The change feed, by page token. */
  changes: Record<string, Record<string, unknown>>;
  /** Each file's content, by ID. */
  contents: Record<string, string>;
  /** Answers every request instead, when set. */
  answer?: (url: URL) => Response | undefined;
}

const drive: Drive = { start: "100", owned: [], changes: {}, contents: {} };

const reset = (): void => {
  drive.start = "100";
  drive.owned = [];
  drive.changes = {};
  drive.contents = {};
  drive.answer = undefined;
};

const listing = (url: URL): Response => {
  const size = Number(url.searchParams.get("pageSize") ?? 100);
  const from = Number(url.searchParams.get("pageToken") ?? 0);
  const next = from + size;
  return Response.json({
    files: drive.owned.slice(from, next),
    ...(next < drive.owned.length ? { nextPageToken: String(next) } : {}),
  });
};

const internet = fakeInternet((_request, url) => {
  const answered = drive.answer?.(url);
  if (answered !== undefined) {
    return answered;
  }
  if (url.hostname !== apisHost) {
    return new Response(null, { status: 404 });
  }
  const path = url.pathname;
  if (path === "/drive/v3/changes/startPageToken") {
    return Response.json({ startPageToken: drive.start });
  }
  if (path === "/drive/v3/changes") {
    const page = drive.changes[url.searchParams.get("pageToken") ?? ""];
    return page === undefined
      ? Response.json({ error: { code: 404 } }, { status: 404 })
      : Response.json(page);
  }
  if (path === "/drive/v3/files") {
    return listing(url);
  }
  const [id] = path.slice("/drive/v3/files/".length).split("/");
  const content = drive.contents[id ?? ""];
  return content === undefined
    ? Response.json({ error: { code: 404 } }, { status: 404 })
    : new Response(content);
});

/** What reached Google. */
const sentToGoogle = () =>
  internet.sent.filter(({ host }) => host === apisHost);

/** Someone's own Google account, connected. */
const connected = async (): Promise<string> => {
  reset();
  const person = someone();
  return await connectAccount(providers, person, ownAccount(person, "google"));
};

const request = (
  connectionId: string,
  cursor: string | null
): SyncPageRequest => ({ connectionId, feed: "drive", place: "own", cursor });

const read = async (connectionId: string, cursor: string | null) =>
  await exports.default.readSyncPage(request(connectionId, cursor));

const owner = "owner@acme.test";

/** A file the person owns, shared as `permissions`. */
const ownedFile = (
  id: string,
  fields: Record<string, unknown> = {}
): DriveFile => ({
  id,
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  size: "12",
  modifiedTime: "2026-11-10T09:00:00.000Z",
  version: "3",
  ownedByMe: true,
  lastModifyingUser: { emailAddress: "Owner@Acme.test" },
  permissions: [{ type: "user", emailAddress: owner }],
  ...fields,
});

const priceList = ownedFile("price-list", {
  name: "Price list",
  mimeType: doc,
  size: undefined,
  version: "7",
  permissions: [
    { type: "user", emailAddress: "Owner@Acme.test" },
    { type: "group", emailAddress: "Sales@Acme.test" },
    { type: "domain", domain: "Acme.test" },
    { type: "anyone" },
    { type: "user", emailAddress: "left@acme.test", deleted: true },
  ],
});

const contract = ownedFile("contract");
const survey = ownedFile("survey", { mimeType: form, size: undefined });
const video = ownedFile("video", {
  mimeType: "video/mp4",
  size: String(5 * 1024 * 1024),
});

describe("syncing a person's own Drive", () => {
  it("brings in every file they own, with its readers, from where the change feed stands", async () => {
    const connectionId = await connected();
    drive.owned = [priceList, contract, survey, video];
    drive.contents = { "price-list": "Coffee 3.20", contract: "%PDF-1.7" };

    const first = await read(connectionId, null);
    expect(first.items).toStrictEqual([
      {
        gone: false,
        id: "price-list",
        kind: "file",
        version: "7",
        changedAt: "2026-11-10T09:00:00.000Z",
        title: "Price list",
        content: { type: "text", text: "Coffee 3.20" },
        // Anyone with the link, and a deleted account, give nobody access.
        readers: [
          { kind: "account", id: owner },
          { kind: "group", id: "sales@acme.test" },
          { kind: "tenant", id: "acme.test" },
        ],
        changedBy: owner,
        partOf: null,
      },
      expect.objectContaining({
        id: "contract",
        content: {
          type: "file",
          contentType: "application/pdf",
          base64: btoa("%PDF-1.7"),
        },
      }),
      // A form has no text, and a file larger than a read takes comes
      // without its content: core counts them as skipped.
      expect.objectContaining({ id: "survey", content: null }),
      expect.objectContaining({ id: "video", content: null }),
    ]);
    expect(first.more).toBeTruthy();

    // Only the person's own files were listed, not what is shared with
    // them or in a shared drive, and the change feed's start was taken
    // before the listing, so nothing changed meanwhile is missed.
    const [start, list] = sentToGoogle();
    expect(start?.path).toBe("/drive/v3/changes/startPageToken");
    const listed = new URL(`https://${apisHost}${list?.path ?? ""}`);
    expect({
      q: listed.searchParams.get("q"),
      corpora: listed.searchParams.get("corpora"),
      allDrives: listed.searchParams.get("includeItemsFromAllDrives"),
    }).toStrictEqual({
      q: `'me' in owners and trashed = false and mimeType != '${folder}'`,
      corpora: "user",
      allDrives: null,
    });
    expect(
      sentToGoogle().some(({ path }) =>
        path.startsWith("/drive/v3/files/video")
      )
    ).toBeFalsy();
  });

  it("then brings only what changed, and what went away", async () => {
    const connectionId = await connected();
    drive.owned = [priceList, contract, survey, video];
    drive.contents = { "price-list": "Coffee 3.20", contract: "%PDF-1.7" };
    const first = await read(connectionId, null);

    drive.changes = {
      100: {
        newStartPageToken: "105",
        changes: [
          // Shared with fewer people.
          {
            fileId: "price-list",
            time: "2026-11-17T10:00:00.000Z",
            file: {
              ...priceList,
              version: "8",
              permissions: [{ type: "user", emailAddress: owner }],
            },
          },
          // Deleted, or out of the connection's reach.
          {
            fileId: "contract",
            removed: true,
            time: "2026-11-17T10:01:00.000Z",
          },
          // In the bin.
          {
            fileId: "survey",
            time: "2026-11-17T10:02:00.000Z",
            file: { ...survey, trashed: true },
          },
          // Given to someone else: their connection syncs it now.
          {
            fileId: "video",
            time: "2026-11-17T10:03:00.000Z",
            file: { ...video, ownedByMe: false },
          },
          // A folder is no item.
          {
            fileId: "folder-1",
            time: "2026-11-17T10:04:00.000Z",
            file: ownedFile("folder-1", { mimeType: folder }),
          },
        ],
      },
      105: { newStartPageToken: "105", changes: [] },
    };
    const changes = await read(connectionId, first.cursor);
    expect(changes.items).toStrictEqual([
      expect.objectContaining({
        id: "price-list",
        version: "8",
        changedAt: "2026-11-17T10:00:00.000Z",
        readers: [{ kind: "account", id: owner }],
      }),
      { gone: true, id: "contract", kind: "file" },
      { gone: true, id: "survey", kind: "file" },
      { gone: true, id: "video", kind: "file" },
    ]);
    expect(changes.more).toBeFalsy();

    // Nothing changed since: an empty page, and the same place.
    const quiet = await read(connectionId, changes.cursor);
    expect(quiet).toStrictEqual({
      items: [],
      cursor: changes.cursor,
      more: false,
    });
  });

  it("goes on where a full page stopped, within Google's page, each page within what a read may send", async () => {
    const connectionId = await connected();
    const many = Array.from({ length: 60 }, (_, index) =>
      ownedFile(`file-${index}`)
    );
    drive.owned = many;
    drive.contents = Object.fromEntries(many.map(({ id }) => [id, id]));
    drive.changes = { 100: { newStartPageToken: "100", changes: [] } };

    const seen: string[] = [];
    let cursor: string | null = null;
    let page: SyncPage;
    let reads = 0;
    do {
      const before = sentToGoogle().length;
      // oxlint-disable-next-line no-await-in-loop -- pages come one after another
      page = await read(connectionId, cursor);
      expect(sentToGoogle().length - before).toBeLessThanOrEqual(45);
      seen.push(...page.items.map(({ id }) => id));
      ({ cursor } = page);
      reads += 1;
    } while (page.more && reads < 10);
    expect(page.more).toBeFalsy();
    expect(reads).toBeGreaterThan(1);
    expect(seen.toSorted()).toStrictEqual(many.map(({ id }) => id).toSorted());
  });

  it("lists again when Google no longer has the cursor, or it isn't one the sync wrote", async () => {
    const connectionId = await connected();
    drive.changes = { 100: { newStartPageToken: "105", changes: [] } };
    const listed = await read(connectionId, null);
    const { cursor } = await read(connectionId, listed.cursor);

    // Google forgot the position: its token answers 404, or 410.
    drive.changes = {};
    await expect(read(connectionId, cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
    drive.answer = (url) =>
      url.pathname === "/drive/v3/changes"
        ? new Response(null, { status: 410 })
        : undefined;
    await expect(read(connectionId, cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
    await expect(read(connectionId, "x.made-up.0")).rejects.toMatchObject({
      code: "sync.restart",
    });
  });

  it("waits when Google rate limits, as it asks", async () => {
    const connectionId = await connected();
    drive.answer = () =>
      Response.json(
        { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
        { status: 403 }
      );
    const limited = await read(connectionId, null).catch(
      (error: unknown) => error
    );
    expect(syncErrors.codeOf(limited)).toBe("sync.throttled");

    drive.answer = () =>
      new Response(null, { status: 429, headers: { "retry-after": "30" } });
    await expect(read(connectionId, null)).rejects.toMatchObject({
      code: "sync.throttled",
      details: { retryAfterMs: 30_000 },
    });
  });
});
