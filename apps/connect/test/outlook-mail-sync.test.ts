import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncPage } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Microsoft 365 connector's mail sync (mail-sync.ts), by message delta
// per folder, through connect's real reads (src/sync.ts): the folders as
// places (`listSyncPlaces`), each folder's pages (`readSyncPage`), a fresh
// isolate, the egress that adds the token, and Graph mocked at its host.
// The ways it can fail come first: Deleted Items, Junk Email, Drafts or a
// folder under them synced; a draft synced; a message deleted or moved
// out of a folder kept, or a moved one erased where it went; a message or
// file larger than connect reads stalling a folder; a slow message or
// file holding the sync; a field name Graph doesn't know; a made-up
// cursor or a rate limit taken for a failure.

const providers = fakeProviders();

const graphHost = "graph.microsoft.com";
const messagesPath = "/v1.0/me/messages";
const foldersPath = "/v1.0/me/mailFolders";

/** The connected person's Entra object ID, as Graph's /me gives it. */
let ownerId = "";

type Message = Record<string, unknown> & { id: string };

/** A folder's delta: each token's entries, and the delta token after them. */
type Feed = Record<string, { entries: Message[]; end: string }>;

/** What the mailbox holds, for each test to set. */
interface Mailbox {
  /** Each folder's parent. */
  parents: Record<string, string | null>;
  /** Hidden folders, and search folders, by ID. */
  hidden: Set<string>;
  search: Set<string>;
  /** The most folders Graph puts in one page of mailFolder delta. */
  folderPage: number;
  /** Each folder's delta feed, by folder. */
  feeds: Record<string, Feed>;
  /** Each message as Graph reads it on its own, by ID. */
  messages: Record<string, Message>;
  /** Each message's attachments, by message ID. */
  attachments: Record<string, Record<string, unknown>[]>;
  /** Each attachment's bytes, by `<message>/<attachment>`. */
  contents: Record<string, string>;
  /** A path answered only after `ms`. */
  slow?: { path: string; ms: number };
  /** Answers every request instead, when it answers. */
  answer?: (url: URL) => Response | undefined;
}

const mailbox: Mailbox = {
  parents: {},
  hidden: new Set(),
  search: new Set(),
  folderPage: 1000,
  feeds: {},
  messages: {},
  attachments: {},
  contents: {},
};

/** The well-known names Graph takes for folders. */
const wellKnown: Record<string, string> = {
  msgfolderroot: "root",
  searchfolders: "searches",
  deleteditems: "deleted",
  junkemail: "junk",
  drafts: "drafts",
};

const reset = (): void => {
  mailbox.parents = {
    root: "top",
    searches: "root",
    inbox: "root",
    projects: "inbox",
    archive: "root",
    deleted: "root",
    "old-project": "deleted",
    junk: "root",
    drafts: "root",
  };
  mailbox.hidden = new Set();
  mailbox.search = new Set();
  mailbox.folderPage = 1000;
  mailbox.feeds = {};
  mailbox.messages = {};
  mailbox.attachments = {};
  mailbox.contents = {};
  mailbox.slow = undefined;
  mailbox.answer = undefined;
};

/** Documented properties (resource pages), for the fake's `$select`. */
const messageProperties = new Set([
  "bccRecipients",
  "body",
  "bodyPreview",
  "categories",
  "ccRecipients",
  "changeKey",
  "conversationId",
  "conversationIndex",
  "createdDateTime",
  "flag",
  "from",
  "hasAttachments",
  "id",
  "importance",
  "inferenceClassification",
  "internetMessageHeaders",
  "internetMessageId",
  "isDeliveryReceiptRequested",
  "isDraft",
  "isRead",
  "isReadReceiptRequested",
  "lastModifiedDateTime",
  "parentFolderId",
  "receivedDateTime",
  "replyTo",
  "sender",
  "sentDateTime",
  "subject",
  "toRecipients",
  "uniqueBody",
  "webLink",
]);
const attachmentProperties = new Set([
  "contentType",
  "id",
  "isInline",
  "lastModifiedDateTime",
  "name",
  "size",
  "contentBytes",
  "contentId",
  "contentLocation",
]);
const folderProperties = new Set([
  "childFolderCount",
  "displayName",
  "id",
  "isHidden",
  "parentFolderId",
  "totalItemCount",
  "unreadItemCount",
]);

/**
 * The fields a request's `$select` names, or a 400 when it names one the
 * resource doesn't have, as Graph refuses it.
 */
const selected = (
  url: URL,
  known: ReadonlySet<string>
): string[] | Response => {
  const fields = (url.searchParams.get("$select") ?? "")
    .split(",")
    .filter(Boolean);
  return fields.every((name) => known.has(name))
    ? fields
    : Response.json(
        { error: { code: "RequestBroker--ParseUri" } },
        { status: 400 }
      );
};

/** Only the fields asked for, and the annotations, as Graph answers. */
const only = (
  each: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> =>
  fields.length === 0
    ? each
    : Object.fromEntries(
        Object.entries(each).filter(
          ([name]) => fields.includes(name) || name.startsWith("@")
        )
      );

const notFound = (): Response =>
  Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });

/**
 * A 400 when a request names a query option the endpoint doesn't take, as
 * Graph refuses it.
 */
const unknownOption = (url: URL, known: readonly string[]): Response | null =>
  [...url.searchParams.keys()].every((name) => known.includes(name))
    ? null
    : Response.json({ error: { code: "BadRequest" } }, { status: 400 });

/** A folder, as Graph gives it. */
const folderOf = (id: string): Record<string, unknown> => ({
  ...(mailbox.search.has(id)
    ? { "@odata.type": "#microsoft.graph.mailSearchFolder" }
    : {}),
  id,
  parentFolderId: mailbox.parents[id] ?? null,
  isHidden: mailbox.hidden.has(id),
  displayName: id,
});

/**
 * The mailbox's folders, as mailFolder delta lists them: as many a page
 * as `odata.maxpagesize` asks and Graph gives, with a skip token on.
 */
const folderDelta = (url: URL, prefer: string): Response => {
  const refused = unknownOption(url, ["$select", "$skiptoken", "$deltatoken"]);
  if (refused !== null) {
    return refused;
  }
  const fields = selected(url, folderProperties);
  if (fields instanceof Response) {
    return fields;
  }
  const asked = Number(
    /odata\.maxpagesize=(?<size>\d+)/u.exec(prefer)?.groups?.size ?? 10
  );
  const size = Math.min(asked, mailbox.folderPage);
  const from = Number(url.searchParams.get("$skiptoken") ?? 0);
  const all = Object.keys(mailbox.parents).filter((id) => id !== "top");
  const more = from + size < all.length;
  return Response.json({
    value: all.slice(from, from + size).map((id) => only(folderOf(id), fields)),
    ...(more
      ? {
          "@odata.nextLink": `https://${graphHost}${foldersPath}/delta?$skiptoken=${from + size}`,
        }
      : {
          "@odata.deltaLink": `https://${graphHost}${foldersPath}/delta?$deltatoken=f1`,
        }),
  });
};

/**
 * One page of a folder's delta: from its first listing (no token) or a
 * skip or delta token, as many messages as `odata.maxpagesize` asks.
 */
const messageDelta = (url: URL, folder: string, prefer: string): Response => {
  const refused = unknownOption(url, ["$select", "$skiptoken", "$deltatoken"]);
  if (refused !== null) {
    return refused;
  }
  const feed = mailbox.feeds[folder];
  if (feed === undefined) {
    return notFound();
  }
  const fields = url.searchParams.has("$select")
    ? selected(url, messageProperties)
    : [];
  if (fields instanceof Response) {
    return fields;
  }
  const [token = "", from = "0"] = (
    url.searchParams.get("$skiptoken") ??
    url.searchParams.get("$deltatoken") ??
    ""
  ).split("~");
  const at = feed[token];
  if (at === undefined) {
    return Response.json(
      { error: { code: "SyncStateNotFound" } },
      { status: 410 }
    );
  }
  const size = Number(
    /odata\.maxpagesize=(?<size>\d+)/u.exec(prefer)?.groups?.size ?? 10
  );
  const offset = Number(from);
  const value = at.entries
    .slice(offset, offset + size)
    .map((each) => only(each, fields));
  const more = offset + size < at.entries.length;
  const base = `https://${graphHost}${foldersPath}('${folder}')/messages/delta`;
  return Response.json({
    value,
    ...(more
      ? { "@odata.nextLink": `${base}?$skiptoken=${token}~${offset + size}` }
      : { "@odata.deltaLink": `${base}?$deltatoken=${at.end}` }),
  });
};

/** The query options a message's read, its attachments or a file take. */
const optionsOf = (
  part: string | undefined,
  attachment: string | undefined,
  value: string | undefined
): string[] => {
  if (part !== undefined && attachment === undefined) {
    return ["$select", "$skiptoken"];
  }
  return value === undefined ? ["$select"] : [];
};

/** A message, its attachments, or an attachment's bytes. */
const messageAnswer = (url: URL, rest: string[]): Response => {
  const [id = "", part, attachment, value] = rest;
  const message = mailbox.messages[id];
  if (message === undefined) {
    return notFound();
  }
  const refused = unknownOption(url, optionsOf(part, attachment, value));
  if (refused !== null) {
    return refused;
  }
  if (part === undefined) {
    const fields = selected(url, messageProperties);
    return fields instanceof Response
      ? fields
      : Response.json(only(message, fields));
  }
  if (attachment === undefined) {
    const fields = selected(url, attachmentProperties);
    return fields instanceof Response
      ? fields
      : Response.json({
          value: (mailbox.attachments[id] ?? []).map((each) =>
            only(each, fields)
          ),
        });
  }
  const content = mailbox.contents[`${id}/${attachment}`];
  return value === "$value" && content !== undefined
    ? new Response(content)
    : notFound();
};

const internet = fakeInternet(async (request, url) => {
  if (mailbox.slow?.path === url.pathname) {
    await scheduler.wait(mailbox.slow.ms);
  }
  const answered = mailbox.answer?.(url);
  if (answered !== undefined) {
    return answered;
  }
  if (url.hostname !== graphHost) {
    return notFound();
  }
  const path = url.pathname;
  if (path === `${foldersPath}/delta`) {
    return folderDelta(url, request.headers.get("prefer") ?? "");
  }
  const delta =
    /^\/v1\.0\/me\/mailFolders\/(?<folder>[^/]+)\/messages\/delta$/u.exec(path)
      ?.groups?.folder;
  if (delta !== undefined) {
    return messageDelta(url, delta, request.headers.get("prefer") ?? "");
  }
  if (path.startsWith(`${foldersPath}/`)) {
    const name = path.slice(foldersPath.length + 1);
    const refused = unknownOption(url, ["$select"]);
    if (refused !== null) {
      return refused;
    }
    const fields = selected(url, folderProperties);
    if (fields instanceof Response) {
      return fields;
    }
    const id = wellKnown[name] ?? name;
    return Object.hasOwn(mailbox.parents, id)
      ? Response.json(only(folderOf(id), fields))
      : notFound();
  }
  if (path.startsWith(`${messagesPath}/`)) {
    return messageAnswer(url, path.slice(messagesPath.length + 1).split("/"));
  }
  return notFound();
});

/** What reached Graph. */
const sentToGraph = () =>
  internet.sent.filter(({ host }) => host === graphHost);

/** Someone's own Microsoft account, connected. */
const connected = async (): Promise<string> => {
  reset();
  const person = someone();
  const account = ownAccount(person);
  ownerId = account.subject.toLowerCase();
  return await connectAccount(providers, person, account);
};

const read = async (
  connectionId: string,
  place: string,
  cursor: string | null
): Promise<SyncPage> =>
  await exports.default.readSyncPage({
    connectionId,
    feed: "mail",
    place,
    cursor,
  });

/** A message, as a folder's delta lists it and as Graph reads it. */
const message = (id: string, fields: Record<string, unknown> = {}): Message => {
  const whole: Message = {
    id,
    changeKey: `${id}-1`,
    lastModifiedDateTime: "2026-11-10T09:00:00Z",
    isDraft: false,
    hasAttachments: false,
    subject: `About ${id}`,
    body: { contentType: "text", content: `Body of ${id}` },
    from: { emailAddress: { name: "Ann", address: "ann@acme.test" } },
    toRecipients: [{ emailAddress: { address: "me@acme.test" } }],
    sentDateTime: "2026-11-10T08:59:00Z",
    ...fields,
  };
  mailbox.messages[id] = whole;
  return whole;
};

const removed = (id: string): Message => ({
  id,
  "@removed": { reason: "deleted" },
});

const owner = () => [{ kind: "account", id: ownerId }];

const pdf = {
  "@odata.type": "#microsoft.graph.fileAttachment",
  id: "pdf",
  name: "Offer.pdf",
  contentType: "application/pdf",
  size: 8,
  isInline: false,
};

describe("syncing a person's own mailbox, folder by folder", () => {
  it("lists every mail folder as a place, and not the bin, junk, drafts, hidden or search folders or what is under them", async () => {
    const connectionId = await connected();
    mailbox.parents = {
      ...mailbox.parents,
      secret: "root",
      "saved-search": "searches",
      "loose-search": "root",
    };
    mailbox.hidden = new Set(["secret"]);
    mailbox.search = new Set(["saved-search", "loose-search"]);
    const { places, cursor } = await exports.default.listSyncPlaces({
      connectionId,
      feed: "mail",
      cursor: null,
    });
    expect({ places: places.toSorted(), cursor }).toStrictEqual({
      places: ["archive", "inbox", "projects", "root"],
      cursor: null,
    });
  });

  it("lists the folders on every page of Graph's, across reads when they don't fit one", async () => {
    const connectionId = await connected();
    // Graph gives two folders a page: more pages than one read has requests.
    mailbox.folderPage = 2;
    const many = Array.from({ length: 120 }, (_, index) => `f${index}`);
    mailbox.parents = {
      ...mailbox.parents,
      ...Object.fromEntries(many.map((id) => [id, "inbox"])),
    };
    const listed: string[] = [];
    let cursor: string | null = null;
    let reads = 0;
    do {
      const answer: { places: string[]; cursor: string | null } =
        // oxlint-disable-next-line no-await-in-loop -- reads come one after another
        await exports.default.listSyncPlaces({
          connectionId,
          feed: "mail",
          cursor,
        });
      listed.push(...answer.places);
      ({ cursor } = answer);
      reads += 1;
    } while (cursor !== null && reads < 10);
    expect({ reads: reads > 1, places: new Set(listed) }).toStrictEqual({
      reads: true,
      places: new Set(["root", "inbox", "projects", "archive", ...many]),
    });
  });

  it("brings in a folder's messages and their files, and no draft", async () => {
    const connectionId = await connected();
    mailbox.feeds.inbox = {
      "": {
        entries: [
          message("offer", { hasAttachments: true }),
          message("draft", { isDraft: true }),
        ],
        end: "t1",
      },
    };
    mailbox.attachments.offer = [
      pdf,
      // A signature's picture, an attached message and a link: left out.
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "logo",
        size: 4,
        isInline: true,
      },
      { "@odata.type": "#microsoft.graph.itemAttachment", id: "fwd", size: 9 },
      {
        "@odata.type": "#microsoft.graph.referenceAttachment",
        id: "link",
        size: 1,
      },
    ];
    mailbox.contents = { "offer/pdf": "%PDF-1.7" };

    const page = await read(connectionId, "inbox", null);
    expect(page).toStrictEqual({
      items: [
        {
          gone: false,
          id: "inbox/offer",
          kind: "mail",
          version: "offer-1",
          changedAt: "2026-11-10T09:00:00Z",
          title: "About offer",
          content: {
            type: "text",
            text: "From: Ann <ann@acme.test>\nTo: me@acme.test\nDate: 2026-11-10T08:59:00Z\nSubject: About offer\n\nBody of offer",
          },
          readers: owner(),
          changedBy: null,
          partOf: null,
        },
        {
          gone: false,
          id: "inbox/offer/pdf",
          kind: "mail",
          version: "offer-1",
          changedAt: "2026-11-10T09:00:00Z",
          title: "Offer.pdf",
          content: {
            type: "file",
            contentType: "application/pdf",
            base64: btoa("%PDF-1.7"),
          },
          readers: owner(),
          changedBy: null,
          partOf: "inbox/offer",
        },
      ],
      // SAFETY: an asymmetric matcher is compared as the string it
      // matches; `unknown` keeps its `any` from spreading.
      cursor: expect.any(String) as unknown,
      more: false,
    });
    // Immutable IDs on every read, and only the folder's own delta.
    expect(
      sentToGraph().every(
        ({ headers }) =>
          headers.prefer?.includes('IdType="ImmutableId"') === true
      )
    ).toBeTruthy();
  });

  it("then brings only what changed, and what was deleted or moved out", async () => {
    const connectionId = await connected();
    mailbox.feeds.inbox = {
      "": { entries: [message("a"), message("b")], end: "t1" },
      t1: {
        entries: [message("a", { changeKey: "a-2" }), removed("b")],
        end: "t2",
      },
      t2: { entries: [], end: "t2" },
    };
    const first = await read(connectionId, "inbox", null);
    const changes = await read(connectionId, "inbox", first.cursor);
    const quiet = await read(connectionId, "inbox", changes.cursor);
    expect({
      changes: changes.items.map((item) => [
        item.id,
        item.gone ? "gone" : item.version,
      ]),
      quiet,
    }).toStrictEqual({
      changes: [
        ["inbox/a", "a-2"],
        ["inbox/b", "gone"],
      ],
      quiet: { items: [], cursor: changes.cursor, more: false },
    });
  });

  it("keeps a message moved to another folder there, whatever order the two folders are read in", async () => {
    const connectionId = await connected();
    // m keeps its ID when it moves (immutable IDs).
    mailbox.feeds.inbox = { "": { entries: [removed("m")], end: "t1" } };
    mailbox.feeds.archive = { "": { entries: [message("m")], end: "t1" } };
    const archive = await read(connectionId, "archive", null);
    const inbox = await read(connectionId, "inbox", null);
    expect({
      archive: archive.items.map(({ id, gone }) => [id, gone]),
      inbox: inbox.items.map(({ id, gone }) => [id, gone]),
    }).toStrictEqual({
      archive: [["archive/m", false]],
      inbox: [["inbox/m", true]],
    });
  });

  it("passes over a message larger than connect reads, without its content, and goes on", async () => {
    const connectionId = await connected();
    const huge = "x".repeat(11 * 1024 * 1024);
    mailbox.feeds.inbox = {
      "": {
        entries: [
          message("huge", { body: { contentType: "text", content: huge } }),
          message("next"),
        ],
        end: "t1",
      },
    };
    const page = await read(connectionId, "inbox", null);
    expect(
      page.items.map((item) => [item.id, !item.gone && item.content !== null])
    ).toStrictEqual([
      ["inbox/huge", false],
      ["inbox/next", true],
    ]);
  });

  it(
    "leaves a message whose file is late to the next page once the page holds one, and passes the first over",
    { timeout: 120_000 },
    async () => {
      const connectionId = await connected();
      mailbox.feeds.inbox = {
        "": {
          entries: [message("a"), message("b", { hasAttachments: true })],
          end: "t1",
        },
      };
      mailbox.attachments.b = [pdf];
      mailbox.contents = { "b/pdf": "%PDF" };
      // Always past the page's deadline, and past the 30 s connect waits.
      mailbox.slow = {
        path: `${messagesPath}/b/attachments/pdf/$value`,
        ms: 35_000,
      };
      const first = await read(connectionId, "inbox", null);
      const second = await read(connectionId, "inbox", first.cursor);
      mailbox.slow = undefined;
      expect({
        first: first.items.map(({ id }) => id),
        // As the page's first, it can't hold the sync: without its content.
        second: second.items.map((item) => [
          item.id,
          !item.gone && item.content !== null,
        ]),
      }).toStrictEqual({
        first: ["inbox/a"],
        second: [["inbox/b", false]],
      });
    }
  );

  it("goes through a folder of many messages, each page within what a read may send, skipping none", async () => {
    const connectionId = await connected();
    const many = Array.from({ length: 120 }, (_, index) =>
      message(`m${index}`)
    );
    mailbox.feeds.inbox = { "": { entries: many, end: "t1" } };
    const seen: string[] = [];
    let cursor: string | null = null;
    let page: SyncPage;
    let reads = 0;
    do {
      const sent = sentToGraph().length;
      // oxlint-disable-next-line no-await-in-loop -- pages come one after another
      page = await read(connectionId, "inbox", cursor);
      expect(sentToGraph().length - sent).toBeLessThanOrEqual(50);
      seen.push(...page.items.map(({ id }) => id));
      ({ cursor } = page);
      reads += 1;
    } while (page.more && reads < 10);
    expect(new Set(seen)).toStrictEqual(
      new Set(many.map(({ id }) => `inbox/${id}`))
    );
  });

  it("lists a folder again when Graph no longer knows its token, or the cursor isn't one the sync wrote", async () => {
    const connectionId = await connected();
    mailbox.feeds.inbox = { "": { entries: [], end: "t1" } };
    const { cursor } = await read(connectionId, "inbox", null);
    mailbox.feeds.inbox = {};
    await expect(read(connectionId, "inbox", cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
    await expect(read(connectionId, "inbox", "m.s")).rejects.toMatchObject({
      code: "sync.restart",
    });
  });

  it("waits when Graph throttles, as long as it asks", async () => {
    const connectionId = await connected();
    mailbox.answer = () =>
      new Response(null, { status: 429, headers: { "retry-after": "30" } });
    const limited = await read(connectionId, "inbox", null).catch(
      (error: unknown) => error
    );
    expect(syncErrors.codeOf(limited)).toBe("sync.throttled");
    expect(limited).toMatchObject({ details: { retryAfterMs: 30_000 } });
  });
});
