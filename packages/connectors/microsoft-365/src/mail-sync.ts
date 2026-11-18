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
  syncPageLimits,
  syncRoom,
  takeContent,
} from "@grasp-os/connector-kit/sync";
import type { EntryItems, SyncRoom } from "@grasp-os/connector-kit/sync";
import type {
  SyncContent,
  SyncItem,
  SyncPage,
  SyncReader,
} from "@grasp-os/shared/sync";
import { syncItemSchema } from "@grasp-os/shared/sync";
import { z } from "zod";

import { graphFailure, graphHost, graphUrl, v1 } from "./graph.ts";

// Native sync of a person's own Outlook mailbox (GRA-1759, PR G): every
// message of every mail folder, then what changed and what went away, each
// attachment an item of its own linked to its message (`partOf`). Mail is
// readable only by the mailbox's own person, so each message's only reader
// is them, and it lives in their own store.
//
// How it reads (the orchestrator's decision, recorded on GRA-1759): by
// message delta, per mail folder, as Microsoft documents syncing mail
// ("Delta query is a per-folder operation. To track the changes of the
// messages in a folder hierarchy, you need to track each folder
// individually",
// https://learn.microsoft.com/en-us/graph/delta-query-messages). Each mail
// folder is a place of the person's own connection, a source of its own
// with its own cursor, the folder's delta token:
// - Its places are the mailbox's folders (mailFolder delta,
//   https://learn.microsoft.com/en-us/graph/api/mailfolder-delta?view=graph-rest-1.0),
//   less Deleted Items, Junk Email and Drafts and every folder under them.
//   A folder that appears or goes changes the list; core then adds or
//   drops its source.
// - A folder's messages come from its delta
//   (https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0),
//   first all of them, then what changed. A message deleted, or moved out
//   of the folder, comes under `@removed` and goes. A moved message comes
//   in the folder it moved to as new.
// - Each item is keyed by its folder too (`<folder>/<message>`): a message
//   keeps its ID when it moves (`Prefer: IdType="ImmutableId"`), so the
//   copy that goes and the copy that comes are two keys, and the order in
//   which core applies the two folders' pages can never erase the one that
//   stays.
// - Graph's next and delta links are never followed: only their
//   `$skiptoken` or `$deltatoken` is kept, which carry the `$select`, and
//   the request is built here. A token Graph no longer knows (410,
//   `syncStateNotFound`) lists the folder again.
// - Graph is asked for no more messages a page (`odata.maxpagesize`) than a
//   page has requests for one read each; a page that stops inside Graph's
//   page goes on after the last message handled, by its ID and
//   `changeKey`, or from the top of Graph's page when that message isn't
//   there as it was (the kit's `fillPage`).
//
// What is left out: drafts (`isDraft`); inline attachments (pictures in
// the body, such as signatures); attachments that are an Outlook item (an
// attached message, event or contact) or a link to a cloud file; Bcc and
// Reply-To in a message's header lines. A message or file larger than
// connect reads of one answer, or late past the page's deadline as the
// page's first, comes without its content, never failing the page.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft):
// - That mailFolder delta lists every folder, nested ones too; its page
//   doesn't say.
// - That a delta token read again answers the same messages in the same
//   order, less those changed since. If not, Graph's page is read from its
//   top.

const me = "/me";
const folders = `${me}/mailFolders`;
const messages = `${me}/messages`;

/** Folders whose messages aren't mail to keep: the bin, junk, drafts. */
const leftOutFolders = ["deleteditems", "junkemail", "drafts"] as const;

/** Immutable IDs, and bodies as text (message-delta, message-get). */
const prefer = 'IdType="ImmutableId", outlook.body-content-type="text"';

/**
 * Messages asked of Graph per page of a folder's delta: one per request a
 * page has after its own two (the owner, the delta), so the page can read
 * each one.
 */
const deltaPageSize = syncPageLimits.requests - 2;

const removedSchema = z.unknown().optional();

const listedSchema = z.object({
  id: z.string().min(1),
  "@removed": removedSchema,
  changeKey: z.string().min(1).nullish(),
  lastModifiedDateTime: z.string().nullish(),
  subject: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  hasAttachments: z.boolean().nullish(),
});
type Listed = z.infer<typeof listedSchema>;

/** What a folder's delta lists of each message: enough to pass it over. */
const listedFields =
  "id,changeKey,lastModifiedDateTime,subject,isDraft,hasAttachments";

const deltaSchema = z.object({
  value: z.array(listedSchema),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

const folderEntrySchema = z.object({
  id: z.string().min(1),
  "@removed": removedSchema,
  parentFolderId: z.string().min(1).nullish(),
});

const foldersSchema = z.object({
  value: z.array(folderEntrySchema),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

const folderSchema = z.object({ id: z.string().min(1) });

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

const meSchema = z.object({ id: z.string().min(1) });

/** The content type of a file Graph names none for. */
const unknownType = "application/octet-stream";

/** Each Graph read's headers. */
const init = { headers: { prefer } };

/** Graph's token to read a folder's delta from: a skip or a delta token. */
interface Token {
  kind: "skip" | "delta";
  value: string;
}

/**
 * Where a folder's read is: Graph's token (none: the folder's first
 * listing), and the message of that token's page already handled.
 */
interface Position {
  token: Token | null;
  after: string | null;
}

const notOurs = (): RestartSyncError =>
  new RestartSyncError("Not a cursor this sync wrote");

const kinds: Readonly<Record<string, Token["kind"] | null>> = {
  s: "skip",
  d: "delta",
  n: null,
};

/** The cursor of a position: `f.<s|d|n>.<token>.<after>`. */
const cursorOf = ({ token, after }: Position): string =>
  `f.${token === null ? "n" : token.kind.charAt(0)}.${cursorPart(token?.value ?? null)}.${cursorPart(after)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [tag, kind = "", token, after, ...rest] = cursor.split(".");
  const tokenKind = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
  if (tag !== "f" || tokenKind === undefined || rest.length > 0) {
    throw notOurs();
  }
  const value = fromCursorPart(token);
  if ((tokenKind === null) !== (value === null)) {
    throw notOurs();
  }
  return {
    token:
      tokenKind === null || value === null ? null : { kind: tokenKind, value },
    after: fromCursorPart(after),
  };
};

/** The token a link Graph handed back carries; the link is never followed. */
const tokenOf = (link: string, kind: Token["kind"]): Token => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ToolError("Graph's link isn't a URL", { code: "failed" });
  }
  const value = url.searchParams.get(`$${kind}token`) ?? "";
  if (url.hostname !== graphHost || value === "") {
    throw new ToolError("Graph's link has no token", { code: "failed" });
  }
  return { kind, value };
};

/**
 * What a read the page can't go without stands for when it is late: Graph
 * is slow, and the page waits as for a rate limit.
 */
const tooSlow = (): ToolError =>
  new ToolError("Microsoft 365 didn't answer in time", {
    code: "unavailable",
  });

/** Whether Graph refused an item (403) or no longer has it (404). */
const isUnreadable = (response: Response): boolean =>
  response.status === 403 || response.status === 404;

/**
 * A GET to Graph within the page's room (the kit's `fetchInRoom`): "late"
 * when the deadline cut it off, "large" when its answer is more than
 * connect reads of one (the egress cuts it off while it comes).
 */
const get = async (
  room: SyncRoom,
  url: URL
): Promise<Response | "late" | "large"> => {
  try {
    return await fetchInRoom(room, url, init);
  } catch {
    return "large";
  }
};

/** Graph's JSON answer to a GET the page can't go without. */
const getJson = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  const response = await get(room, url);
  if (response === "late") {
    throw tooSlow();
  }
  if (response === "large") {
    throw new ToolError("Graph's answer is larger than connect reads", {
      code: "failed",
    });
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return schema.parse(await response.json());
};

/**
 * The mailbox's folders to sync: every folder mailFolder delta lists, less
 * Deleted Items, Junk Email and Drafts and every folder under them.
 */
const placesOf = async (): Promise<string[]> => {
  const room = syncRoom(Date.now() + syncPageLimits.millis);
  const leftOut = new Set<string>();
  for (const name of leftOutFolders) {
    // oxlint-disable-next-line no-await-in-loop -- three small reads
    const { id } = await getJson(
      room,
      graphUrl(`${folders}/${name}`, { $select: "id" }),
      folderSchema
    );
    leftOut.add(id);
  }
  const parents = new Map<string, string | null>();
  let url: URL | null = graphUrl(`${folders}/delta`, {
    $select: "id,parentFolderId",
  });
  while (url !== null) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page: z.infer<typeof foldersSchema> = await getJson(
      room,
      url,
      foldersSchema
    );
    for (const folder of page.value) {
      if (folder["@removed"] === undefined) {
        parents.set(folder.id, folder.parentFolderId ?? null);
      }
    }
    const next: string | undefined = page["@odata.nextLink"];
    url =
      next === undefined
        ? null
        : graphUrl(`${folders}/delta`, {
            $skiptoken: tokenOf(next, "skip").value,
          });
  }
  /** Whether a folder or one above it is left out. */
  const isLeftOut = (id: string): boolean => {
    const seen = new Set<string>();
    let at: string | null = id;
    while (at !== null && !seen.has(at)) {
      if (leftOut.has(at)) {
        return true;
      }
      seen.add(at);
      at = parents.get(at) ?? null;
    }
    return false;
  };
  return [...parents.keys()].filter((id) => !isLeftOut(id));
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

/** Whether an attachment is a file to sync: a file, not inline. */
const isFile = (attachment: Attachment): boolean =>
  attachment["@odata.type"] === "#microsoft.graph.fileAttachment" &&
  attachment.isInline !== true;

/** What a page reads a folder's messages with. */
interface Folder {
  place: string;
  owner: SyncReader[];
}

/** A message's key in a folder: `<folder>/<message>`. */
const keyIn = (folder: Folder, id: string): string => `${folder.place}/${id}`;

/**
 * Items that keep within the shared item's bounds; one that breaks them
 * (an ID or a title longer than an item takes) is passed over.
 */
const fitting = (items: readonly SyncItem[]): SyncItem[] =>
  items.filter((item) => syncItemSchema.safeParse(item).success);

/** An item that is there. */
type Present = Extract<SyncItem, { gone: false }>;

/** A message as an item, with `content`, and its version and time. */
const messageItem = (
  folder: Folder,
  listed: Listed,
  title: string,
  content: SyncContent | null
): Present => ({
  gone: false,
  id: keyIn(folder, listed.id),
  kind: "mail",
  version: listed.changeKey ?? listed.lastModifiedDateTime ?? "",
  changedAt: listed.lastModifiedDateTime ?? "",
  title,
  content,
  readers: folder.owner,
  changedBy: null,
  partOf: null,
});

/**
 * What a message passed over is, with no request: gone if removed,
 * nothing if a draft, else itself without its content or files.
 */
const passOver = (folder: Folder, listed: Listed): SyncItem[] => {
  if (listed["@removed"] !== undefined) {
    return [{ gone: true, id: keyIn(folder, listed.id), kind: "mail" }];
  }
  if (listed.isDraft === true) {
    return [];
  }
  return fitting([messageItem(folder, listed, listed.subject ?? "", null)]);
};

/** A message's attachments, as listed, a page of Graph's at a time. */
const attachmentsOf = async (
  room: SyncRoom,
  id: string
): Promise<Attachment[] | "late" | "full"> => {
  const path = `${messages}/${segment(id)}/attachments`;
  const listed: Attachment[] = [];
  let url: URL | null = graphUrl(path, {
    $select: "id,name,contentType,size,isInline",
  });
  while (url !== null) {
    if (!mayRequest(room)) {
      // The page's first message is taken with the files listed so far.
      return room.empty ? listed : "full";
    }
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const response = await get(room, url);
    if (response === "late") {
      return "late";
    }
    if (response === "large" || isUnreadable(response)) {
      return listed;
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the listing ends here
      throw await graphFailure(response);
    }
    // oxlint-disable-next-line no-await-in-loop -- read before the next
    const page = attachmentsSchema.parse(await response.json());
    listed.push(...page.value);
    const next = page["@odata.nextLink"];
    url =
      next === undefined
        ? null
        : graphUrl(path, {
            $select: "id,name,contentType,size,isInline",
            $skiptoken: tokenOf(next, "skip").value,
          });
  }
  return listed;
};

/**
 * A file attachment's bytes: null when it is larger than a read takes,
 * than connect reads of one answer, or Graph no longer has it; "late" or
 * "full" when the page has no time or request left for it.
 * https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0
 */
const bytesOf = async (
  room: SyncRoom,
  message: string,
  attachment: Attachment
): Promise<Uint8Array | null | "late" | "full"> => {
  if ((attachment.size ?? 0) > maxReadBytes) {
    return null;
  }
  if (!mayRequest(room)) {
    // The page's first message is taken with its file's content left out.
    return room.empty ? null : "full";
  }
  const response = await get(
    room,
    graphUrl(
      `${messages}/${segment(message)}/attachments/${segment(attachment.id)}/$value`
    )
  );
  if (response === "late") {
    return "late";
  }
  if (response === "large" || isUnreadable(response)) {
    return null;
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > maxReadBytes ? null : bytes;
};

/**
 * One message's items for the kit's `fillPage`: gone, nothing (a draft),
 * or the message with its text and each file attachment; "late" or "full"
 * when the page stops before it (the kit passes over the page's first).
 * A message whose answer is larger than connect reads of one comes
 * without its content, never failing the page.
 * https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
 */
const itemsOf = async (
  room: SyncRoom,
  folder: Folder,
  listed: Listed
): Promise<EntryItems> => {
  if (listed["@removed"] !== undefined || listed.isDraft === true) {
    return passOver(folder, listed);
  }
  if (!mayRequest(room)) {
    return "full";
  }
  const response = await get(
    room,
    graphUrl(`${messages}/${segment(listed.id)}`, { $select: messageFields })
  );
  if (response === "late") {
    return "late";
  }
  if (response === "large") {
    return passOver(folder, listed);
  }
  if (isUnreadable(response)) {
    return [{ gone: true, id: keyIn(folder, listed.id), kind: "mail" }];
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const message = messageSchema.parse(await response.json());
  const text = takeContent(room, { type: "text", text: textOf(message) });
  if (text === null) {
    return "full";
  }
  const item = messageItem(folder, listed, message.subject ?? "", text.content);
  if (listed.hasAttachments !== true) {
    return fitting([item]);
  }
  const attachments = await attachmentsOf(room, listed.id);
  if (attachments === "late" || attachments === "full") {
    return attachments;
  }
  const items: SyncItem[] = [item];
  for (const attachment of attachments.filter(isFile)) {
    // oxlint-disable-next-line no-await-in-loop -- one file after another, within the page's room
    const bytes = await bytesOf(room, listed.id, attachment);
    if (bytes === "late" || bytes === "full") {
      return bytes;
    }
    let content: SyncContent | null = null;
    if (bytes !== null) {
      const taken = takeContent(room, {
        type: "file",
        contentType: attachment.contentType ?? unknownType,
        base64: toBase64(bytes),
      });
      if (taken === null) {
        return "full";
      }
      ({ content } = taken);
    }
    items.push({
      ...item,
      id: `${item.id}/${attachment.id}`,
      title: attachment.name ?? "",
      content,
      partOf: item.id,
    });
  }
  return fitting(items);
};

/** One page of a folder's delta: from a token, or its first listing. */
const deltaPage = async (
  room: SyncRoom,
  folder: Folder,
  token: Token | null
): Promise<z.infer<typeof deltaSchema> | "late"> => {
  const path = `${folders}/${segment(folder.place)}/messages/delta`;
  const url =
    token === null
      ? graphUrl(path, { $select: listedFields })
      : graphUrl(path, { [`$${token.kind}token`]: token.value });
  let response: Response | "late";
  try {
    response = await fetchInRoom(room, url, {
      headers: { prefer: `${prefer}, odata.maxpagesize=${deltaPageSize}` },
    });
  } catch {
    throw new ToolError("Graph's delta page is larger than connect reads", {
      code: "failed",
    });
  }
  if (response === "late") {
    return "late";
  }
  if (response.status === 410 || (response.status === 404 && token !== null)) {
    throw new RestartSyncError();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return deltaSchema.parse(await response.json());
};

/** A message's key in Graph's page: its ID and `changeKey`. */
const keyOf = ({ id, changeKey }: Listed): string =>
  `${id}\n${changeKey ?? ""}`;

/** The person's own Entra object ID, their mail's only reader. */
const ownerOf = async (room: SyncRoom): Promise<SyncReader[]> => {
  const { id } = await getJson(room, graphUrl(me, { $select: "id" }), meSchema);
  return [{ kind: "account", id: id.toLowerCase() }];
};

/** One page of a folder's messages from `position` on. */
const readPage = async (
  place: string,
  position: Position,
  deadline: number
): Promise<SyncPage> => {
  const room = syncRoom(deadline);
  const folder: Folder = { place, owner: await ownerOf(room) };
  const items: SyncItem[] = [];
  let at = position;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page of Graph's after another
    const page = await deltaPage(room, folder, at.token);
    if (page === "late") {
      if (room.empty) {
        throw tooSlow();
      }
      return { items, cursor: cursorOf(at), more: true };
    }
    // oxlint-disable-next-line no-await-in-loop -- one page of Graph's after another
    const filled = await fillPage({
      room,
      entries: page.value,
      after: at.after,
      keyOf,
      itemsFor: async (listed) => await itemsOf(room, folder, listed),
      passOver: (listed) => passOver(folder, listed),
    });
    items.push(...filled.items);
    if (!filled.done) {
      return {
        items,
        cursor: cursorOf({ ...at, after: filled.last }),
        more: true,
      };
    }
    const next = page["@odata.nextLink"];
    const end = page["@odata.deltaLink"];
    if (next === undefined && end === undefined) {
      throw new ToolError("Graph's page has no link on", { code: "failed" });
    }
    at = {
      token:
        next === undefined
          ? tokenOf(end ?? "", "delta")
          : tokenOf(next, "skip"),
      after: null,
    };
    if (next === undefined) {
      return { items, cursor: cursorOf(at), more: false };
    }
    if (!mayRequest(room)) {
      return { items, cursor: cursorOf(at), more: true };
    }
  }
};

/** The person's own mailbox: each folder's messages, changes and files. */
export const mailSync = defineSync({
  name: "mail",
  kind: "mail",
  routes: [
    { method: "GET", host: graphHost, path: `${v1}${me}` },
    { method: "GET", host: graphHost, path: `${v1}${folders}/delta` },
    { method: "GET", host: graphHost, path: `${v1}${folders}/{folder}` },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${folders}/{place}/messages/delta`,
    },
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
  ],
  places: async () => await placesOf(),
  read: async ({ place, cursor, deadline }) =>
    await readPage(
      place,
      cursor === null ? { token: null, after: null } : positionOf(cursor),
      deadline
    ),
});
