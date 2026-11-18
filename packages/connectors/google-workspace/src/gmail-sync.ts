import { ToolError } from "@grasp-os/connector-kit/connector";
import {
  fromBase64,
  maxReadBytes,
  toBase64,
} from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import {
  RestartSyncError,
  cursorPart,
  defineSync,
  fetchInRoom,
  fillPage,
  fromCursorPart,
  fromInPagePart,
  inPagePart,
  mayRequest,
  startOfPage,
  syncRoom,
  takeContent,
} from "@grasp-os/connector-kit/sync";
import type {
  EntryItems,
  InPage,
  SyncRoom,
} from "@grasp-os/connector-kit/sync";
import type {
  SyncContent,
  SyncItem,
  SyncPage,
  SyncReader,
} from "@grasp-os/shared/sync";
import { ownPlace } from "@grasp-os/shared/sync";
import { z } from "zod";

import { gmailHost, googleFailure, googleUrl } from "./google.ts";
import {
  addressesOf,
  attachmentsOf,
  headerOf,
  partSchema,
  textOf,
} from "./mime.ts";
import type { Part } from "./mime.ts";

// Native sync of a person's own mailbox (GRA-1758): every message in it,
// then what arrived, what went away and what came back, each with its
// attachments as items of their own (`partOf` the message). A mailbox's
// one reader is its owner; core keeps mail in the owner's own store.
//
// How it reads (Gmail's "Synchronizing clients"): first the mailbox's
// current `historyId`, then the listing of every message, then the history
// from that ID, so nothing that arrived during the listing is missed.
// Drafts are left out: they are unfinished, and each save is a new
// message.
//
// What goes away: a message deleted for good (`messagesDeleted`), and one
// moved to the bin or to spam, comes as `gone`; one taken out of either
// comes back. A message's version is its ID: its content never changes,
// and a label change (read, starred, archived) is no change to what it
// says, so it is left alone. One that comes back from the bin has the
// version it had: core reinstates it. A message's `gone`
// takes its attachments with it: they are `partOf` it.
//
// Where a read stops, and where the next goes on: the kit's paging
// (`fillPage`). An entry's key is the message's ID in the listing, and the
// history record's ID with the message's ID in the history.

const mailbox = "/gmail/v1/users/me";

/** Labels whose messages aren't synced: they went away, or aren't sent yet. */
const awayLabels: ReadonlySet<string> = new Set(["TRASH", "SPAM", "DRAFT"]);

/** Entries asked of Gmail per page of the listing or the history. */
const gmailPageSize = 100;

const profileSchema = z.object({
  emailAddress: z.string().min(1),
  historyId: z.string().min(1),
});

const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).nullish(),
  nextPageToken: z.string().nullish(),
});

const messageRefSchema = z.object({
  message: z.object({ id: z.string() }),
});

const labelChangeSchema = messageRefSchema.extend({
  labelIds: z.array(z.string()).nullish(),
});

const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z.array(messageRefSchema).nullish(),
        messagesDeleted: z.array(messageRefSchema).nullish(),
        labelsAdded: z.array(labelChangeSchema).nullish(),
        labelsRemoved: z.array(labelChangeSchema).nullish(),
      })
    )
    .nullish(),
  nextPageToken: z.string().nullish(),
  historyId: z.string().min(1),
});

const messageSchema = z.object({
  id: z.string(),
  labelIds: z.array(z.string()).nullish(),
  /** Moves with every change of the message, its labels too. */
  historyId: z.string(),
  internalDate: z.string().regex(/^\d+$/u),
  payload: partSchema.nullish(),
});
type Message = z.infer<typeof messageSchema>;

const attachmentSchema = z.object({ data: z.string() });

/** What a read of the mailbox does with one message. */
interface Entry {
  key: string;
  id: string;
  /** Read it as it now is, or take it away. */
  act: "read" | "gone";
}

/**
 * Where a read is: listing the messages, or reading the history from
 * `start`; in Gmail's page `token`, where in it (`at`).
 */
interface Position {
  phase: "list" | "history";
  start: string;
  token: string | null;
  at: InPage;
}

const cursorOf = ({ phase, start, token, at }: Position): string =>
  `${phase === "list" ? "l" : "h"}.${cursorPart(start)}.${cursorPart(token)}.${inPagePart(at)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, ...parts] = cursor.split(".");
  const [start, token] = parts.slice(0, 2).map(fromCursorPart);
  if (
    (phase === "l" || phase === "h") &&
    parts.length === 3 &&
    start !== null &&
    start !== undefined
  ) {
    return {
      phase: phase === "l" ? "list" : "history",
      start,
      token: token ?? null,
      at: fromInPagePart(parts[2]),
    };
  }
  throw new RestartSyncError("Not a cursor this sync wrote");
};

/** One GET, given up at the page's deadline: its JSON, Gmail's 404, or late. */
const getJson = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema> | "not-found" | "late"> => {
  const response = await fetchInRoom(room, url);
  if (response === "late") {
    return "late";
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return "not-found";
  }
  if (!response.ok) {
    throw await googleFailure(response);
  }
  return schema.parse(await response.json());
};

/** A GET for a page of the listing or the history: a gone position starts over. */
const getPage = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  const answer = await getJson(room, url, schema);
  if (answer === "not-found") {
    throw new RestartSyncError();
  }
  if (answer === "late") {
    throw new ToolError("Gmail didn't answer in time", {
      code: "unavailable",
    });
  }
  return answer;
};

/**
 * A part's bytes, inline or behind its attachment ID; null when Gmail no
 * longer has it; "late" when the page has no request or time left for it
 * (the entry has started, so the kit's paging passes it over on an empty
 * page, or stops before it).
 */
const partBytes = async (
  room: SyncRoom,
  message: string,
  part: Part
): Promise<Uint8Array | null | "late"> => {
  const { attachmentId, data } = part.body ?? {};
  if (data !== undefined) {
    return fromBase64(data);
  }
  if (attachmentId === undefined) {
    return null;
  }
  if (!mayRequest(room)) {
    return "late";
  }
  const answer = await getJson(
    room,
    googleUrl(
      gmailHost,
      `${mailbox}/messages/${segment(message)}/attachments/${segment(attachmentId)}`
    ),
    attachmentSchema
  );
  if (answer === "late") {
    return "late";
  }
  return answer === "not-found" ? null : fromBase64(answer.data);
};

/** The headers a message's text starts with, as its people read them. */
const headerLines = (payload: Part | undefined): string =>
  ["From", "To", "Cc", "Date", "Subject"]
    .flatMap((name) => {
      const value = headerOf(payload?.headers, name);
      return value === undefined ? [] : [`${name}: ${value}`];
    })
    .join("\n");

/** Deepest part tree read: Gmail's are a handful of levels at most. */
const maxDepth = 16;

const typeOf = (part: Part): string => (part.mimeType ?? "").toLowerCase();

/** Whether a part, or any under it, is plain text. */
const hasPlain = (part: Part, depth = 0): boolean =>
  typeOf(part) === "text/plain" ||
  (depth < maxDepth &&
    (part.parts ?? []).some((child) => hasPlain(child, depth + 1)));

/**
 * The parts a message's body is, in order, in Gmail's parsed tree (Google
 * parses the MIME): every text part without a file name, and of each
 * `multipart/alternative` one alternative, its plain text when it has one
 * (RFC 2046: the alternatives say the same thing). So a second text part
 * after an inline picture is kept.
 */
const bodyParts = (part: Part | undefined, depth = 0): Part[] => {
  if (part === undefined || depth > maxDepth) {
    return [];
  }
  const type = typeOf(part);
  const children = part.parts ?? [];
  if (type === "multipart/alternative") {
    return bodyParts(
      children.find((child) => hasPlain(child)) ?? children.at(-1),
      depth + 1
    );
  }
  if (type.startsWith("multipart/")) {
    return children.flatMap((child) => bodyParts(child, depth + 1));
  }
  const named = (part.filename ?? "") !== "";
  return !named && (type === "text/plain" || type === "text/html")
    ? [part]
    : [];
};

/** Text as HTML shows it, as written. */
const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A message's content: its header lines, then every body part. All plain:
 * text. Any HTML: an HTML file for core's extractor, the header lines and
 * plain parts in it as preformatted text, so an HTML mail has its From,
 * To, Cc and Date too. Null past what a read takes; "late" when a part's
 * bytes couldn't be fetched in time.
 */
const bodyOf = async (
  room: SyncRoom,
  message: Message
): Promise<SyncContent | null | "late"> => {
  const payload = message.payload ?? undefined;
  const pieces: { html: boolean; text: string }[] = [];
  let size = 0;
  for (const part of bodyParts(payload)) {
    // oxlint-disable-next-line no-await-in-loop -- one part after another, within the page's room
    const bytes = await partBytes(room, message.id, part);
    if (bytes === "late") {
      return "late";
    }
    if (bytes !== null) {
      size += bytes.byteLength;
      pieces.push({
        html: typeOf(part) === "text/html",
        text: textOf(part, bytes),
      });
    }
  }
  if (size > maxReadBytes) {
    return null;
  }
  const headers = headerLines(payload);
  if (!pieces.some(({ html }) => html)) {
    return {
      type: "text",
      text: [headers, ...pieces.map(({ text }) => text)].join("\n\n"),
    };
  }
  const html = [
    `<pre>${escapeHtml(headers)}</pre>`,
    ...pieces.map(({ html: isHtml, text }) =>
      isHtml ? text : `<pre>${escapeHtml(text)}</pre>`
    ),
  ].join("\n");
  return {
    type: "file",
    contentType: "text/html",
    base64: toBase64(new TextEncoder().encode(html)),
  };
};

/** What a message's items share: all but what each one is. */
type Common = Pick<
  Extract<SyncItem, { gone: false }>,
  "gone" | "kind" | "version" | "changedAt" | "readers" | "changedBy"
>;

/**
 * What a message's items share. Its version is its ID: a message's
 * content never changes, while Gmail's `historyId` moves with every label
 * change, read or starred, which would add every read mail again.
 */
const commonOf = (owner: SyncReader[], message: Message): Common => {
  const from = addressesOf(headerOf(message.payload?.headers, "From"))[0]
    ?.address;
  return {
    gone: false,
    kind: "mail",
    version: message.id,
    changedAt: new Date(Number(message.internalDate)).toISOString(),
    readers: owner,
    changedBy: from?.toLowerCase() ?? null,
  };
};

/** A message and its attachments without their content: what is known of it without a request. */
const messageWithoutContent = (
  owner: SyncReader[],
  message: Message
): SyncItem[] => {
  const common = commonOf(owner, message);
  const payload = message.payload ?? undefined;
  return [
    {
      ...common,
      id: message.id,
      title: headerOf(payload?.headers, "Subject") ?? "",
      content: null,
      partOf: null,
    },
    ...attachmentsOf(payload).map((attachment): SyncItem => ({
      ...common,
      id: `${message.id}/${attachment.id}`,
      title: attachment.name,
      content: null,
      partOf: message.id,
    })),
  ];
};

/** A message's attachments, each an item of its own, `partOf` it. */
const attachmentItems = async (
  room: SyncRoom,
  message: Message,
  common: Common
): Promise<SyncItem[] | "full" | "late"> => {
  const items: SyncItem[] = [];
  for (const attachment of attachmentsOf(message.payload ?? undefined)) {
    let content: SyncContent | null = null;
    if (attachment.size <= maxReadBytes) {
      // oxlint-disable-next-line no-await-in-loop -- one attachment after another, within the page's room
      const bytes = await partBytes(room, message.id, attachment.part);
      if (bytes === "late") {
        return "late";
      }
      if (bytes !== null && bytes.byteLength <= maxReadBytes) {
        content = {
          type: "file",
          contentType: attachment.contentType ?? "application/octet-stream",
          base64: toBase64(bytes),
        };
      }
    }
    const kept =
      content === null ? { content: null } : takeContent(room, content);
    if (kept === null) {
      return "full";
    }
    items.push({
      ...common,
      // Gmail's attachment IDs change on every read; a part's ID doesn't.
      id: `${message.id}/${attachment.id}`,
      title: attachment.name,
      content: kept.content,
      partOf: message.id,
    });
  }
  return items;
};

/** A message as it now is: itself and its attachments, or gone. */
const messageItems = async (
  room: SyncRoom,
  owner: SyncReader[],
  message: Message
): Promise<EntryItems> => {
  if ((message.labelIds ?? []).some((label) => awayLabels.has(label))) {
    return [{ gone: true, id: message.id, kind: "mail" }];
  }
  const common = commonOf(owner, message);
  const body = await bodyOf(room, message);
  if (body === "late") {
    return "late";
  }
  const taken = body === null ? { content: null } : takeContent(room, body);
  if (taken === null) {
    return "full";
  }
  const attachments = await attachmentItems(room, message, common);
  if (typeof attachments === "string") {
    return attachments;
  }
  return [
    {
      ...common,
      id: message.id,
      title: headerOf(message.payload?.headers, "Subject") ?? "",
      content: taken.content,
      partOf: null,
    },
    ...attachments,
  ];
};

/** What one read knows of the messages it fetched, by ID, for passing one over. */
type Fetched = Map<string, Message>;

/** What one entry makes: the message as it now is, or gone. */
const entryItems = async (
  room: SyncRoom,
  owner: SyncReader[],
  fetched: Fetched,
  entry: Entry
): Promise<EntryItems> => {
  if (entry.act === "gone") {
    return [{ gone: true, id: entry.id, kind: "mail" }];
  }
  if (!mayRequest(room)) {
    return "full";
  }
  const message = await getJson(
    room,
    googleUrl(gmailHost, `${mailbox}/messages/${segment(entry.id)}`, {
      format: "full",
    }),
    messageSchema
  );
  if (message === "late") {
    return "late";
  }
  // Deleted since it was listed.
  if (message === "not-found") {
    return [{ gone: true, id: entry.id, kind: "mail" }];
  }
  fetched.set(message.id, message);
  return await messageItems(room, owner, message);
};

/**
 * An entry passed over (the kit's paging, on an empty page): gone stays
 * gone; a message fetched comes without its content; one that couldn't
 * even be fetched comes as its ID, with when it was passed over, so it is
 * on record with its content left out.
 */
const passedOver = (
  owner: SyncReader[],
  fetched: Fetched,
  entry: Entry
): SyncItem[] => {
  if (entry.act === "gone") {
    return [{ gone: true, id: entry.id, kind: "mail" }];
  }
  const message = fetched.get(entry.id);
  if (message !== undefined) {
    return messageWithoutContent(owner, message);
  }
  return [
    {
      gone: false,
      id: entry.id,
      kind: "mail",
      version: entry.id,
      changedAt: new Date().toISOString(),
      title: "",
      content: null,
      readers: owner,
      changedBy: null,
      partOf: null,
    },
  ];
};

/** The history's records as entries: what each does to which message. */
const historyEntries = (
  history: z.output<typeof historySchema>["history"]
): Entry[] =>
  (history ?? []).flatMap((record) => [
    ...(record.messagesAdded ?? []).map(({ message }) => ({
      key: `${record.id}.${message.id}`,
      id: message.id,
      act: "read" as const,
    })),
    ...(record.messagesDeleted ?? []).map(({ message }) => ({
      key: `${record.id}.${message.id}`,
      id: message.id,
      act: "gone" as const,
    })),
    // Into the bin or spam, and out of it again; other labels change
    // nothing it says.
    ...(record.labelsAdded ?? []).flatMap(({ message, labelIds }) =>
      (labelIds ?? []).some((label) => awayLabels.has(label))
        ? [
            {
              key: `${record.id}.${message.id}`,
              id: message.id,
              act: "gone" as const,
            },
          ]
        : []
    ),
    ...(record.labelsRemoved ?? []).flatMap(({ message, labelIds }) =>
      (labelIds ?? []).some((label) => awayLabels.has(label))
        ? [
            {
              key: `${record.id}.${message.id}`,
              id: message.id,
              act: "read" as const,
            },
          ]
        : []
    ),
  ]);

/** One page of the listing of every message. */
const listPage = async (
  room: SyncRoom,
  owner: SyncReader[],
  position: Position
): Promise<SyncPage> => {
  const listed = await getPage(
    room,
    googleUrl(
      gmailHost,
      `${mailbox}/messages`,
      { maxResults: String(gmailPageSize), q: "-in:drafts" },
      position.token ?? undefined
    ),
    listSchema
  );
  const entries = (listed.messages ?? []).map(({ id }): Entry => ({
    key: id,
    id,
    act: "read",
  }));
  const fetched: Fetched = new Map();
  const { items, at, done } = await fillPage({
    room,
    entries,
    at: position.at,
    keyOf: ({ key }) => key,
    itemsFor: async (entry) => await entryItems(room, owner, fetched, entry),
    passOver: (entry) => passedOver(owner, fetched, entry),
  });
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, at }),
      more: true,
    };
  }
  const next = listed.nextPageToken ?? "";
  // The listing done, the history from before it is due at once.
  return {
    items,
    cursor: cursorOf(
      next === ""
        ? {
            phase: "history",
            start: position.start,
            token: null,
            at: startOfPage,
          }
        : { ...position, token: next, at: startOfPage }
    ),
    more: true,
  };
};

/** One page of the history. */
const historyPage = async (
  room: SyncRoom,
  owner: SyncReader[],
  position: Position
): Promise<SyncPage> => {
  const read = await getPage(
    room,
    googleUrl(
      gmailHost,
      `${mailbox}/history`,
      { startHistoryId: position.start, maxResults: String(gmailPageSize) },
      position.token ?? undefined
    ),
    historySchema
  );
  const fetched: Fetched = new Map();
  const { items, at, done } = await fillPage({
    room,
    entries: historyEntries(read.history),
    at: position.at,
    keyOf: ({ key }) => key,
    itemsFor: async (entry) => await entryItems(room, owner, fetched, entry),
    passOver: (entry) => passedOver(owner, fetched, entry),
  });
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, at }),
      more: true,
    };
  }
  const next = read.nextPageToken ?? "";
  return next === ""
    ? {
        items,
        cursor: cursorOf({
          phase: "history",
          start: read.historyId,
          token: null,
          at: startOfPage,
        }),
        more: false,
      }
    : {
        items,
        cursor: cursorOf({ ...position, token: next, at: startOfPage }),
        more: true,
      };
};

/** The person's own mailbox: every message, its changes, and what went away. */
export const gmailSync = defineSync({
  name: "gmail",
  kind: "mail",
  routes: [
    { method: "GET", host: gmailHost, path: `${mailbox}/profile` },
    { method: "GET", host: gmailHost, path: `${mailbox}/messages` },
    { method: "GET", host: gmailHost, path: `${mailbox}/messages/{message}` },
    {
      method: "GET",
      host: gmailHost,
      path: `${mailbox}/messages/{message}/attachments/{attachment}`,
    },
    { method: "GET", host: gmailHost, path: `${mailbox}/history` },
  ],
  read: async ({ place, cursor, deadline }) => {
    if (place !== ownPlace) {
      throw new ToolError("This sync reads the person's own mailbox only", {
        code: "failed",
      });
    }
    const room = syncRoom(deadline);
    // Whose mailbox: its one reader, and where its history stands now.
    const profile = await getPage(
      room,
      googleUrl(gmailHost, `${mailbox}/profile`),
      profileSchema
    );
    const owner: SyncReader[] = [
      { kind: "account", id: profile.emailAddress.toLowerCase() },
    ];
    const position: Position =
      cursor === null
        ? {
            phase: "list",
            start: profile.historyId,
            token: null,
            at: startOfPage,
          }
        : positionOf(cursor);
    return position.phase === "list"
      ? await listPage(room, owner, position)
      : await historyPage(room, owner, position);
  },
});
