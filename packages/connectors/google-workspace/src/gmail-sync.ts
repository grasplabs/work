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
  mayRequest,
  syncRoom,
  takeContent,
} from "@grasp-os/connector-kit/sync";
import type { SyncRoom } from "@grasp-os/connector-kit/sync";
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
  bodyPartOf,
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
// comes back as a new version (its `historyId`, which moves with every
// change of it, is its version). Other label changes (read, starred) are
// no change to what it says, so they are left alone. A message's `gone`
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
 * `start`; in Gmail's page `token`, after the entry keyed `after`.
 */
interface Position {
  phase: "list" | "history";
  start: string;
  token: string | null;
  after: string | null;
}

const cursorOf = ({ phase, start, token, after }: Position): string =>
  `${phase === "list" ? "l" : "h"}.${cursorPart(start)}.${cursorPart(token)}.${cursorPart(after)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, ...parts] = cursor.split(".");
  const [start, token, after] = parts.map(fromCursorPart);
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
      after: after ?? null,
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

/** A part's bytes, inline or behind its attachment ID: null when there's no room. */
const partBytes = async (
  room: SyncRoom,
  message: string,
  part: Part
): Promise<Uint8Array | null> => {
  const { attachmentId, data } = part.body ?? {};
  if (data !== undefined) {
    return fromBase64(data);
  }
  if (attachmentId === undefined || !mayRequest(room)) {
    return null;
  }
  const answer = await getJson(
    room,
    googleUrl(
      gmailHost,
      `${mailbox}/messages/${segment(message)}/attachments/${segment(attachmentId)}`
    ),
    attachmentSchema
  );
  return typeof answer === "string" ? null : fromBase64(answer.data);
};

/** The headers a message's text starts with, as its people read them. */
const headerLines = (payload: Part | undefined): string =>
  ["From", "To", "Cc", "Date", "Subject"]
    .flatMap((name) => {
      const value = headerOf(payload?.headers, name);
      return value === undefined ? [] : [`${name}: ${value}`];
    })
    .join("\n");

/**
 * A message's content: its headers and text body, or its HTML body as a
 * file; "full" when fetching the body has no room left on a page that
 * holds something already.
 */
const bodyOf = async (
  room: SyncRoom,
  message: Message
): Promise<SyncContent | null | "full"> => {
  const payload = message.payload ?? undefined;
  const found = bodyPartOf(payload, "text");
  const bytes =
    found === null
      ? new Uint8Array()
      : await partBytes(room, message.id, found.part);
  if (bytes === null) {
    return room.empty ? null : "full";
  }
  if (bytes.byteLength > maxReadBytes) {
    return null;
  }
  if (found?.contentType === "html") {
    return { type: "file", contentType: "text/html", base64: toBase64(bytes) };
  }
  const text = found === null ? "" : textOf(found.part, bytes);
  return { type: "text", text: `${headerLines(payload)}\n\n${text}` };
};

/** What a message's items share: all but what each one is. */
type Common = Pick<
  Extract<SyncItem, { gone: false }>,
  "gone" | "kind" | "version" | "changedAt" | "readers" | "changedBy"
>;

/** A message's attachments, each an item of its own, `partOf` it. */
const attachmentItems = async (
  room: SyncRoom,
  message: Message,
  common: Common
): Promise<SyncItem[] | "full"> => {
  const items: SyncItem[] = [];
  for (const attachment of attachmentsOf(message.payload ?? undefined)) {
    let content: SyncContent | null = null;
    if (attachment.size <= maxReadBytes) {
      // oxlint-disable-next-line no-await-in-loop -- one attachment after another, within the page's room
      const bytes = await partBytes(room, message.id, attachment.part);
      // No request or time left: the next read takes the whole message,
      // unless the page holds nothing yet.
      if (bytes === null && !room.empty) {
        return "full";
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
): Promise<SyncItem[] | "full"> => {
  if ((message.labelIds ?? []).some((label) => awayLabels.has(label))) {
    return [{ gone: true, id: message.id, kind: "mail" }];
  }
  const payload = message.payload ?? undefined;
  const changedAt = new Date(Number(message.internalDate)).toISOString();
  const from = addressesOf(headerOf(payload?.headers, "From"))[0]?.address;
  const common: Common = {
    gone: false,
    kind: "mail",
    version: message.historyId,
    changedAt,
    readers: owner,
    changedBy: from?.toLowerCase() ?? null,
  };
  const body = await bodyOf(room, message);
  if (body === "full") {
    return "full";
  }
  const taken = body === null ? { content: null } : takeContent(room, body);
  if (taken === null) {
    return "full";
  }
  const items: SyncItem[] = [
    {
      ...common,
      id: message.id,
      title: headerOf(payload?.headers, "Subject") ?? "",
      content: taken.content,
      partOf: null,
    },
  ];
  const attachments = await attachmentItems(room, message, common);
  return attachments === "full" ? "full" : [...items, ...attachments];
};

/** What one entry makes: the message as it now is, or gone. */
const entryItems = async (
  room: SyncRoom,
  owner: SyncReader[],
  entry: Entry
): Promise<SyncItem[] | "full"> => {
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
    return "full";
  }
  // Deleted since it was listed.
  if (message === "not-found") {
    return [{ gone: true, id: entry.id, kind: "mail" }];
  }
  return await messageItems(room, owner, message);
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
  const { items, last, done } = await fillPage(
    room,
    entries,
    position.after,
    ({ key }) => key,
    async (entry) => await entryItems(room, owner, entry)
  );
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, after: last }),
      more: true,
    };
  }
  const next = listed.nextPageToken ?? "";
  // The listing done, the history from before it is due at once.
  return {
    items,
    cursor: cursorOf(
      next === ""
        ? { phase: "history", start: position.start, token: null, after: null }
        : { ...position, token: next, after: null }
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
  const { items, last, done } = await fillPage(
    room,
    historyEntries(read.history),
    position.after,
    ({ key }) => key,
    async (entry) => await entryItems(room, owner, entry)
  );
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, after: last }),
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
          after: null,
        }),
        more: false,
      }
    : {
        items,
        cursor: cursorOf({ ...position, token: next, after: null }),
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
        ? { phase: "list", start: profile.historyId, token: null, after: null }
        : positionOf(cursor);
    return position.phase === "list"
      ? await listPage(room, owner, position)
      : await historyPage(room, owner, position);
  },
});
