import { ToolError } from "@grasp-os/connector-kit/connector";
import { maxReadBytes, toBase64 } from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import {
  cursorPart,
  defineSync,
  fetchInRoom,
  fillPage,
  fromCursorPart,
  mayRequest,
  RestartSyncError,
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
// and Clutter folders)", ordered by `lastModifiedDateTime`
// (https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).
// The first listing and every change after it are the same read: the
// first has no lower bound. Messages are asked for by their immutable IDs
// (`Prefer: IdType="ImmutableId"`): a message's usual ID "changes when the
// item is moved from one container … to another"
// (https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).
//
// Resuming, by key, never by position, and without assuming how Graph
// orders messages changed at the same time. Graph documents ordering by
// several properties, but none by `id`, and "properties that appear in
// `$orderby` must also appear in `$filter`"
// (https://learn.microsoft.com/en-us/graph/query-parameters), so there is
// no second sort key to lean on. Instead the sync takes the messages of
// one `lastModifiedDateTime` (a "time") as a group, in the order of their
// IDs, which it sorts itself:
// - A listing reads past the last time done (`gt`), and only the first
//   page of it: Graph's next link carries `$skip`, a position ("This API
//   uses the `$skip` value to keep count of all the items it has gone
//   through"), which a message that changes meanwhile shifts.
// - Every time but the last of a full listing page is whole in the page.
//   The last one, and a time a page stopped inside, is read on its own
//   (`eq`), its IDs sorted, and goes on after the greatest ID handled.
// - Only messages last changed before the second Graph answered the
//   listing in (its `Date` header) are taken, so no message joins a time
//   once the sync has started on it.
// - A time is done only when all of its messages are; the cursor then
//   moves past it.
//
// What goes away, at once: a message in Deleted Items or Junk Email, or in
// a folder under either (a deleted folder is moved under Deleted Items),
// found by walking a message's folder up to the mailbox's root. A message
// outside the root, or whose folder Graph no longer has, can't be
// confirmed as mail and goes away too. The sync run removes a message's
// attachments with it. A message whose read is late past the page's
// deadline is left to the next page; the page's first goes away, so it
// can't hold the sync, and comes back when it next changes or at the
// daily relisting.
//
// What is left out: drafts (`isDraft`, not sent yet); inline attachments
// (pictures in the body, such as signatures); attachments that are an
// Outlook item (an attached message, event or contact) or a link to a
// cloud file; a file attachment larger than a read takes (`maxReadBytes`)
// comes without its content; Bcc and Reply-To in a message's header lines.
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
// - That `lastModifiedDateTime` is set no later than the `Date` of the
//   first answer that lists the message.
// - A time of more than one listing page of messages (1,000 changed in
//   one second) can only be read through Graph's next links, a position: a
//   message of it that changes during that read can hide another until the
//   daily relisting.

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

/** Each Graph read's headers. */
const init = { headers: { prefer } };

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
 * Where a read is: from the start; inside a time, after the greatest ID
 * handled in it (none: from its first); or past a time.
 */
type Position =
  | { at: "start" }
  | { at: "inside"; time: string; after: string | null }
  | { at: "past"; time: string };

/** The cursor of a position: `m.s`, `m.i.<time>.<after>` or `m.p.<time>`. */
const cursorOf = (position: Position): string => {
  switch (position.at) {
    case "start": {
      return "m.s";
    }
    case "inside": {
      return `m.i.${cursorPart(position.time)}.${cursorPart(position.after)}`;
    }
    case "past": {
      return `m.p.${cursorPart(position.time)}`;
    }
    default: {
      return position satisfies never;
    }
  }
};

const notOurs = (): RestartSyncError =>
  new RestartSyncError("Not a cursor this sync wrote");

/** A time a cursor carries, checked before it goes into a `$filter`. */
const timeOf = (part: string | undefined): string => {
  const time = fromCursorPart(part);
  if (time === null || !timeSchema.safeParse(time).success) {
    throw notOurs();
  }
  return time;
};

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [tag, at, time, after, ...rest] = cursor.split(".");
  if (tag !== "m" || rest.length > 0) {
    throw notOurs();
  }
  if (at === "s" && time === undefined) {
    return { at: "start" };
  }
  if (at === "i" && after !== undefined) {
    return { at: "inside", time: timeOf(time), after: fromCursorPart(after) };
  }
  if (at === "p" && after === undefined) {
    return { at: "past", time: timeOf(time) };
  }
  throw notOurs();
};

/**
 * Why a page stops before a message: no room left in it (`full`), or a
 * read the page's deadline cut off (`late`).
 */
class StopError extends Error {
  readonly why: "full" | "late";

  constructor(why: "full" | "late") {
    super(
      why === "full"
        ? "No room left in the page"
        : "Graph didn't answer before the page's deadline"
    );
    this.name = "StopError";
    this.why = why;
  }
}

/**
 * What a read the page can't go without stands for when it is late or out
 * of room with nothing taken: Graph is slow, and the page waits as for a
 * rate limit, rather than answering with no progress.
 */
const tooSlow = (): ToolError =>
  new ToolError("Microsoft 365 didn't answer in time", {
    code: "unavailable",
  });

/**
 * A GET to Graph, within the page's requests, its whole answer read before
 * the page's deadline (the kit's `fetchInRoom`); a stop when there is no
 * request left or the deadline cut it off.
 */
const get = async (room: SyncRoom, url: URL): Promise<Response> => {
  if (room.requests <= 0) {
    throw new StopError("full");
  }
  const response = await fetchInRoom(room, url, init);
  if (response === "late") {
    throw new StopError("late");
  }
  return response;
};

/** Graph's JSON answer to a GET that must succeed. */
const getJson = async <Schema extends z.ZodType>(
  room: SyncRoom,
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
 * same path (see "NEEDS A REAL TENANT" for where it is followed).
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

/**
 * The first page of the listing past `time` (from the start without one),
 * oldest change first, and Graph's second of it. `$filter` and `$orderby`
 * name the same property, as Graph requires (user-list-messages, "Using
 * filter and orderby in the same query").
 */
const listingAfter = async (room: SyncRoom, time: string | null) => {
  const response = await get(
    room,
    graphUrl(messages, {
      $filter: time === null ? undefined : `lastModifiedDateTime gt ${time}`,
      $orderby: "lastModifiedDateTime",
      $select: listedFields,
      $top: String(listingSize),
    })
  );
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return {
    settled: secondOf(response),
    page: listingSchema.parse(await response.json()),
  };
};

/** By ID, as the sync orders a time's messages itself. */
const byId = (a: Listed, b: Listed): number =>
  a.id < b.id ? -1 : Number(a.id > b.id);

/**
 * Every message changed at `time`, in the order of their IDs. Past one
 * listing page, through Graph's next links (see "NEEDS A REAL TENANT").
 */
const messagesAt = async (room: SyncRoom, time: string): Promise<Listed[]> => {
  const listed: Listed[] = [];
  let url: URL | null = graphUrl(messages, {
    $filter: `lastModifiedDateTime eq ${time}`,
    $select: listedFields,
    $top: String(listingSize),
  });
  while (url !== null) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page: z.infer<typeof listingSchema> = await getJson(
      room,
      url,
      listingSchema
    );
    listed.push(...page.value);
    const next: string | undefined = page["@odata.nextLink"];
    url = next === undefined ? null : nextUrl(next, messages);
  }
  return listed.toSorted(byId);
};

/** Whether a folder's messages are mail, as far as the page found out. */
type Standing = "mail" | "gone";

/**
 * Whether a folder holds mail: under the mailbox's root and not under
 * Deleted Items or Junk Email, walked up one folder at a time and kept for
 * the page. A folder Graph no longer has, or outside the root, is gone.
 * https://learn.microsoft.com/en-us/graph/api/mailfolder-get?view=graph-rest-1.0
 */
const standingOf = async (
  room: SyncRoom,
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
const knownFolders = async (room: SyncRoom): Promise<Map<string, Standing>> => {
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

/**
 * Takes `content` into the page if it fits; on an empty page, without it;
 * else the page stops before the message (the kit's `takeContent`).
 */
const take = (room: SyncRoom, content: SyncContent): SyncContent | null => {
  const taken = takeContent(room, content);
  if (taken === null) {
    throw new StopError("full");
  }
  return taken.content;
};

/** Whether an attachment is a file to sync: a file, not inline. */
const isFile = (attachment: Attachment): boolean =>
  attachment["@odata.type"] === "#microsoft.graph.fileAttachment" &&
  attachment.isInline !== true;

/** A message's attachments, as listed, through Graph's next links. */
const attachmentsOf = async (
  room: SyncRoom,
  id: string
): Promise<Attachment[]> => {
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
 * An attachment's bytes: null when it is larger than a read takes, Graph
 * no longer has it, or, for the page's first message only, it is late or
 * out of room. For any later message that stops the page before it, so
 * the file is read with its content on the next page.
 * https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0
 */
const bytesOf = async (
  room: SyncRoom,
  message: string,
  attachment: Attachment
): Promise<Uint8Array | null> => {
  if ((attachment.size ?? 0) > maxReadBytes) {
    return null;
  }
  let response: Response;
  try {
    if (!mayRequest(room)) {
      throw new StopError(room.requests <= 0 ? "full" : "late");
    }
    response = await get(
      room,
      graphUrl(
        `${messages}/${segment(message)}/attachments/${segment(attachment.id)}/$value`
      )
    );
  } catch (error) {
    if (error instanceof StopError && room.empty) {
      return null;
    }
    throw error;
  }
  if (isUnreadable(response)) {
    return null;
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > maxReadBytes ? null : bytes;
};

/** What a page reads every message against. */
interface Mailbox {
  owner: SyncReader[];
  folders: Map<string, Standing>;
}

/**
 * A message, as items: the message and each file attachment, or gone, or
 * nothing (a draft). Throws a stop when the page has no room for all of
 * it: a message is taken whole or not at all.
 * https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
 */
const itemsOf = async (
  room: SyncRoom,
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

/**
 * One message's items for the kit's `fillPage`, or "full" when the page
 * stops before it: out of room or time, or a read late. The page's first
 * message is taken whatever it costs; if its reads are late it goes away,
 * so it can't hold the sync.
 */
const itemsFor =
  (room: SyncRoom, mailbox: Mailbox) =>
  async (listed: Listed): Promise<readonly SyncItem[] | "full"> => {
    if (!room.empty && !mayRequest(room)) {
      return "full";
    }
    try {
      return await itemsOf(room, mailbox, listed);
    } catch (error) {
      if (!(error instanceof StopError)) {
        throw error;
      }
      if (!room.empty) {
        return "full";
      }
      if (error.why === "late") {
        return [{ gone: true, id: listed.id, kind: "mail" }];
      }
      throw tooSlow();
    }
  };

/** The person's own Entra object ID, their mail's only reader. */
const ownerOf = async (room: SyncRoom): Promise<SyncReader[]> => {
  const { id } = await getJson(room, graphUrl(me, { $select: "id" }), meSchema);
  return [{ kind: "account", id: id.toLowerCase() }];
};

/** What a step of the page took, and where it goes on. */
interface Step {
  items: SyncItem[];
  at: Position;
  /** Whether the page stops here, and whether more is due at once. */
  stop: { more: boolean } | null;
}

/**
 * The messages of `time` after `after`, in the order of their IDs: those
 * a listing page already holds whole, or read on their own.
 */
const insideStep = async (
  room: SyncRoom,
  mailbox: Mailbox,
  time: string,
  after: string | null,
  whole: readonly Listed[] | null
): Promise<Step> => {
  const all = whole ?? (await messagesAt(room, time));
  const left = all.filter(({ id }) => after === null || id > after);
  const filled = await fillPage(
    room,
    left,
    null,
    ({ id }) => id,
    itemsFor(room, mailbox)
  );
  if (!filled.done) {
    return {
      items: filled.items,
      at: { at: "inside", time, after: filled.last ?? after },
      stop: { more: true },
    };
  }
  return { items: filled.items, at: { at: "past", time }, stop: null };
};

/**
 * The listing past the last time done: each time whole in its page taken
 * from there; the last time of a page that goes on, which may go on past
 * it, read on its own next.
 */
const listingStep = async (
  room: SyncRoom,
  mailbox: Mailbox,
  position: Exclude<Position, { at: "inside" }>
): Promise<Step> => {
  const { settled, page } = await listingAfter(
    room,
    position.at === "past" ? position.time : null
  );
  const listed = page.value.filter(
    ({ lastModifiedDateTime }) => Date.parse(lastModifiedDateTime) < settled
  );
  const lastTime = page.value.at(-1)?.lastModifiedDateTime;
  const goesOn = page["@odata.nextLink"] !== undefined;
  const items: SyncItem[] = [];
  let at: Position = position;
  const times = [
    ...new Set(listed.map(({ lastModifiedDateTime }) => lastModifiedDateTime)),
  ];
  for (const time of times) {
    if (goesOn && time === lastTime) {
      return { items, at: { at: "inside", time, after: null }, stop: null };
    }
    const whole = listed
      .filter(({ lastModifiedDateTime }) => lastModifiedDateTime === time)
      .toSorted(byId);
    // oxlint-disable-next-line no-await-in-loop -- one time after another
    const step = await insideStep(room, mailbox, time, null, whole);
    items.push(...step.items);
    ({ at } = step);
    if (step.stop !== null) {
      return { items, at, stop: step.stop };
    }
  }
  // Every settled time is done: what's left changed at or after the second
  // Graph answered in, or there is nothing more.
  return { items, at, stop: { more: false } };
};

/** One page of the person's own mailbox from `position` on. */
const readPage = async (
  position: Position,
  deadline: number
): Promise<SyncPage> => {
  const room = syncRoom(deadline);
  const items: SyncItem[] = [];
  let at = position;
  try {
    const mailbox: Mailbox = {
      owner: await ownerOf(room),
      folders: await knownFolders(room),
    };
    for (;;) {
      const step =
        at.at === "inside"
          ? // oxlint-disable-next-line no-await-in-loop -- one step after another, within the page's room
            await insideStep(room, mailbox, at.time, at.after, null)
          : // oxlint-disable-next-line no-await-in-loop -- one step after another, within the page's room
            await listingStep(room, mailbox, at);
      items.push(...step.items);
      ({ at } = step);
      if (step.stop !== null) {
        return { items, cursor: cursorOf(at), more: step.stop.more };
      }
      if (!mayRequest(room)) {
        return { items, cursor: cursorOf(at), more: true };
      }
    }
  } catch (error) {
    if (!(error instanceof StopError)) {
      throw error;
    }
    // A listing or a folder late or out of room: what the page has, or,
    // with nothing taken yet, a wait as for a rate limit.
    if (room.empty) {
      throw tooSlow();
    }
    return { items, cursor: cursorOf(at), more: true };
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
      cursor === null ? { at: "start" } : positionOf(cursor),
      deadline
    );
  },
});
