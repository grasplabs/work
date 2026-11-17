import { ToolError } from "@grasp-os/connector-kit/connector";
import { maxReadBytes, toBase64 } from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import {
  RestartSyncError,
  defineSync,
  syncPageLimits,
} from "@grasp-os/connector-kit/sync";
import type {
  SyncContent,
  SyncItem,
  SyncPage,
  SyncReader,
} from "@grasp-os/shared/sync";
import { ownPlace } from "@grasp-os/shared/sync";
import { z } from "zod";

import { graphFailure, graphHost, graphUrl, v1 } from "./graph.ts";

// Native sync of a person's own Outlook mailbox (GRA-1759, PR G): every
// message in it, then what changed and what went away, each attachment an
// item of its own linked to its message (`partOf`). Mail is readable only
// by the mailbox's own person, so each message's only reader is them, and
// it lives in their own store.
//
// How it reads (the orchestrator's decision, recorded on GRA-1759): one
// place and one cursor for the whole mailbox. Graph's change feed for mail
// is per folder only (message delta), and one cursor can't hold a token
// for every folder; so the sync lists `/me/messages`, which holds "the
// messages in the signed-in user's mailbox (including the Deleted Items
// and Clutter folders)", ordered by `lastModifiedDateTime`, from the last
// message it handled on
// (https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).
// The first listing and every change after it are the same read: the
// first has no lower bound. Messages are asked for by their immutable IDs
// (`Prefer: IdType="ImmutableId"`): a message's usual ID "changes when the
// item is moved from one container … to another"
// (https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).
//
// Resuming, by key, never by position: the cursor is the last handled
// message's `lastModifiedDateTime` and its ID. A read lists from that time
// on (`ge`) and goes on after that ID. Ties on the time are handled so
// nothing is skipped:
// - Only messages last changed before the second Graph answered the
//   listing in (its `Date` header) are taken: a later change at the same
//   second as the last one handled can't come after the read went past.
// - A tie group longer than a listing page is followed through Graph's own
//   next links, as Microsoft asks ("apply the entire URL returned in
//   `@odata.nextLink`"), until the handled ID is found.
// - When that ID isn't found among the messages of its time (it changed
//   again, or went), every message of that time is read again. Reading one
//   twice is harmless.
//
// What goes away, at once: a message in Deleted Items or Junk Email, or in
// a folder under either (a deleted folder is moved under Deleted Items),
// found by walking a message's folder up to the mailbox's root. A message
// outside the root, or whose folder Graph no longer has, can't be
// confirmed as mail and goes away too. The sync run removes a message's
// attachments with it.
//
// What is left out: drafts (`isDraft`, not sent yet); inline attachments
// (pictures in the body, such as signatures); attachments that are an
// Outlook item (an attached message, event or contact) or a link to a
// cloud file; a file attachment larger than a read takes (`maxReadBytes`)
// comes without its content.
//
// THE BOUND: a HARD delete (a message deleted for good, or Deleted Items
// emptied) never shows in `/me/messages`: the message just isn't there.
// It goes at the sync run's daily full relisting (PR I), so a hard-deleted
// message can stay for at most a day. That is the orchestrator's decision:
// a mail item is readable only by the mailbox's own person, so nobody
// else is affected.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft):
// - That moving a message (to Deleted Items, Junk Email or any folder)
//   moves its `lastModifiedDateTime`. Microsoft documents a move as making
//   "a new copy of the message in the destination folder", which suggests
//   so; if not, a move to Deleted Items goes at the daily relisting.
// - That messages tied on `lastModifiedDateTime` keep one order between
//   reads. If not, the handled ID not found reads the whole tie again.
// - That `lastModifiedDateTime` is set no later than the `Date` of the
//   first answer that lists the message.

const me = "/me";
const messages = `${me}/messages`;
const folders = `${me}/mailFolders`;

/**
 * Messages asked of Graph per listing page: the most `$top` takes ("within
 * the range of 1 and 1000", user-list-messages). Only IDs and what decides
 * how a message is read are listed; each message is read on its own.
 */
const listingSize = 1000;

/** Well-known folders: their messages are not mail any more. */
const goneFolders = ["deleteditems", "junkemail"] as const;

/** The mailbox's root: every folder of mail is under it. */
const rootFolder = "msgfolderroot";

/** Immutable IDs, and bodies as text (user-list-messages, message-get). */
const prefer = 'IdType="ImmutableId", outlook.body-content-type="text"';

/**
 * A time as Graph writes it, and as the cursor carries it into a
 * `$filter`: ISO 8601 in UTC, nothing else.
 */
const timeSchema = z.iso.datetime();

const listedSchema = z.object({
  id: z.string().min(1),
  lastModifiedDateTime: timeSchema,
  changeKey: z.string().min(1).nullish(),
  parentFolderId: z.string().min(1).nullish(),
  isDraft: z.boolean().nullish(),
  hasAttachments: z.boolean().nullish(),
});
type Listed = z.infer<typeof listedSchema>;

const listedFields =
  "id,lastModifiedDateTime,changeKey,parentFolderId,isDraft,hasAttachments";

const listingSchema = z.object({
  value: z.array(listedSchema),
  "@odata.nextLink": z.string().optional(),
});

const addressSchema = z
  .object({
    emailAddress: z
      .object({
        name: z.string().nullish(),
        address: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

const messageSchema = z.object({
  subject: z.string().nullish(),
  body: z.object({ content: z.string().nullish() }).nullish(),
  from: addressSchema,
  toRecipients: z.array(addressSchema).nullish(),
  ccRecipients: z.array(addressSchema).nullish(),
  sentDateTime: z.string().nullish(),
});
type Message = z.infer<typeof messageSchema>;

const messageFields =
  "subject,body,from,toRecipients,ccRecipients,sentDateTime";

/** An attachment, as listed: no content (`contentBytes` isn't selected). */
const attachmentSchema = z.object({
  "@odata.type": z.string().nullish(),
  id: z.string().min(1),
  name: z.string().nullish(),
  contentType: z.string().nullish(),
  size: z.number().int().nonnegative().nullish(),
  isInline: z.boolean().nullish(),
});
type Attachment = z.infer<typeof attachmentSchema>;

const attachmentsSchema = z.object({
  value: z.array(attachmentSchema),
  "@odata.nextLink": z.string().optional(),
});

const folderSchema = z.object({
  id: z.string().min(1),
  parentFolderId: z.string().min(1).nullish(),
});

const meSchema = z.object({ id: z.string().min(1) });

/** The content type of a file Graph names none for. */
const unknownType = "application/octet-stream";

/**
 * Where a read is: the last handled message's time and ID (none: from the
 * start).
 */
interface Position {
  since: string | null;
  after: string | null;
}

const base64url = /^[\w-]*$/u;

const notOurs = (): RestartSyncError =>
  new RestartSyncError("Not a cursor this sync wrote");

const encode = (value: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decode = (value: string): string => {
  if (!base64url.test(value)) {
    throw notOurs();
  }
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0)
    );
  } catch {
    throw notOurs();
  }
};

/** The cursor of a position: `m.<since>.<after>`. */
const cursorOf = ({ since, after }: Position): string =>
  `m.${encode(since ?? "")}.${encode(after ?? "")}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [tag, since, after, ...rest] = cursor.split(".");
  if (tag !== "m" || since === undefined || after === undefined) {
    throw notOurs();
  }
  if (rest.length > 0) {
    throw notOurs();
  }
  const time = decode(since);
  const id = decode(after);
  if (time !== "" && !timeSchema.safeParse(time).success) {
    throw notOurs();
  }
  return { since: time === "" ? null : time, after: id === "" ? null : id };
};

/**
 * What a page has left: requests, content bytes, and when it stops taking
 * more (`deadline`, from the connector kit's `syncPageLimits.millis`).
 */
interface Room {
  requests: number;
  bytes: number;
  deadline: number;
  /**
   * Whether the message being read is the page's first: it is taken
   * whatever is left, its files without their content if need be, so
   * every read moves on.
   */
  first: boolean;
}

/** No room left for a message: the page stops before it. */
class FullError extends Error {
  constructor() {
    super("No room left in the page");
    this.name = "FullError";
  }
}

/** A GET to Graph, within the page's requests. */
const get = async (room: Room, url: URL): Promise<Response> => {
  if (room.requests <= 0) {
    throw new FullError();
  }
  room.requests -= 1;
  return await fetch(url, { headers: { prefer } });
};

/** Graph's JSON answer to a GET that must succeed. */
const getJson = async <Schema extends z.ZodType>(
  room: Room,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  const response = await get(room, url);
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return schema.parse(await response.json());
};

/** Whether Graph refused an item (403) or no longer has it (404). */
const isUnreadable = (response: Response): boolean =>
  response.status === 403 || response.status === 404;

/**
 * A next link Graph handed back, followed only on its own host and the
 * same path, as Microsoft asks: its `$skip` is Graph's own to read.
 */
const nextUrl = (link: string, path: string): URL => {
  const url = new URL(link);
  if (url.hostname !== graphHost || url.pathname !== `${v1}${path}`) {
    throw new ToolError("Graph's next link leads elsewhere", {
      code: "failed",
    });
  }
  return url;
};

/** Graph's own second of an answer (its `Date` header), in ms. */
const secondOf = (response: Response): number => {
  const time = Date.parse(response.headers.get("date") ?? "");
  if (Number.isNaN(time)) {
    throw new ToolError("Graph's answer has no Date", { code: "failed" });
  }
  return time;
};

/** One page of the listing, and Graph's second of it. */
const listingPage = async (room: Room, url: URL) => {
  const response = await get(room, url);
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return {
    settled: secondOf(response),
    page: listingSchema.parse(await response.json()),
  };
};

/**
 * The listing from `since` on, oldest change first, without a lower bound
 * at the start. `$filter` and `$orderby` name the same property, as Graph
 * requires (user-list-messages, "Using filter and orderby in the same
 * query").
 */
const listingUrl = (since: string | null): URL =>
  graphUrl(messages, {
    $filter: since === null ? undefined : `lastModifiedDateTime ge ${since}`,
    $orderby: "lastModifiedDateTime",
    $select: listedFields,
    $top: String(listingSize),
  });

/** Whether a folder's messages are mail, as far as the page found out. */
type Standing = "mail" | "gone";

/**
 * Whether a folder holds mail: under the mailbox's root and not under
 * Deleted Items or Junk Email, walked up one folder at a time and kept for
 * the page. A folder Graph no longer has, or outside the root, is gone.
 * https://learn.microsoft.com/en-us/graph/api/mailfolder-get?view=graph-rest-1.0
 */
const standingOf = async (
  room: Room,
  known: Map<string, Standing>,
  folder: string
): Promise<Standing> => {
  const walked: string[] = [];
  let at: string | null = folder;
  let standing: Standing | undefined;
  while (standing === undefined) {
    if (at === null || walked.includes(at)) {
      standing = "gone";
      break;
    }
    standing = known.get(at);
    if (standing !== undefined) {
      break;
    }
    walked.push(at);
    // oxlint-disable-next-line no-await-in-loop -- one folder up at a time
    const response: Response = await get(
      room,
      graphUrl(`${folders}/${segment(at)}`, { $select: "id,parentFolderId" })
    );
    if (isUnreadable(response)) {
      // oxlint-disable-next-line no-await-in-loop -- the walk ends here
      await response.body?.cancel();
      standing = "gone";
      break;
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the walk ends here
      throw await graphFailure(response);
    }
    // oxlint-disable-next-line no-await-in-loop -- the walk goes on from it
    const read = folderSchema.parse(await response.json());
    at = read.parentFolderId ?? null;
  }
  for (const id of walked) {
    known.set(id, standing);
  }
  return standing;
};

/** The well-known folders' standing: the root is mail, the others not. */
const knownFolders = async (room: Room): Promise<Map<string, Standing>> => {
  const known = new Map<string, Standing>();
  for (const name of [rootFolder, ...goneFolders]) {
    // oxlint-disable-next-line no-await-in-loop -- three small reads
    const { id } = await getJson(
      room,
      graphUrl(`${folders}/${name}`, { $select: "id" }),
      folderSchema
    );
    known.set(id, name === rootFolder ? "mail" : "gone");
  }
  return known;
};

/** A recipient, as a mail's header line writes it. */
const addressOf = (recipient: z.infer<typeof addressSchema>): string => {
  const name = recipient?.emailAddress?.name ?? "";
  const address = recipient?.emailAddress?.address ?? "";
  if (name === "" || name === address) {
    return address;
  }
  return address === "" ? name : `${name} <${address}>`;
};

/** A message's text: its header lines, then its body as text. */
const textOf = (message: Message): string => {
  const lines = [
    ["From", addressOf(message.from)],
    ["To", (message.toRecipients ?? []).map(addressOf).join(", ")],
    ["Cc", (message.ccRecipients ?? []).map(addressOf).join(", ")],
    ["Date", message.sentDateTime ?? ""],
    ["Subject", message.subject ?? ""],
  ]
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value}`);
  return `${lines.join("\n")}\n\n${message.body?.content ?? ""}`;
};

/** JSON bytes of `content` in a page. */
const sizeOf = (content: SyncContent): number =>
  new TextEncoder().encode(JSON.stringify(content)).byteLength;

/** Whether the page has taken no content yet. */
const isEmpty = (room: Room): boolean =>
  room.bytes === syncPageLimits.contentBytes;

/** Takes `content` into the page, if it fits: it always fits an empty one. */
const take = (room: Room, content: SyncContent): SyncContent | null => {
  const size = sizeOf(content);
  if (size > room.bytes) {
    if (isEmpty(room) || room.first) {
      return null;
    }
    throw new FullError();
  }
  room.bytes -= size;
  return content;
};

/** Whether an attachment is a file to sync: a file, not inline. */
const isFile = (attachment: Attachment): boolean =>
  attachment["@odata.type"] === "#microsoft.graph.fileAttachment" &&
  attachment.isInline !== true;

/** A message's attachments, as listed, through Graph's next links. */
const attachmentsOf = async (room: Room, id: string): Promise<Attachment[]> => {
  const path = `${messages}/${segment(id)}/attachments`;
  const listed: Attachment[] = [];
  let url: URL | null = graphUrl(path, {
    $select: "id,name,contentType,size,isInline",
  });
  while (url !== null) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page: z.infer<typeof attachmentsSchema> = await getJson(
      room,
      url,
      attachmentsSchema
    );
    listed.push(...page.value);
    const next: string | undefined = page["@odata.nextLink"];
    url = next === undefined ? null : nextUrl(next, path);
  }
  return listed;
};

/**
 * An attachment's bytes, given up at the page's deadline: a slow file
 * never holds a page past it. Null: too large to read, or late.
 * https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0
 */
const bytesOf = async (
  room: Room,
  message: string,
  attachment: Attachment
): Promise<Uint8Array | null> => {
  if ((attachment.size ?? 0) > maxReadBytes || Date.now() >= room.deadline) {
    return null;
  }
  if (room.requests <= 0) {
    if (room.first) {
      return null;
    }
    throw new FullError();
  }
  room.requests -= 1;
  let response: Response;
  try {
    response = await fetch(
      graphUrl(
        `${messages}/${segment(message)}/attachments/${segment(attachment.id)}/$value`
      ),
      {
        headers: { prefer },
        signal: AbortSignal.timeout(Math.max(room.deadline - Date.now(), 0)),
      }
    );
    if (!response.ok) {
      if (isUnreadable(response)) {
        await response.body?.cancel();
        return null;
      }
      throw await graphFailure(response);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxReadBytes ? null : bytes;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return null;
    }
    throw error;
  }
};

/** What a page reads every message against. */
interface Mailbox {
  owner: SyncReader[];
  folders: Map<string, Standing>;
}

/**
 * A message, as items: the message and each file attachment, or gone, or
 * nothing (a draft). Throws `Full` when the page has no room for all of
 * it: a message is taken whole or not at all.
 * https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
 */
const itemsOf = async (
  room: Room,
  mailbox: Mailbox,
  listed: Listed
): Promise<SyncItem[]> => {
  const gone: SyncItem[] = [{ gone: true, id: listed.id, kind: "mail" }];
  if (listed.isDraft === true) {
    return [];
  }
  const folder = listed.parentFolderId ?? null;
  if (
    folder === null ||
    (await standingOf(room, mailbox.folders, folder)) === "gone"
  ) {
    return gone;
  }
  const response = await get(
    room,
    graphUrl(`${messages}/${segment(listed.id)}`, { $select: messageFields })
  );
  if (isUnreadable(response)) {
    await response.body?.cancel();
    return gone;
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const message = messageSchema.parse(await response.json());
  const version = listed.changeKey ?? listed.lastModifiedDateTime;
  const common = {
    gone: false,
    kind: "mail",
    version,
    changedAt: listed.lastModifiedDateTime,
    readers: mailbox.owner,
    changedBy: null,
  } as const;
  const items: SyncItem[] = [
    {
      ...common,
      id: listed.id,
      title: message.subject ?? "",
      content: take(room, { type: "text", text: textOf(message) }),
      partOf: null,
    },
  ];
  if (listed.hasAttachments !== true) {
    return items;
  }
  const attachments = await attachmentsOf(room, listed.id);
  for (const attachment of attachments.filter(isFile)) {
    // oxlint-disable-next-line no-await-in-loop -- one file after another, within the page's room
    const bytes = await bytesOf(room, listed.id, attachment);
    items.push({
      ...common,
      id: `${listed.id}/${attachment.id}`,
      title: attachment.name ?? "",
      content:
        bytes === null
          ? null
          : take(room, {
              type: "file",
              contentType: attachment.contentType ?? unknownType,
              base64: toBase64(bytes),
            }),
      partOf: listed.id,
    });
  }
  return items;
};

/** The listing's messages from where the read goes on, and how to read on. */
interface Listing {
  entries: Listed[];
  next: URL | null;
  settled: number;
}

/** Where the listing goes on after a page. */
const nextLink = (page: z.infer<typeof listingSchema>): URL | null => {
  const link = page["@odata.nextLink"];
  return link === undefined ? null : nextUrl(link, messages);
};

/**
 * The first listing page with messages left to handle: after the handled
 * message, following Graph's next links through its tie, or the whole tie
 * again when it isn't there as it was.
 */
const resume = async (room: Room, position: Position): Promise<Listing> => {
  const first = await listingPage(room, listingUrl(position.since));
  let { page } = first;
  if (position.after === null) {
    return {
      entries: page.value,
      next: nextLink(page),
      settled: first.settled,
    };
  }
  for (;;) {
    // The handled message as it was: at the cursor's time. Found later, it
    // changed again, and the messages between were never handled.
    const index = page.value.findIndex(
      ({ id, lastModifiedDateTime }) =>
        id === position.after && lastModifiedDateTime === position.since
    );
    if (index !== -1) {
      return {
        entries: page.value.slice(index + 1),
        next: nextLink(page),
        settled: first.settled,
      };
    }
    const next = nextLink(page);
    const stillTied = page.value.every(
      ({ lastModifiedDateTime }) => lastModifiedDateTime === position.since
    );
    if (next === null || !stillTied) {
      // Not there as it was: the whole tie again, from the first page.
      return {
        entries: first.page.value,
        next: nextLink(first.page),
        settled: first.settled,
      };
    }
    // oxlint-disable-next-line no-await-in-loop -- through the tie, a page at a time
    ({ page } = await listingPage(room, next));
  }
};

/** The person's own Entra object ID, their mail's only reader. */
const ownerOf = async (room: Room): Promise<SyncReader[]> => {
  const { id } = await getJson(room, graphUrl(me, { $select: "id" }), meSchema);
  return [{ kind: "account", id: id.toLowerCase() }];
};

/**
 * One message's items, or why the page stops before it: the page's
 * deadline passed, Graph changed it at or after the second it answered,
 * or there is no room for all of it.
 */
const handle = async (
  room: Room,
  mailbox: Mailbox,
  listing: Listing,
  listed: Listed
): Promise<SyncItem[] | "unsettled" | "full"> => {
  if (Date.parse(listed.lastModifiedDateTime) >= listing.settled) {
    return "unsettled";
  }
  if (!room.first && Date.now() >= room.deadline) {
    return "full";
  }
  try {
    return await itemsOf(room, mailbox, listed);
  } catch (error) {
    if (error instanceof FullError && !room.first) {
      return "full";
    }
    throw error;
  }
};

/** One page of the person's own mailbox from `position` on. */
const readPage = async (
  position: Position,
  deadline: number
): Promise<SyncPage> => {
  const room: Room = {
    requests: syncPageLimits.requests,
    bytes: syncPageLimits.contentBytes,
    deadline,
    first: true,
  };
  const mailbox: Mailbox = {
    owner: await ownerOf(room),
    folders: await knownFolders(room),
  };
  const listing = await resume(room, position);
  const items: SyncItem[] = [];
  let at = position;
  for (;;) {
    const listed = listing.entries.shift();
    if (listed === undefined) {
      if (listing.next === null) {
        return { items, cursor: cursorOf(at), more: false };
      }
      // oxlint-disable-next-line no-await-in-loop -- the listing's next page
      const { page } = await listingPage(room, listing.next);
      listing.entries = page.value;
      listing.next = nextLink(page);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one message after another, within the page's room
    const handled = await handle(room, mailbox, listing, listed);
    if (handled === "unsettled") {
      return { items, cursor: cursorOf(at), more: false };
    }
    if (handled === "full") {
      return { items, cursor: cursorOf(at), more: true };
    }
    items.push(...handled);
    room.first = false;
    at = { since: listed.lastModifiedDateTime, after: listed.id };
  }
};

/** The person's own mailbox: every message, its changes and attachments. */
export const mailSync = defineSync({
  name: "mail",
  kind: "mail",
  routes: [
    { method: "GET", host: graphHost, path: `${v1}${me}` },
    { method: "GET", host: graphHost, path: `${v1}${messages}` },
    { method: "GET", host: graphHost, path: `${v1}${messages}/{message}` },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${messages}/{message}/attachments`,
    },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${messages}/{message}/attachments/{attachment}/$value`,
    },
    { method: "GET", host: graphHost, path: `${v1}${folders}/{folder}` },
  ],
  read: async ({ place, cursor, deadline }) => {
    if (place !== ownPlace) {
      throw new ToolError("This sync reads the person's own mailbox only", {
        code: "failed",
      });
    }
    return await readPage(
      cursor === null ? { since: null, after: null } : positionOf(cursor),
      deadline
    );
  },
});
