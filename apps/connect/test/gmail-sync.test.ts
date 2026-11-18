import type { SyncPageRequest } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { scopeRefusal, syncGrant } from "./google-scopes.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Google Workspace connector's Gmail sync (gmail-sync.ts), through
// connect's real read (src/sync.ts): a fresh isolate, the egress that adds
// the token, and Gmail mocked at its host. The ways it can fail come
// first: a message that arrived during the first listing missed; one
// deleted for good, binned or marked as spam still answering; one taken
// out of the bin never coming back; a draft synced; a label change taken
// for a change of what it says; a gone history ID taken for a failure.

const providers = fakeProviders();

const gmailHost = "gmail.googleapis.com";
const users = "/gmail/v1/users/me";

/** Base64url, as Gmail sends a part's data. */
const base64url = (text: string): string =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** What the mailbox holds, for each test to set. */
interface Mailbox {
  /** Every message's ID, as the listing gives them. */
  listed: string[];
  /** Each message as Gmail answers it, by ID. */
  messages: Record<string, Record<string, unknown>>;
  /** The history, by start history ID. */
  history: Record<string, Record<string, unknown>>;
  /** Messages a listing page holds, at most: fewer than Gmail's, to page. */
  pageSize: number;
  /** A path whose answer starts at once but whose bytes stall, and for how long. */
  slow?: { path: string; ms: number };
}

const mail: Mailbox = { listed: [], messages: {}, history: {}, pageSize: 100 };

/** An answer whose headers come at once and whose bytes stall for `ms`. */
const stalled = (ms: number): Response =>
  new Response(
    new ReadableStream({
      start: async (controller) => {
        controller.enqueue(new TextEncoder().encode("{"));
        await scheduler.wait(ms);
        controller.close();
      },
    })
  );

const internet = fakeInternet((request, url) => {
  if (url.hostname !== gmailHost) {
    return new Response(null, { status: 404 });
  }
  const refused = scopeRefusal(providers, request, url);
  if (refused !== undefined) {
    return refused;
  }
  if (mail.slow?.path === url.pathname) {
    return stalled(mail.slow.ms);
  }
  const path = url.pathname;
  if (path === `${users}/profile`) {
    return Response.json({
      emailAddress: "Owner@Acme.test",
      historyId: "500",
    });
  }
  if (path === `${users}/messages`) {
    const from = Number(url.searchParams.get("pageToken") ?? 0);
    const next = from + mail.pageSize;
    return Response.json({
      messages: mail.listed.slice(from, next).map((id) => ({ id })),
      ...(next < mail.listed.length ? { nextPageToken: String(next) } : {}),
    });
  }
  if (path === `${users}/history`) {
    const page = mail.history[url.searchParams.get("startHistoryId") ?? ""];
    return page === undefined
      ? Response.json({ error: { code: 404 } }, { status: 404 })
      : Response.json(page);
  }
  const [id, , attachment] = path.slice(`${users}/messages/`.length).split("/");
  if (attachment !== undefined) {
    return Response.json({ data: base64url("%PDF-1.7") });
  }
  const message = mail.messages[id ?? ""];
  return message === undefined
    ? Response.json({ error: { code: 404 } }, { status: 404 })
    : Response.json(message);
});

/** A message as Gmail answers it in full, with a PDF attached if asked. */
const message = (
  id: string,
  fields: {
    historyId?: string;
    labelIds?: string[];
    attached?: boolean;
    /** The body's parts instead of one plain-text part. */
    body?: Record<string, unknown>;
  } = {}
): Record<string, unknown> => ({
  id,
  historyId: fields.historyId ?? "400",
  labelIds: fields.labelIds ?? ["INBOX"],
  internalDate: String(Date.parse("2026-11-10T09:00:00.000Z")),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Supplier <Sales@Supplier.test>" },
      { name: "To", value: "owner@acme.test" },
      { name: "Subject", value: `Quote ${id}` },
    ],
    parts: [
      fields.body ?? {
        partId: "0",
        mimeType: "text/plain",
        body: { data: base64url(`Coffee 3.20 (${id})`), size: 18 },
      },
      ...(fields.attached === true
        ? [
            {
              partId: "1",
              mimeType: "application/pdf",
              filename: "quote.pdf",
              headers: [{ name: "Content-Disposition", value: "attachment" }],
              body: { attachmentId: "attachment-1", size: 8 },
            },
          ]
        : []),
    ],
  },
});

/** Someone's own Google account, connected with what the sync holds, with an empty mailbox. */
const connected = async (): Promise<string> => {
  mail.listed = [];
  mail.messages = {};
  mail.history = {};
  mail.pageSize = 100;
  mail.slow = undefined;
  const person = someone();
  return await connectAccount(providers, person, {
    ...ownAccount(person, "google"),
    granted: syncGrant,
  });
};

const request = (
  connectionId: string,
  cursor: string | null
): SyncPageRequest => ({ connectionId, feed: "gmail", place: "own", cursor });

const read = async (connectionId: string, cursor: string | null) =>
  await exports.default.readSyncPage(request(connectionId, cursor));

const owner = [{ kind: "account", id: "owner@acme.test" }];

describe("syncing a person's own mailbox", () => {
  it("brings in every message, each attachment an item of its own, from where the history stands", async () => {
    const connectionId = await connected();
    mail.listed = ["m1"];
    mail.messages = { m1: message("m1", { attached: true }) };

    const first = await read(connectionId, null);
    expect(first.items).toStrictEqual([
      {
        gone: false,
        id: "m1",
        kind: "mail",
        version: "m1",
        changedAt: "2026-11-10T09:00:00.000Z",
        title: "Quote m1",
        content: {
          type: "text",
          text: "From: Supplier <Sales@Supplier.test>\nTo: owner@acme.test\nSubject: Quote m1\n\nCoffee 3.20 (m1)",
        },
        readers: owner,
        changedBy: "sales@supplier.test",
        partOf: null,
      },
      {
        gone: false,
        id: "m1/1",
        kind: "mail",
        version: "m1",
        changedAt: "2026-11-10T09:00:00.000Z",
        title: "quote.pdf",
        content: {
          type: "file",
          contentType: "application/pdf",
          base64: btoa("%PDF-1.7"),
        },
        readers: owner,
        changedBy: "sales@supplier.test",
        partOf: "m1",
      },
    ]);
    expect(first.more).toBeTruthy();

    // Drafts are left out; the history's start was taken before the
    // listing, so nothing that arrived meanwhile is missed.
    const [profile, list] = internet.sent.filter(
      ({ host }) => host === gmailHost
    );
    expect(profile?.path).toBe(`${users}/profile`);
    expect(
      new URL(`https://${gmailHost}${list?.path ?? ""}`).searchParams.get("q")
    ).toBe("-in:drafts");
  });

  it("then brings what arrived, and takes away what was deleted, binned, spam or a draft", async () => {
    const connectionId = await connected();
    mail.listed = ["m1", "m2", "m5"];
    mail.messages = {
      m1: message("m1"),
      m2: message("m2"),
      m5: message("m5"),
      m3: message("m3", { historyId: "501" }),
      m4: message("m4", { historyId: "502", labelIds: ["DRAFT"] }),
    };
    const listed = await read(connectionId, null);
    mail.history = {
      500: {
        historyId: "507",
        history: [
          { id: "501", messagesAdded: [{ message: { id: "m3" } }] },
          { id: "502", messagesAdded: [{ message: { id: "m4" } }] },
          { id: "503", messagesDeleted: [{ message: { id: "m2" } }] },
          {
            id: "504",
            labelsAdded: [{ message: { id: "m1" }, labelIds: ["TRASH"] }],
          },
          {
            id: "505",
            labelsAdded: [{ message: { id: "m5" }, labelIds: ["SPAM"] }],
          },
          // Read, starred: no change to what it says.
          {
            id: "506",
            labelsAdded: [{ message: { id: "m3" }, labelIds: ["STARRED"] }],
          },
        ],
      },
    };
    const changes = await read(connectionId, listed.cursor);
    expect(changes.items).toStrictEqual([
      expect.objectContaining({ id: "m3", gone: false, version: "m3" }),
      { gone: true, id: "m4", kind: "mail" },
      { gone: true, id: "m2", kind: "mail" },
      { gone: true, id: "m1", kind: "mail" },
      { gone: true, id: "m5", kind: "mail" },
    ]);
    expect(changes.more).toBeFalsy();
  });

  it("brings a message back when it is taken out of the bin", async () => {
    const connectionId = await connected();
    mail.history = {
      500: { historyId: "510", history: [] },
      510: {
        historyId: "511",
        history: [
          {
            id: "511",
            labelsRemoved: [{ message: { id: "m1" }, labelIds: ["TRASH"] }],
          },
        ],
      },
    };
    mail.messages = { m1: message("m1", { historyId: "511" }) };
    const listed = await read(connectionId, null);
    const quiet = await read(connectionId, listed.cursor);
    expect(quiet.items).toStrictEqual([]);

    const back = await read(connectionId, quiet.cursor);
    expect(back.items).toStrictEqual([
      expect.objectContaining({ id: "m1", gone: false, version: "m1" }),
    ]);
  });

  it("keeps a mail's version when it is read or starred", async () => {
    const connectionId = await connected();
    mail.listed = ["m1"];
    mail.messages = { m1: message("m1", { historyId: "400" }) };
    const before = await read(connectionId, null);
    // Read and starred: Gmail's history ID moved, what it says didn't.
    mail.messages = {
      m1: message("m1", { historyId: "900", labelIds: ["INBOX", "STARRED"] }),
    };
    const after = await read(connectionId, null);
    expect(after.items).toStrictEqual(before.items);
  });

  it("keeps every part of a mail's text, one of each alternative, and an HTML mail's header lines", async () => {
    const connectionId = await connected();
    const plain = (text: string) => ({
      mimeType: "text/plain",
      body: { data: base64url(text), size: text.length },
    });
    mail.listed = ["apple", "alternative", "html"];
    mail.messages = {
      // Apple Mail: text, an inline picture, more text.
      apple: message("apple", {
        body: {
          mimeType: "multipart/mixed",
          parts: [
            plain("Hello"),
            {
              mimeType: "image/png",
              filename: "logo.png",
              headers: [{ name: "Content-Disposition", value: "inline" }],
              body: { data: base64url("png"), size: 3 },
            },
            plain("Regards"),
          ],
        },
      }),
      alternative: message("alternative", {
        body: {
          mimeType: "multipart/alternative",
          parts: [
            plain("Plain words"),
            {
              mimeType: "text/html",
              body: { data: base64url("<p>Rich words</p>"), size: 17 },
            },
          ],
        },
      }),
      html: message("html", {
        body: {
          mimeType: "text/html",
          body: { data: base64url("<p>Hi</p>"), size: 9 },
        },
      }),
    };
    const { items } = await read(connectionId, null);
    const contentOf = (id: string) =>
      items.find((item) => item.id === id && !item.gone);
    const headers =
      "From: Supplier <Sales@Supplier.test>\nTo: owner@acme.test\nSubject: Quote";
    expect(contentOf("apple")).toMatchObject({
      content: { type: "text", text: `${headers} apple\n\nHello\n\nRegards` },
    });
    expect(contentOf("alternative")).toMatchObject({
      content: { type: "text", text: `${headers} alternative\n\nPlain words` },
    });
    expect(contentOf("html")).toMatchObject({
      content: {
        type: "file",
        contentType: "text/html",
        base64: btoa(
          "<pre>From: Supplier &lt;Sales@Supplier.test&gt;\nTo: owner@acme.test\nSubject: Quote html</pre>\n<p>Hi</p>"
        ),
      },
    });
  });

  it("follows the listing from page to page", async () => {
    const connectionId = await connected();
    mail.pageSize = 2;
    mail.listed = ["m1", "m2", "m3"];
    mail.messages = {
      m1: message("m1"),
      m2: message("m2"),
      m3: message("m3"),
    };
    mail.history = { 500: { historyId: "500", history: [] } };
    const seen: string[] = [];
    let page = await read(connectionId, null);
    seen.push(...page.items.map(({ id }) => id));
    while (page.more && seen.length < 10) {
      // oxlint-disable-next-line no-await-in-loop -- pages come one after another
      page = await read(connectionId, page.cursor);
      seen.push(...page.items.map(({ id }) => id));
    }
    expect(seen).toStrictEqual(["m1", "m2", "m3"]);
  });

  it("passes over a message that is always too slow, so the mailbox moves on", async () => {
    const connectionId = await connected();
    mail.listed = ["slow", "next"];
    mail.messages = { slow: message("slow"), next: message("next") };
    // Slow on every read, and first in its page.
    mail.slow = { path: `${users}/messages/slow`, ms: 20_000 };
    const first = await read(connectionId, null);
    expect(first.items).toStrictEqual([
      expect.objectContaining({
        id: "slow",
        gone: false,
        version: "slow",
        content: null,
      }),
    ]);
    const second = await read(connectionId, first.cursor);
    expect(second.items.map(({ id }) => id)).toStrictEqual(["next"]);
  });

  it("stops a page before a message whose attachment can't be fetched in time, and takes it whole next", async () => {
    const connectionId = await connected();
    mail.listed = ["m1", "m2"];
    mail.messages = {
      m1: message("m1"),
      m2: message("m2", { attached: true }),
    };
    mail.slow = {
      path: `${users}/messages/m2/attachments/attachment-1`,
      ms: 20_000,
    };
    const first = await read(connectionId, null);
    expect(first.items.map(({ id }) => id)).toStrictEqual(["m1"]);

    mail.slow = undefined;
    const second = await read(connectionId, first.cursor);
    expect(
      second.items.map((item) => [item.id, !item.gone && item.content !== null])
    ).toStrictEqual([
      ["m2", true],
      ["m2/1", true],
    ]);
  });

  it("lists again when Gmail no longer has the history", async () => {
    const connectionId = await connected();
    const listed = await read(connectionId, null);
    await expect(read(connectionId, listed.cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
  });
});
