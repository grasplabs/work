import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncItem, SyncPage } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Microsoft 365 connector's OneDrive sync (onedrive-sync.ts), through
// connect's real read (src/sync.ts): a fresh isolate, the egress that adds
// the token and follows a download's redirect without it, and Graph mocked
// at its host. The ways it can fail come first: a link taken as a reader,
// readers taken from an earlier read, a shortcut to someone else's file
// synced as the person's own, a deletion or an item the account can no
// longer read missed, Graph's links followed, an entry skipped when a page
// stops inside Graph's page, a slow file stalling the sync, a gone token
// or a rate limit taken for a failure.

const providers = fakeProviders();

const graphHost = "graph.microsoft.com";
const storageHost = "acme-my.sharepoint.com";
const drivePath = "/v1.0/me/drive";
const deltaPath = `${drivePath}/root/delta`;
const driveId = "b!own-drive";

type Entry = Record<string, unknown> & { id: string };

/** What the person's OneDrive holds, for each test to set. */
interface Drive {
  owner: string;
  /** Its `driveType`: a work account's `business`, or `personal`. */
  type: string;
  /** How the feed's delta link carries its token. */
  deltaLinkForm: "parenthesised" | "query";
  /** A path answered only after `ms`. */
  slow?: { path: string; ms: number };
  /** The delta feed: each token's entries, and the token after them. */
  feed: Record<string, { entries: Entry[]; end: string }>;
  /** Each item's permissions, by ID; none: Graph has no such item. */
  permissions: Record<string, unknown[]>;
  /** Each file's bytes, by ID. */
  contents: Record<string, string>;
  /** Answers every request instead, when it answers. */
  answer?: (url: URL) => Response | Promise<Response | undefined> | undefined;
}

const drive: Drive = {
  owner: "",
  type: "business",
  deltaLinkForm: "parenthesised",
  feed: {},
  permissions: {},
  contents: {},
};

const reset = (owner: string): void => {
  drive.owner = owner;
  drive.type = "business";
  drive.deltaLinkForm = "parenthesised";
  drive.slow = undefined;
  drive.feed = {};
  drive.permissions = {};
  drive.contents = {};
  drive.answer = undefined;
};

/** The first listing's token: none. */
const start = "";

/** Graph's clock, as its `Date` header gives it. */
const graphDate = "Tue, 17 Nov 2026 10:00:00 GMT";

/** The timestamp token of when a listing began, by Graph's clock. */
const listedAt = "2026-11-17T10:00:00Z";

/**
 * One page of the feed from a token: up to `$top` entries from where the
 * token's `skip` says, with a next link while more are left, in the
 * `delta(token='…')` form Graph writes, and the delta link at the end, in
 * the `delta?(token='…')` form of Microsoft's delta page or the `?token=`
 * form.
 */
const feedPage = (url: URL): Response => {
  const [token = "", skip = "0"] = (url.searchParams.get("token") ?? "").split(
    "~"
  );
  const at = drive.feed[token];
  if (at === undefined) {
    return Response.json(
      { error: { code: "resyncRequired" } },
      { status: 410 }
    );
  }
  const top = Number(url.searchParams.get("$top") ?? 200);
  const from = Number(skip);
  const value = at.entries.slice(from, from + top);
  const more = from + top < at.entries.length;
  const endLink =
    drive.deltaLinkForm === "query"
      ? `https://${graphHost}${deltaPath}?token=${at.end}`
      : `https://${graphHost}${deltaPath}?(token='${at.end}')`;
  return Response.json(
    {
      value,
      ...(more
        ? {
            "@odata.nextLink": `https://${graphHost}${deltaPath}(token='${token}~${from + top}')`,
          }
        : { "@odata.deltaLink": endLink }),
    },
    { headers: { date: graphDate } }
  );
};

const internet = fakeInternet(async (_request, url) => {
  if (drive.slow?.path === url.pathname) {
    await scheduler.wait(drive.slow.ms);
  }
  const answered = await drive.answer?.(url);
  if (answered !== undefined) {
    return answered;
  }
  if (url.hostname === storageHost) {
    const id = url.pathname.slice("/download/".length);
    const content = drive.contents[id];
    return content === undefined
      ? new Response(null, { status: 404 })
      : new Response(content);
  }
  if (url.hostname !== graphHost) {
    return new Response(null, { status: 404 });
  }
  const path = url.pathname;
  if (path === drivePath) {
    return Response.json({
      id: driveId,
      driveType: drive.type,
      owner: { user: { id: drive.owner, displayName: "Owner" } },
    });
  }
  if (path === deltaPath) {
    return feedPage(url);
  }
  const [, id, what] =
    /^\/v1\.0\/me\/drive\/items\/(?<id>[^/]+)\/(?<what>[a-z]+)$/u.exec(path) ??
    [];
  const notFound = Response.json(
    { error: { code: "itemNotFound" } },
    { status: 404 }
  );
  if (what === "permissions") {
    const permissions = drive.permissions[id ?? ""];
    return permissions === undefined
      ? notFound
      : Response.json({ value: permissions });
  }
  if (what === "content" && drive.contents[id ?? ""] !== undefined) {
    // Graph redirects to the file on SharePoint, as it does.
    return Response.redirect(`https://${storageHost}/download/${id}`, 302);
  }
  return notFound;
});

/** What reached Graph. */
const sentToGraph = () =>
  internet.sent.filter(({ host }) => host === graphHost);

const ownerId = "5d33dd65-0000-4000-8000-000000000001";
const colleague = "5d33dd65-0000-4000-8000-000000000002";
const sales = "5d33dd65-0000-4000-8000-0000000000aa";

/** Someone's own Microsoft account, connected. */
const connected = async (): Promise<string> => {
  reset(ownerId);
  const person = someone();
  return await connectAccount(providers, person, ownAccount(person));
};

const read = async (
  connectionId: string,
  cursor: string | null
): Promise<SyncPage> =>
  await exports.default.readSyncPage({
    connectionId,
    feed: "drive",
    place: "own",
    cursor,
  });

/** A file in the person's drive. */
const file = (id: string, fields: Record<string, unknown> = {}): Entry => ({
  id,
  name: `${id}.pdf`,
  eTag: `"{${id}},1"`,
  lastModifiedDateTime: "2026-11-10T09:00:00Z",
  size: 8,
  file: { mimeType: "application/pdf" },
  parentReference: { driveId, id: "root-id" },
  lastModifiedBy: { user: { id: ownerId.toUpperCase() } },
  ...fields,
});

const ownerOnly = [
  { id: "o", roles: ["owner"], grantedToV2: { user: { id: ownerId } } },
];

/** An item's version, if it is there. */
const versionOf = (item: SyncItem | undefined): string | null =>
  item?.gone === false ? item.version : null;

/** The readers of an item in the feed, by ID. */
const readersById = (items: readonly SyncItem[]) =>
  Object.fromEntries(
    items.map((item) => [item.id, item.gone ? "gone" : item.readers])
  );

describe("syncing a person's own OneDrive", () => {
  it("brings in every file in it, with who may open each as its permissions say", async () => {
    const connectionId = await connected();
    drive.feed[start] = {
      entries: [
        { id: "root-id", name: "root", root: {}, folder: { childCount: 3 } },
        // A shared folder in the listing is no reason to list again.
        {
          id: "folder-1",
          name: "Plans",
          folder: { childCount: 1 },
          sharing: { owner: {} },
        },
        file("price-list", { name: "Price list.docx" }),
        file("video", { size: 5 * 1024 * 1024 }),
      ],
      end: "t1",
    };
    drive.permissions = {
      "price-list": [
        ...ownerOnly,
        // Shared with one colleague, and with a group: its members are
        // core's to know.
        { id: "1", roles: ["write"], grantedToV2: { user: { id: colleague } } },
        { id: "2", roles: ["read"], grantedToV2: { group: { id: sales } } },
        // Anyone with the link, and everyone in the organisation with it:
        // a link, which counts for nobody.
        {
          id: "3",
          roles: ["read"],
          link: { scope: "anonymous", type: "view" },
        },
        {
          id: "4",
          roles: ["read"],
          link: { scope: "organization", type: "view" },
        },
        // A link for specific people: those people.
        {
          id: "5",
          roles: ["read"],
          link: { scope: "users", type: "view" },
          grantedToIdentitiesV2: [{ user: { id: colleague.toUpperCase() } }],
        },
        // A link for those who already have access adds nobody, nor does
        // an invitation nobody redeemed, nor a SharePoint site group.
        { id: "6", roles: ["read"], link: { scope: "existingAccess" } },
        { id: "7", roles: ["read"], invitation: { email: "x@outside.test" } },
        { id: "8", roles: ["read"], grantedToV2: { siteGroup: { id: "3" } } },
      ],
      video: ownerOnly,
    };
    drive.contents = { "price-list": "PK-docx" };

    const page = await read(connectionId, null);
    expect(page.items).toStrictEqual([
      {
        gone: false,
        id: "price-list",
        kind: "file",
        // SAFETY: an asymmetric matcher is compared as the string it
        // matches; `unknown` keeps its `any` from spreading.
        version: expect.stringMatching(
          /^"\{price-list\},1" [\da-f]{64}$/u
        ) as unknown,
        changedAt: "2026-11-10T09:00:00Z",
        title: "Price list.docx",
        content: {
          type: "file",
          contentType: "application/pdf",
          base64: btoa("PK-docx"),
        },
        readers: [
          { kind: "account", id: ownerId },
          { kind: "account", id: colleague },
          { kind: "group", id: sales },
          { kind: "link" },
        ],
        changedBy: ownerId,
        partOf: null,
      },
      // Larger than a read takes: without its content, never downloaded.
      expect.objectContaining({ id: "video", content: null }),
    ]);
    // The listing done, the feed is read again from when it began.
    expect(page.more).toBeTruthy();

    // Only the person's own drive was read, with the sync's own query and
    // no link of Graph's followed, and nothing of the video's content; the
    // download went to SharePoint without the token.
    const paths = sentToGraph().map(({ path }) => path);
    const feedRequest = sentToGraph().find(({ path }) =>
      path.startsWith(deltaPath)
    );
    const download = internet.sent.find(({ host }) => host === storageHost);
    expect({
      ownDriveOnly: paths.every((path) => path.startsWith(drivePath)),
      videoRead: paths.some((path) => path.includes("/items/video/content")),
      prefer: feedRequest?.headers.prefer,
      downloadToken: download?.headers.authorization,
    }).toStrictEqual({
      ownDriveOnly: true,
      videoRead: false,
      prefer: "hierarchicalsharing",
      downloadToken: undefined,
    });
  });

  it("then brings only what changed, and what went away or can no longer be read", async () => {
    const connectionId = await connected();
    const shared = [
      ...ownerOnly,
      { id: "1", roles: ["read"], grantedToV2: { user: { id: colleague } } },
    ];
    drive.feed[start] = {
      entries: [file("plan"), file("contract"), file("notes"), file("memo")],
      end: "t1",
    };
    drive.permissions = {
      plan: shared,
      contract: ownerOnly,
      notes: ownerOnly,
      memo: ownerOnly,
    };
    drive.contents = {
      plan: "plan",
      contract: "contract",
      notes: "n",
      memo: "m",
    };
    const first = await read(connectionId, null);
    const before = first.items.find(({ id }) => id === "plan");

    drive.feed[listedAt] = {
      entries: [
        // The drive's root, shared at the top of its hierarchy: no reason
        // to list again.
        { id: "root-id", root: {}, folder: {}, sharing: {} },
        // Unshared, its eTag the same: still a new version, as its
        // readers were read again.
        file("plan"),
        // Deleted.
        { id: "contract", deleted: { state: "deleted" } },
        // A shortcut to someone else's file: not the person's own.
        file("shortcut", {
          remoteItem: { id: "x", parentReference: { driveId: "b!other" } },
        }),
        // Graph no longer has its permissions, or refuses its content.
        file("notes"),
        file("memo"),
        // Changed twice in the feed: only the last counts.
        file("draft", { eTag: '"{draft},1"' }),
        { id: "draft", deleted: {} },
      ],
      end: "t2",
    };
    drive.permissions = { plan: ownerOnly, memo: ownerOnly, draft: ownerOnly };
    drive.contents.draft = "draft";
    drive.answer = (url) =>
      url.pathname.endsWith("/items/memo/content")
        ? Response.json({ error: { code: "accessDenied" } }, { status: 403 })
        : undefined;
    const changes = await read(connectionId, first.cursor);
    expect(readersById(changes.items)).toStrictEqual({
      plan: [{ kind: "account", id: ownerId }],
      contract: "gone",
      shortcut: "gone",
      notes: "gone",
      memo: "gone",
      draft: "gone",
    });
    const after = changes.items.find(({ id }) => id === "plan");
    expect({
      drafts: changes.items.filter(({ id }) => id === "draft"),
      newVersion:
        versionOf(after) !== null && versionOf(after) !== versionOf(before),
      more: changes.more,
    }).toStrictEqual({
      drafts: [{ gone: true, id: "draft", kind: "file" }],
      newVersion: true,
      more: false,
    });

    // Nothing changed since: an empty page, from the same place.
    drive.feed.t2 = { entries: [], end: "t2" };
    const quiet = await read(connectionId, changes.cursor);
    expect(quiet).toStrictEqual({
      items: [],
      cursor: changes.cursor,
      more: false,
    });
  });

  it("goes on after the last file a full page took, inside Graph's page, never skipping one", async () => {
    const connectionId = await connected();
    // Three files of 3 MiB: two fill a page's content.
    const large = "x".repeat(3 * 1024 * 1024);
    const many = [
      ...Array.from({ length: 50 }, (_, index) => file(`file-${index}`)),
      ...["big-1", "big-2", "big-3"].map((id) =>
        file(id, { size: large.length })
      ),
    ];
    drive.feed[start] = { entries: many, end: "t1" };
    drive.feed[listedAt] = { entries: [], end: "t1" };
    drive.permissions = Object.fromEntries(
      many.map(({ id }) => [id, ownerOnly])
    );
    drive.contents = Object.fromEntries(
      many.map(({ id }) => [id, id.startsWith("big") ? large : id])
    );

    const seen: SyncItem[] = [];
    let cursor: string | null = null;
    let page: SyncPage;
    let reads = 0;
    do {
      const sent = sentToGraph().length;
      // oxlint-disable-next-line no-await-in-loop -- pages come one after another
      page = await read(connectionId, cursor);
      // Within what a page may send.
      expect(sentToGraph().length - sent).toBeLessThanOrEqual(50);
      seen.push(...page.items);
      ({ cursor } = page);
      reads += 1;
    } while (page.more && reads < 20);
    expect(page.more).toBeFalsy();
    expect(seen.map(({ id }) => id).toSorted()).toStrictEqual(
      many.map(({ id }) => id).toSorted()
    );
    // Each with its content: a full page left it for the next one.
    expect(
      seen.every((item) => !item.gone && item.content !== null)
    ).toBeTruthy();
  });

  it("reads Graph's page from its top again when the file it stopped after changed meanwhile", async () => {
    const connectionId = await connected();
    const large = "x".repeat(3 * 1024 * 1024);
    const entries = ["a", "b", "c"].map((id) =>
      file(id, { size: large.length })
    );
    drive.feed[start] = { entries, end: "t1" };
    drive.permissions = { a: ownerOnly, b: ownerOnly, c: ownerOnly };
    drive.contents = { a: large, b: large, c: large };
    // One such file fills a page.
    const first = await read(connectionId, null);
    expect(first.items.map(({ id }) => id)).toStrictEqual(["a"]);

    // "a" changed again: Graph's page from the same token has it last now.
    drive.feed[start] = {
      entries: [
        file("b", { size: large.length }),
        file("c", { size: large.length }),
        file("a", { eTag: '"{a},2"', size: large.length }),
      ],
      end: "t1",
    };
    const next = await read(connectionId, first.cursor);
    expect(next.items.map(({ id }) => id)).toStrictEqual(["b"]);
  });

  it(
    "gives up a download at the page's deadline, so a slow file can never stall the sync",
    { timeout: 60_000 },
    async () => {
      const connectionId = await connected();
      drive.feed[start] = { entries: [file("slow"), file("next")], end: "t1" };
      drive.permissions = { slow: ownerOnly, next: ownerOnly };
      drive.contents = { slow: "slow", next: "next" };
      // Past the page's deadline, and past the 30 s connect waits.
      drive.slow = { path: "/download/slow", ms: 35_000 };
      const first = await read(connectionId, null);
      expect(first).toMatchObject({
        items: [{ id: "slow", content: null }],
        more: true,
      });

      drive.slow = undefined;
      const next = await read(connectionId, first.cursor);
      expect(next.items.map(({ id }) => id)).toStrictEqual(["next"]);
    }
  );

  it("relists the drive when a folder's sharing changes, as its files don't come", async () => {
    const connectionId = await connected();
    const plans = { id: "plans", name: "Plans", folder: { childCount: 1 } };
    drive.feed[start] = { entries: [plans, file("plan")], end: "t1" };
    // The colleague reads it through the folder's sharing.
    drive.permissions = {
      plan: [
        ...ownerOnly,
        { id: "1", roles: ["read"], grantedToV2: { user: { id: colleague } } },
      ],
    };
    drive.contents = { plan: "plan" };
    const listed = await read(connectionId, null);

    // The folder is unshared: only it comes back, with an emptied facet.
    drive.feed[listedAt] = {
      entries: [{ ...plans, sharing: {} }],
      end: "t2",
    };
    drive.permissions = { plan: ownerOnly };
    await expect(read(connectionId, listed.cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
    const relisted = await read(connectionId, null);
    expect(readersById(relisted.items)).toStrictEqual({
      plan: [{ kind: "account", id: ownerId }],
    });
  });

  it("reads the feed again from when the listing began, so nothing made during it is missed", async () => {
    const connectionId = await connected();
    const large = "x".repeat(3 * 1024 * 1024);
    const big = (id: string) => file(id, { size: large.length });
    drive.feed[start] = { entries: [big("a"), big("b")], end: "t1" };
    drive.permissions = { a: ownerOnly, b: ownerOnly, made: ownerOnly };
    drive.contents = { a: large, b: large, made: "made" };
    const first = await read(connectionId, null);

    // Made meanwhile: a new listing has it before where the read goes on.
    drive.feed[start] = {
      entries: [file("made"), big("a"), big("b")],
      end: "t1",
    };
    drive.feed.t1 = { entries: [], end: "t1" };
    drive.feed[listedAt] = { entries: [file("made")], end: "t1" };
    const seen = [...first.items];
    let page = await read(connectionId, first.cursor);
    seen.push(...page.items);
    page = await read(connectionId, page.cursor);
    seen.push(...page.items);
    expect(seen.map(({ id }) => id)).toStrictEqual(["a", "b", "made"]);
    expect(
      sentToGraph().some(({ path }) =>
        path.includes(`token=${encodeURIComponent(listedAt)}`)
      )
    ).toBeTruthy();
  });

  it("goes on from the delta link in each form Graph writes it, and a personal drive from its listing's own", async () => {
    const connectionId = await connected();
    drive.type = "personal";
    drive.deltaLinkForm = "query";
    drive.feed[start] = { entries: [file("plan")], end: "t1" };
    drive.permissions = { plan: ownerOnly };
    drive.contents = { plan: "plan" };
    const listed = await read(connectionId, null);
    expect(listed.more).toBeFalsy();

    drive.feed.t1 = {
      entries: [{ id: "plan", deleted: {} }],
      end: "t2",
    };
    const changes = await read(connectionId, listed.cursor);
    expect(changes.items).toStrictEqual([
      { gone: true, id: "plan", kind: "file" },
    ]);
  });

  it("lists again when Graph no longer knows the token, or the cursor isn't one the sync wrote", async () => {
    const connectionId = await connected();
    drive.feed[start] = { entries: [], end: "t1" };
    const { cursor } = await read(connectionId, null);

    // Graph forgot the token: 410 with a resync code.
    drive.feed = {};
    await expect(read(connectionId, cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
    await expect(read(connectionId, "x.bWFkZS11cA")).rejects.toMatchObject({
      code: "sync.restart",
    });
  });

  it("waits when Graph throttles, as long as it asks", async () => {
    const connectionId = await connected();
    drive.answer = () =>
      new Response(null, { status: 429, headers: { "retry-after": "30" } });
    const limited = await read(connectionId, null).catch(
      (error: unknown) => error
    );
    expect(syncErrors.codeOf(limited)).toBe("sync.throttled");
    expect(limited).toMatchObject({ details: { retryAfterMs: 30_000 } });
  });
});
