import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncItem, SyncPage } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Microsoft 365 connector's mail sync (mail-sync.ts), through connect's
// real read (src/sync.ts): a fresh isolate, the egress that adds the token,
// and Graph mocked at its host. The ways it can fail come first: a message
// in Deleted Items, Junk Email or a deleted folder kept, a draft synced, a
// message skipped among others changed at the same second or past a page
// of Graph's, one changed at the second Graph answered missed, a slow
// attachment stalling the sync, a made-up cursor or a rate limit taken for
// a failure.

const providers = fakeProviders();

const graphHost = "graph.microsoft.com";
const messagesPath = "/v1.0/me/messages";
/** The connected person's Entra object ID, as Graph's /me gives it. */
let ownerId = "";

/** Graph's clock, as its `Date` header gives it. */
const graphDate = "Tue, 17 Nov 2026 10:00:00 GMT";

type Message = Record<string, unknown> & {
  id: string;
  lastModifiedDateTime: string;
};

/** What the mailbox holds, for each test to set. */
interface Mailbox {
  /** Every message, in the order Graph lists those changed at one time. */
  messages: Message[];
  /** Each message's attachments, by message ID. */
  attachments: Record<string, Record<string, unknown>[]>;
  /** Each attachment's bytes, by `<message>/<attachment>`. */
  contents: Record<string, string>;
  /** The most messages Graph puts in one listing page. */
  graphPage: number;
  /** Graph's clock. */
  date: string;
  /** A path answered only after `ms`. */
  slow?: { path: string; ms: number };
  /** Called once a listing page has been answered. */
  listed?: () => void;
  /** Answers every request instead, when it answers. */
  answer?: (url: URL) => Response | undefined;
}

const mailbox: Mailbox = {
  messages: [],
  attachments: {},
  contents: {},
  graphPage: 1000,
  date: graphDate,
};

/** Each folder's parent, and the well-known names Graph takes. */
const parents: Record<string, string | null> = {
  top: null,
  root: "top",
  inbox: "root",
  projects: "inbox",
  deleted: "root",
  "old-project": "deleted",
  junk: "root",
  hidden: "top",
};
const wellKnown: Record<string, string> = {
  msgfolderroot: "root",
  deleteditems: "deleted",
  junkemail: "junk",
};

const reset = (): void => {
  mailbox.messages = [];
  mailbox.attachments = {};
  mailbox.contents = {};
  mailbox.graphPage = 1000;
  mailbox.date = graphDate;
  mailbox.slow = undefined;
  mailbox.listed = undefined;
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

/** Only the fields asked for (and `@odata.type`), as Graph answers `$select`. */
const only = (
  each: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> =>
  fields.length === 0
    ? each
    : Object.fromEntries(
        Object.entries(each).filter(
          ([name]) => fields.includes(name) || name === "@odata.type"
        )
      );

const filterPattern = /^lastModifiedDateTime (?<op>gt|eq) (?<time>\S+)$/u;

/**
 * One listing page: messages changed after (`gt`) or at (`eq`) the
 * filter's time, oldest first, those of one time in the mailbox's order,
 * a page at a time with a next link that carries Graph's own `$skip`.
 */
const listing = (url: URL): Response => {
  const fields = selected(url, messageProperties);
  if (fields instanceof Response) {
    return fields;
  }
  const filter = filterPattern.exec(url.searchParams.get("$filter") ?? "");
  const { op, time = "" } = filter?.groups ?? {};
  const top = Math.min(
    Number(url.searchParams.get("$top") ?? 10),
    mailbox.graphPage
  );
  const skip = Number(url.searchParams.get("$skip") ?? 0);
  const listed = mailbox.messages
    .filter(({ lastModifiedDateTime }) => {
      if (op === "gt") {
        return lastModifiedDateTime > time;
      }
      return op === "eq" ? lastModifiedDateTime === time : true;
    })
    .map((message, index) => ({ message, index }))
    .toSorted(
      (a, b) =>
        a.message.lastModifiedDateTime.localeCompare(
          b.message.lastModifiedDateTime
        ) || a.index - b.index
    )
    .map(({ message }) => message);
  const value = listed
    .slice(skip, skip + top)
    .map((each) => only(each, fields));
  const next = new URL(url);
  next.searchParams.set("$skip", String(skip + top));
  const answer = Response.json(
    {
      value,
      ...(skip + top < listed.length ? { "@odata.nextLink": next.href } : {}),
    },
    { headers: { date: mailbox.date } }
  );
  mailbox.listed?.();
  return answer;
};

const notFound = (): Response =>
  Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });

const folderAnswer = (url: URL, name: string): Response => {
  const fields = selected(url, folderProperties);
  if (fields instanceof Response) {
    return fields;
  }
  const id = wellKnown[name] ?? name;
  return Object.hasOwn(parents, id)
    ? Response.json({ id, parentFolderId: parents[id] })
    : notFound();
};

const messageAnswer = (url: URL, rest: string[]): Response => {
  const [id = "", part, attachment, value] = rest;
  const message = mailbox.messages.find((each) => each.id === id);
  if (message === undefined) {
    return notFound();
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

const internet = fakeInternet(async (_request, url) => {
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
  if (path === messagesPath) {
    return listing(url);
  }
  if (path.startsWith("/v1.0/me/mailFolders/")) {
    return folderAnswer(url, path.slice("/v1.0/me/mailFolders/".length));
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
  cursor: string | null
): Promise<SyncPage> =>
  await exports.default.readSyncPage({
    connectionId,
    feed: "mail",
    place: "own",
    cursor,
  });

/** A message in the inbox, last changed at `time`. */
const message = (
  id: string,
  time = "2026-11-10T09:00:00Z",
  fields: Record<string, unknown> = {}
): Message => ({
  id,
  lastModifiedDateTime: time,
  changeKey: `${id}-1`,
  parentFolderId: "inbox",
  isDraft: false,
  hasAttachments: false,
  subject: `About ${id}`,
  body: { contentType: "text", content: `Body of ${id}` },
  from: { emailAddress: { name: "Ann", address: "ann@acme.test" } },
  toRecipients: [{ emailAddress: { address: "me@acme.test" } }],
  sentDateTime: "2026-11-10T08:59:00Z",
  ...fields,
});

/** Reads every page until there is no more, and what they held. */
const readAll = async (
  connectionId: string,
  from: string | null
): Promise<{ items: SyncItem[]; cursor: string | null }> => {
  const items: SyncItem[] = [];
  let cursor = from;
  let page: SyncPage;
  let reads = 0;
  do {
    // oxlint-disable-next-line no-await-in-loop -- pages come one after another
    page = await read(connectionId, cursor);
    items.push(...page.items);
    ({ cursor } = page);
    reads += 1;
  } while (page.more && reads < 40);
  return { items, cursor };
};

const owner = () => [{ kind: "account", id: ownerId }];

describe("syncing a person's own mailbox", () => {
  it("brings in every message and its files, and nothing deleted, junk or a draft", async () => {
    const connectionId = await connected();
    mailbox.messages = [
      message("offer", "2026-11-10T09:00:00Z", { hasAttachments: true }),
      message("filed", "2026-11-10T09:01:00Z", { parentFolderId: "projects" }),
      message("draft", "2026-11-10T09:02:00Z", { isDraft: true }),
      message("binned", "2026-11-10T09:03:00Z", { parentFolderId: "deleted" }),
      // A deleted folder is moved under Deleted Items.
      message("old", "2026-11-10T09:04:00Z", { parentFolderId: "old-project" }),
      message("spam", "2026-11-10T09:05:00Z", { parentFolderId: "junk" }),
      // Not under the mailbox's root: not mail.
      message("system", "2026-11-10T09:06:00Z", { parentFolderId: "hidden" }),
    ];
    mailbox.attachments.offer = [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "pdf",
        name: "Offer.pdf",
        contentType: "application/pdf",
        size: 8,
        isInline: false,
      },
      // A signature's picture, an attached message and a link: left out.
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "logo",
        name: "logo.png",
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

    const page = await read(connectionId, null);
    expect(page.items).toStrictEqual([
      {
        gone: false,
        id: "offer",
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
        id: "offer/pdf",
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
        partOf: "offer",
      },
      expect.objectContaining({ id: "filed", gone: false }),
      { gone: true, id: "binned", kind: "mail" },
      { gone: true, id: "old", kind: "mail" },
      { gone: true, id: "spam", kind: "mail" },
      { gone: true, id: "system", kind: "mail" },
    ]);
    expect(page.more).toBeFalsy();
    // Immutable IDs, and bodies as text.
    expect(
      sentToGraph().every(
        ({ headers }) =>
          headers.prefer?.includes('IdType="ImmutableId"') === true
      )
    ).toBeTruthy();
  });

  it("then brings only what changed, and a message moved to Deleted Items as gone", async () => {
    const connectionId = await connected();
    mailbox.messages = [message("a"), message("b"), message("c")];
    const first = await read(connectionId, null);

    mailbox.messages = [
      message("a"),
      message("b", "2026-11-12T10:00:00Z", { changeKey: "b-2" }),
      message("c", "2026-11-12T10:01:00Z", { parentFolderId: "deleted" }),
    ];
    // "c", the last message handled, changed: its old time's messages are
    // read again, which is harmless, and nothing after it is skipped.
    const changes = await read(connectionId, first.cursor);
    const byId = Object.fromEntries(
      changes.items.map((item) => [item.id, item.gone ? "gone" : item.version])
    );
    expect({ b: byId.b, c: byId.c, more: changes.more }).toStrictEqual({
      b: "b-2",
      c: "gone",
      more: false,
    });

    // Nothing changed since: nothing, from the same place.
    const quiet = await read(connectionId, changes.cursor);
    expect(quiet).toStrictEqual({
      items: [],
      cursor: changes.cursor,
      more: false,
    });
  });

  it("goes on after the last message handled among many changed at one second, past Graph's pages, skipping none", async () => {
    const connectionId = await connected();
    // Three messages fill a page's content; Graph lists five at a time.
    mailbox.graphPage = 5;
    const large = "x".repeat(3 * 1024 * 1024);
    const tied = Array.from({ length: 12 }, (_, index) =>
      message(`m${index}`, "2026-11-10T09:00:00Z", {
        body: { contentType: "text", content: large },
      })
    );
    mailbox.messages = [...tied, message("later", "2026-11-10T09:30:00Z")];
    const { items } = await readAll(connectionId, null);
    const ids = new Set(items.map(({ id }) => id));
    expect([...ids].toSorted()).toStrictEqual(
      [...tied.map(({ id }) => id), "later"].toSorted()
    );
  });

  it("reads the whole tie again when the message it stopped after changed meanwhile", async () => {
    const connectionId = await connected();
    const large = "x".repeat(3 * 1024 * 1024);
    const big = (id: string, time = "2026-11-10T09:00:00Z") =>
      message(id, time, { body: { contentType: "text", content: large } });
    mailbox.messages = [big("a"), big("b"), big("c"), big("d")];
    const first = await read(connectionId, null);
    expect(first.items.map(({ id }) => id)).toStrictEqual(["a", "b"]);

    // "b" changed again, and now sorts first in the tie.
    mailbox.messages = [
      big("b", "2026-11-10T09:05:00Z"),
      big("a"),
      big("c"),
      big("d"),
    ];
    const { items } = await readAll(connectionId, first.cursor);
    expect(items.map(({ id }) => id)).toContain("c");
  });

  it("leaves a message changed at the second Graph answered for the next read", async () => {
    const connectionId = await connected();
    mailbox.messages = [message("old"), message("now", "2026-11-17T10:00:00Z")];
    const first = await read(connectionId, null);
    expect(first.items.map(({ id }) => id)).toStrictEqual(["old"]);

    mailbox.date = "Tue, 17 Nov 2026 10:00:05 GMT";
    const next = await read(connectionId, first.cursor);
    expect(next.items.map(({ id }) => id)).toStrictEqual(["now"]);
  });

  it(
    "leaves a message that is late to the next page, and lets it go when it is first",
    { timeout: 120_000 },
    async () => {
      const connectionId = await connected();
      mailbox.messages = [
        message("a", "2026-11-10T09:00:00Z"),
        message("slow", "2026-11-10T09:01:00Z"),
        message("b", "2026-11-10T09:02:00Z"),
      ];
      // Always past the page's deadline, and past the 30 s connect waits.
      mailbox.slow = { path: `${messagesPath}/slow`, ms: 35_000 };
      const first = await read(connectionId, null);
      const second = await read(connectionId, first.cursor);
      mailbox.slow = undefined;
      const third = await read(connectionId, second.cursor);
      expect({
        first: first.items.map(({ id }) => id),
        second: second.items,
        third: third.items.map(({ id }) => id),
      }).toStrictEqual({
        first: ["a"],
        second: [{ gone: true, id: "slow", kind: "mail" }],
        third: ["b"],
      });
    }
  );

  it(
    "gives up a slow attachment at the page's deadline",
    { timeout: 60_000 },
    async () => {
      const connectionId = await connected();
      mailbox.messages = [
        message("slow", "2026-11-10T09:00:00Z", { hasAttachments: true }),
        message("next", "2026-11-10T09:01:00Z"),
      ];
      mailbox.attachments.slow = [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "f",
          name: "f.pdf",
          size: 4,
        },
      ];
      mailbox.contents = { "slow/f": "%PDF" };
      // Past the page's deadline, and past the 30 s connect waits.
      mailbox.slow = {
        path: `${messagesPath}/slow/attachments/f/$value`,
        ms: 35_000,
      };
      const first = await read(connectionId, null);
      expect(first.items).toMatchObject([
        { id: "slow" },
        { id: "slow/f", content: null },
      ]);
      mailbox.slow = undefined;
      const { items } = await readAll(connectionId, first.cursor);
      expect(items.map(({ id }) => id)).toStrictEqual(["next"]);
    }
  );

  it("never goes on by Graph's position: a message that changes between two listing pages hides none", async () => {
    const connectionId = await connected();
    // Graph lists three at a time.
    mailbox.graphPage = 3;
    mailbox.messages = Array.from({ length: 6 }, (_, index) =>
      message(`x${index + 1}`, `2026-11-10T09:0${index + 1}:00Z`)
    );
    // Once the first page is answered, x1 changes: everything after it
    // moves up one place.
    mailbox.listed = () => {
      mailbox.listed = undefined;
      mailbox.messages = [
        ...mailbox.messages.slice(1),
        message("x1", "2026-11-10T09:09:00Z", { changeKey: "x1-2" }),
      ];
    };
    const { items } = await readAll(connectionId, null);
    expect(new Set(items.map(({ id }) => id))).toStrictEqual(
      new Set(["x1", "x2", "x3", "x4", "x5", "x6"])
    );
  });

  it("goes on inside a second's messages by their IDs, whatever order Graph lists them in", async () => {
    const connectionId = await connected();
    const large = "x".repeat(3 * 1024 * 1024);
    const big = (id: string) =>
      message(id, "2026-11-10T09:00:00Z", {
        body: { contentType: "text", content: large },
      });
    mailbox.messages = [big("a"), big("b"), big("c"), big("d")];
    // Two such messages fill a page.
    const first = await read(connectionId, null);
    // Graph now lists the same second's messages in another order.
    mailbox.messages = [big("c"), big("d"), big("b"), big("a")];
    const { items } = await readAll(connectionId, first.cursor);
    expect({
      first: first.items.map(({ id }) => id),
      rest: items.map(({ id }) => id),
    }).toStrictEqual({ first: ["a", "b"], rest: ["c", "d"] });
  });

  it(
    "leaves a message whose file is late to the next page once the page holds one, file and all",
    { timeout: 120_000 },
    async () => {
      const connectionId = await connected();
      mailbox.messages = [
        message("a", "2026-11-10T09:00:00Z"),
        message("b", "2026-11-10T09:01:00Z", { hasAttachments: true }),
      ];
      mailbox.attachments.b = [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "f",
          name: "f.pdf",
          size: 4,
        },
      ];
      mailbox.contents = { "b/f": "%PDF" };
      mailbox.slow = {
        path: `${messagesPath}/b/attachments/f/$value`,
        ms: 35_000,
      };
      const first = await read(connectionId, null);
      mailbox.slow = undefined;
      const next = await read(connectionId, first.cursor);
      expect({
        first: first.items.map(({ id }) => id),
        next: next.items.map((item) => [
          item.id,
          !item.gone && item.content !== null,
        ]),
      }).toStrictEqual({
        first: ["a"],
        next: [
          ["b", true],
          ["b/f", true],
        ],
      });
    }
  );

  it("starts over on a cursor it didn't write, and waits as long as Graph asks", async () => {
    const connectionId = await connected();
    await expect(
      read(connectionId, "m.bm90LWEtdGltZQ.YQ")
    ).rejects.toMatchObject({ code: "sync.restart" });
    mailbox.answer = () =>
      new Response(null, { status: 429, headers: { "retry-after": "30" } });
    const limited = await read(connectionId, null).catch(
      (error: unknown) => error
    );
    expect(syncErrors.codeOf(limited)).toBe("sync.throttled");
    expect(limited).toMatchObject({ details: { retryAfterMs: 30_000 } });
  });
});
