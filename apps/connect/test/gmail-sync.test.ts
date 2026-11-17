import type { SyncPageRequest } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
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
}

const mail: Mailbox = { listed: [], messages: {}, history: {} };

const internet = fakeInternet((_request, url) => {
  if (url.hostname !== gmailHost) {
    return new Response(null, { status: 404 });
  }
  const path = url.pathname;
  if (path === `${users}/profile`) {
    return Response.json({
      emailAddress: "Owner@Acme.test",
      historyId: "500",
    });
  }
  if (path === `${users}/messages`) {
    return Response.json({ messages: mail.listed.map((id) => ({ id })) });
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
  fields: { historyId?: string; labelIds?: string[]; attached?: boolean } = {}
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
      {
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

/** Someone's own Google account, connected, with an empty mailbox. */
const connected = async (): Promise<string> => {
  mail.listed = [];
  mail.messages = {};
  mail.history = {};
  const person = someone();
  return await connectAccount(providers, person, ownAccount(person, "google"));
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
        version: "400",
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
        version: "400",
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
      expect.objectContaining({ id: "m3", gone: false, version: "501" }),
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
      expect.objectContaining({ id: "m1", gone: false, version: "511" }),
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
