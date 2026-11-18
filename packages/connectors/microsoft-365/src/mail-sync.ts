import { ToolError } from "@grasp-os/connector-kit/connector";
import { maxReadBytes, toBase64 } from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import {
  cursorPart,
  defineSync,
  fetchInRoom,
  fillPage,
  fromInPagePart,
  inPagePart,
  startOfPage,
  fromCursorPart,
  mayRequest,
  RestartSyncError,
  syncPageLimits,
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
// The folder listing goes on across reads (`listSyncPlaces` with a
// cursor): Exchange allows 10,000 subfolders a folder and 300 levels
// (Exchange Online limits, "Mailbox folder limits"), so no read is sure to
// hold a mailbox's folders.
//
// What is left out: drafts (`isDraft`); inline attachments (pictures in
// the body, such as signatures); attachments that are an Outlook item (an
// attached message, event or contact) or a link to a cloud file; Bcc and
// Reply-To in a message's header lines. An item past one of the shared
// item's bounds is fitted by the kit (`fitItem`). A message or file larger than
// connect reads of one answer, or late past the page's deadline as the
// page's first, comes without its content, never failing the page.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft):
// - That mailFolder delta lists every folder, nested ones too, hidden ones
//   and search folders included or not; its page doesn't say. Hidden
//   folders (`isHidden`), search folders (`mailSearchFolder`, and every
//   folder under the search folders' parent) are left out either way.
// - The largest page mailFolder delta gives (`odata.maxpagesize`): its
//   page names the header without a maximum. A list longer than a read
//   goes on in the next.
// - That a delta token read again answers the same messages in the same
//   order, less those changed since. If not, Graph's page is read from its
//   top.

const me = "/me";
const folders = `${me}/mailFolders`;
const messages = `${me}/messages`;

/**
 * Folders whose messages aren't mail to keep, nor any folder under them:
 * the bin, junk, drafts, and the search folders' parent (a search folder
 * shows messages of other folders again).
 */
const leftOutFolders = [
  "deleteditems",
  "junkemail",
  "drafts",
  "searchfolders",
] as const;

/** The mailbox's root: the folders a mail client shows are under it. */
const rootFolder = "msgfolderroot";

/**
 * Folders asked of Graph per page of mailFolder delta
 * (`odata.maxpagesize`, which its page documents without a maximum): the
 * most Outlook's lists take a page ("within the range of 1 and 1000",
 * user-list-messages).
 */
const folderPageSize = 1000;

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

/**
 * A folder, as mailFolder delta and a folder's read give it
 * (https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0):
 * a search folder comes as `#microsoft.graph.mailSearchFolder`.
 */
const folderEntrySchema = z.object({
  "@odata.type": z.string().nullish(),
  id: z.string().min(1),
  "@removed": removedSchema,
  parentFolderId: z.string().min(1).nullish(),
  isHidden: z.boolean().nullish(),
});
type FolderEntry = z.infer<typeof folderEntrySchema>;

const folderFields = "id,parentFolderId,isHidden";

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
 * listing), and where it is inside that token's page (the kit's `InPage`).
 */
interface Position {
  token: Token | null;
  at: InPage;
}

const notOurs = (): RestartSyncError =>
  new RestartSyncError("Not a cursor this sync wrote");

const kinds: Readonly<Record<string, Token["kind"] | null>> = {
  s: "skip",
  d: "delta",
  n: null,
};

/** The cursor of a position: `f.<s|d|n>.<token>.<at>`. */
const cursorOf = ({ token, at }: Position): string =>
  `f.${token === null ? "n" : token.kind.charAt(0)}.${cursorPart(token?.value ?? null)}.${inPagePart(at)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [tag, kind = "", token, at, ...rest] = cursor.split(".");
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
    at: fromInPagePart(at),
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
  url: URL,
  pageSize?: number
): Promise<Response | "late" | "large"> => {
  try {
    return await fetchInRoom(
      room,
      url,
      pageSize === undefined
        ? init
        : { headers: { prefer: `${prefer}, odata.maxpagesize=${pageSize}` } }
    );
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

/** Whether a folder's messages are mail to keep, as far as a read found out. */
type Standing = "keep" | "leave";

/** Whether a folder, on its own, is left out: hidden, or a search folder. */
const isLeftOutItself = (folder: FolderEntry): boolean =>
  folder.isHidden === true ||
  folder["@odata.type"] === "#microsoft.graph.mailSearchFolder";

/**
 * A folder's standing: left out itself, or as the folder above it; walked
 * up through the folders this read listed, then one read of Graph's each
 * (cached for the read), to a folder known. Null when the read has no
 * request left to finish the walk.
 * https://learn.microsoft.com/en-us/graph/api/mailfolder-get?view=graph-rest-1.0
 */
const standingOf = async (
  room: SyncRoom,
  known: Map<string, Standing>,
  listed: ReadonlyMap<string, FolderEntry>,
  folder: FolderEntry
): Promise<Standing | null> => {
  const walked: string[] = [];
  let at: FolderEntry | null = folder;
  let standing: Standing | undefined;
  while (standing === undefined) {
    if (at === null || walked.includes(at.id)) {
      // Outside the mailbox's root, or a loop: not mail a client shows.
      standing = "leave";
      break;
    }
    standing = known.get(at.id);
    if (standing !== undefined) {
      break;
    }
    walked.push(at.id);
    if (isLeftOutItself(at)) {
      standing = "leave";
      break;
    }
    const parent: string | null = at.parentFolderId ?? null;
    if (parent === null) {
      at = null;
      continue;
    }
    const cached = listed.get(parent);
    if (cached !== undefined || known.has(parent)) {
      at = cached ?? { id: parent };
      continue;
    }
    if (!mayRequest(room)) {
      return null;
    }
    // oxlint-disable-next-line no-await-in-loop -- one folder up at a time
    const response = await get(
      room,
      graphUrl(`${folders}/${segment(parent)}`, { $select: folderFields })
    );
    if (response === "late") {
      return null;
    }
    if (response === "large" || isUnreadable(response)) {
      at = null;
      continue;
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the walk ends here
      throw await graphFailure(response);
    }
    // oxlint-disable-next-line no-await-in-loop -- the walk goes on from it
    at = folderEntrySchema.parse(await response.json());
  }
  for (const id of walked) {
    known.set(id, standing);
  }
  return standing;
};

/**
 * Where the folder listing goes on: Graph's skip token (none: from its
 * start), and the folder of that page already handled.
 */
interface ListingAt {
  token: string | null;
  after: string | null;
}

/** The cursor of where the folder listing goes on: `l.<token>.<after>`. */
const listingCursorOf = ({ token, after }: ListingAt): string =>
  `l.${cursorPart(token)}.${cursorPart(after)}`;

/** Where a folder listing's cursor says it goes on; any other starts over. */
const listingAtOf = (cursor: string | null): ListingAt => {
  if (cursor === null) {
    return { token: null, after: null };
  }
  const [tag, token, after, ...rest] = cursor.split(".");
  if (tag !== "l" || rest.length > 0) {
    throw notOurs();
  }
  return { token: fromCursorPart(token), after: fromCursorPart(after) };
};

/**
 * The mailbox's folders to sync, a read at a time: every folder mailFolder
 * delta lists (https://learn.microsoft.com/en-us/graph/api/mailfolder-delta?view=graph-rest-1.0),
 * less hidden ones, search folders, and Deleted Items, Junk Email, Drafts
 * and the search folders' parent with every folder under them. A list
 * longer than one read goes on from its cursor: Graph's skip token and
 * the last folder handled in its page.
 */
const placesOf = async ({
  cursor,
  deadline,
}: {
  cursor: string | null;
  deadline: number;
}): Promise<{ places: string[]; cursor: string | null }> => {
  const room = syncRoom(deadline);
  let at = listingAtOf(cursor);
  const from0 = listingCursorOf(at);
  const places: string[] = [];
  /** What the read answers when it must stop: a wait if it moved nothing on. */
  const stop = (): { places: string[]; cursor: string | null } => {
    if (places.length === 0 && listingCursorOf(at) === from0) {
      throw tooSlow();
    }
    return { places, cursor: listingCursorOf(at) };
  };
  const known = new Map<string, Standing>();
  for (const name of [rootFolder, ...leftOutFolders]) {
    // oxlint-disable-next-line no-await-in-loop -- five small reads
    const { id } = await getJson(
      room,
      graphUrl(`${folders}/${name}`, { $select: "id" }),
      folderSchema
    );
    known.set(id, name === rootFolder ? "keep" : "leave");
  }
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const response = await get(
      room,
      graphUrl(
        `${folders}/delta`,
        at.token === null ? { $select: folderFields } : { $skiptoken: at.token }
      ),
      folderPageSize
    );
    if (response === "late") {
      return stop();
    }
    if (response === "large") {
      throw new ToolError("Graph's folder page is larger than connect reads", {
        code: "failed",
      });
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the listing ends here
      throw await graphFailure(response);
    }
    // oxlint-disable-next-line no-await-in-loop -- read before it's handled
    const page = foldersSchema.parse(await response.json());
    const listed = new Map(page.value.map((folder) => [folder.id, folder]));
    const { after } = at;
    const from =
      after === null ? 0 : page.value.findIndex(({ id }) => id === after) + 1;
    for (const folder of page.value.slice(from)) {
      if (folder["@removed"] === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one folder after another
        const standing = await standingOf(room, known, listed, folder);
        if (standing === null) {
          // No room left to place it: the next read goes on from it.
          return stop();
        }
        if (standing === "keep") {
          places.push(folder.id);
        }
      }
      at = { token: at.token, after: folder.id };
    }
    const next = page["@odata.nextLink"];
    if (next === undefined) {
      return { places, cursor: null };
    }
    at = { token: tokenOf(next, "skip").value, after: null };
    if (!mayRequest(room)) {
      return stop();
    }
  }
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
  return [messageItem(folder, listed, listed.subject ?? "", null)];
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
    return [item];
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
  return items;
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
      at: at.at,
      keyOf,
      itemsFor: async (listed) => await itemsOf(room, folder, listed),
      passOver: (listed) => passOver(folder, listed),
    });
    items.push(...filled.items);
    if (!filled.done) {
      return {
        items,
        cursor: cursorOf({ ...at, at: filled.at }),
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
      at: startOfPage,
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
  places: async (params) => await placesOf(params),
  read: async ({ place, cursor, deadline }) =>
    await readPage(
      place,
      cursor === null ? { token: null, at: startOfPage } : positionOf(cursor),
      deadline
    ),
});
