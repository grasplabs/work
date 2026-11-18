import { ToolError } from "@grasp-os/connector-kit/connector";
import { maxReadBytes, toBase64 } from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import {
  RestartSyncError,
  defineSync,
  fetchBefore,
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

import {
  downloadHosts,
  graphFailure,
  graphHost,
  graphUrl,
  v1,
} from "./graph.ts";

// Native sync of a person's own OneDrive (GRA-1759): every file in it,
// then what changed, what went away, and who may open each. A person's own
// connection syncs only their own drive (`/me/drive`): a file shared with
// them lives in its owner's drive and is synced by the owner's connection,
// once, with the whole reader list only an owner is given ("For a
// non-owner caller, only the sharing permissions that apply to the caller
// are returned", driveitem-list-permissions). SharePoint sites and picked
// folders come only through a shared connection's picked places (PR J).
//
// How it reads: driveItem delta, the only way Microsoft says reads a whole
// drive and its changes ("Using delta is the only way to guarantee that
// you've read all of the data you need to"), first without a token (the
// whole drive), then from a token
// (https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0).
// Graph's `@odata.nextLink` and `@odata.deltaLink` are never followed:
// only their `token` is kept, and every request is built here, on the
// sync's own routes.
//
// The first listing's first page has no token, so reading it again starts
// a new listing, in which a file made meanwhile can come before where the
// read goes on. So once the listing is done, the feed is read once more
// from when the listing began, as a timestamp token, which Microsoft
// documents for OneDrive for Business and SharePoint (the same page,
// "Retrieving delta results using a timestamp"), with the time Graph's own
// `Date` header gave its first page. A personal Microsoft account's
// OneDrive has no timestamp tokens: it goes on from the listing's own
// delta link, and a file made during its listing's first page can be
// missed until it next changes. Connect's Microsoft connections are work
// or school accounts.
//
// What goes away: an entry with the `deleted` facet; an entry that isn't
// the person's own (a shortcut to someone else's item, `remoteItem`, or
// one in another drive); and an item whose permissions or content Graph
// refuses (403) or no longer has (404): an item that can't be confirmed
// readable goes away. A token Graph no longer knows (410, `resyncRequired`
// and the `resyncChanges…` codes) lists the drive again from the start.
//
// Readers are re-read from the item's own permissions every time it comes
// in the feed, never taken from delta's `shared` facet, and a file's
// version includes them, so changed readers are always a new version,
// whether or not Graph's eTag moves with them.
//
// A folder's sharing: under `Prefer: hierarchicalsharing` sharing comes
// back only "for the root of the permissions hierarchy, as well as items
// that explicitly have sharing changes", and delta returns "only items
// with direct changes … and the parent hierarchy of the changed items"
// (https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance):
// when a folder is unshared, the folder comes back, not its files. "In
// cases where the sharing change is to remove sharing from an item you
// will find an empty sharing facet" (the same page). The facet's property
// is `shared`: the driveItem resource lists "shared | shared | Indicates
// that the item was shared with others and provides information about the
// shared state of the item", its JSON representation has `"shared": {
// "@odata.type": "microsoft.graph.shared" }`, and no property is named
// `sharing` there
// (https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0);
// the delta and scan pages name "the sharing facet" in prose only, with no
// JSON of it. So a folder (not the drive's root) that comes after the
// first listing with an EMPTY `shared` facet relists the drive, which reads every file's permissions again:
// first the round of changes it came in is read to its end, so nothing
// that round holds is lost, then the drive is listed again, then caught up
// from when that listing began. A facet that isn't empty (a share added
// or changed, or a root of a hierarchy that merely came in the feed) is
// no reason: readers missing or stale there are on the safe side until
// the daily relisting below. And at most one relisting per listing: while
// one is pending or under way, up to the end of its catch-up, another
// empty facet is left to the daily relisting, so a feed that sends them
// more often than documented can't keep the sync relisting. Delta has no
// documented read of one folder's files, and walking its children would
// need a stack no cursor holds; the cost of a relisting is every file's
// permissions and content again. Parents of a changed file are asked to
// stay out of the feed (`deltaExcludeParent`, a request header the delta
// page documents).
//
// Where Microsoft gives no signal (below), the sync run in core relists
// every connection in full once a day (PR I), so a reader list is at most
// a day stale.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft):
// - That "an empty sharing facet" in a delta answer under
//   `hierarchicalsharing` is an empty `shared` object, the facet's only
//   documented property; the pages give no JSON of it. If it comes some
//   other way, an unshared folder's files wait for the daily relisting.
// - Whether a change to one file's sharing alone puts it in the delta
//   feed. Microsoft documents a marker for sharing changes only with
//   `Prefer: deltashowsharingchanges`, which needs `Sites.FullControl.All`,
//   which we don't ask for. If it doesn't come, its readers are at most a
//   day stale (the daily relisting above).
// - How an item the account lost access to shows in the feed (a `deleted`
//   facet, or nothing). If nothing, it goes at the daily relisting. In a
//   person's own drive the person owns every item, so this needs an admin
//   to take the drive's ownership away.
// - A folder that moves changes the readers its files inherit; it comes
//   without a `shared` facet when it inherits, and its files don't come
//   ("renaming a folder doesn't result in any descendants of the folder
//   being returned"): at most a day stale.
// - Whether Graph honours `deltaExcludeParent`. If not, the parents of
//   changed files come in the feed too; only an empty sharing facet on
//   one relists the drive, at most once per listing.
// - That a delta token read again answers the same entries in the same
//   order, less those changed since, which moved to later. A page that
//   stopped part-way goes on after the last entry it handled, matched by
//   ID and eTag; when that entry isn't there as it was, the page is read
//   from its top again. Reading an entry twice is harmless; skipping one
//   would not be.
// - How long a delta token Graph hands out is. The cursor holds it in
//   base64url, and a cursor is at most 2,048 characters; one past that
//   fails the page rather than cutting the token.

const drive = "/me/drive";
const delta = `${drive}/root/delta`;

/** The requests a page sends besides its entries': the drive, the feed. */
const requestsPerPage = 2;

/** The requests one entry may send: its permissions, its content. */
const requestsPerEntry = 2;

/**
 * Entries asked of Graph per page of the feed (`$top`, which delta takes):
 * no more than one of our pages can send both requests for, within what a
 * page may send (`syncPageLimits.requests`), so only a page's content or
 * its time ever ends it inside Graph's page.
 */
const graphPageSize = Math.floor(
  (syncPageLimits.requests - requestsPerPage) / requestsPerEntry
);

/** The content type of a file Graph names none for. */
const unknownType = "application/octet-stream";

const identitySchema = z.object({ id: z.string().min(1).nullish() }).nullish();

/** A sharePointIdentitySet: who a permission is granted to. */
const grantedSchema = z
  .object({ user: identitySchema, group: identitySchema })
  .nullish();

/**
 * One permission of an item
 * (https://learn.microsoft.com/en-us/graph/api/resources/permission?view=graph-rest-1.0).
 */
const permissionSchema = z.object({
  grantedToV2: grantedSchema,
  grantedToIdentitiesV2: z.array(grantedSchema).nullish(),
  link: z.object({ scope: z.string().nullish() }).nullish(),
});
type Permission = z.infer<typeof permissionSchema>;

const permissionsSchema = z.object({
  value: z.array(permissionSchema),
  "@odata.nextLink": z.string().optional(),
});

/**
 * The person's drive: its ID, its owner's Entra object ID, and whether it
 * is a personal account's (`personal`), which has no timestamp tokens.
 */
const driveSchema = z.object({
  id: z.string().min(1),
  driveType: z.string().nullish(),
  owner: z.object({ user: z.object({ id: z.string().min(1) }) }),
});

/**
 * One entry of the delta feed: an item as it now is, or deleted
 * (https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0).
 * OneDrive for Business leaves out `cTag` and, for a deletion, `name`.
 */
const entrySchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  eTag: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  size: z.number().int().nonnegative().nullish(),
  file: z.object({ mimeType: z.string().nullish() }).nullish(),
  deleted: z.unknown().optional(),
  remoteItem: z.unknown().optional(),
  folder: z.unknown().optional(),
  root: z.unknown().optional(),
  shared: z.unknown().optional(),
  parentReference: z.object({ driveId: z.string().nullish() }).nullish(),
  lastModifiedBy: z.object({ user: identitySchema }).nullish(),
});
type Entry = z.infer<typeof entrySchema>;

const entryFields =
  "id,name,eTag,lastModifiedDateTime,size,file,folder,root,shared,deleted,remoteItem,parentReference,lastModifiedBy";

const feedSchema = z.object({
  value: z.array(entrySchema),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

/** An entry a page stopped after: by its ID and eTag. */
interface Handled {
  id: string;
  eTag: string;
}

/**
 * How a round of changes treats a folder unshared: `watch` relists the
 * drive at the round's end (`pending` from then on), and while one is
 * pending or its listing's catch-up is under way (`quiet`), another is
 * left to the daily relisting.
 */
type Mode = "watch" | "pending" | "quiet";

const modes: Readonly<Record<string, Mode>> = {
  w: "watch",
  p: "pending",
  q: "quiet",
};

/**
 * Where a read is: listing the drive, with the delta token to read from
 * (none: from the start), when the listing began, as Graph's clock said,
 * and whether it is a relisting; or reading its changes from a token, in
 * a mode. Either way, the entry of that token's page already handled.
 */
type Position =
  | {
      phase: "list";
      token: string | null;
      began: string | null;
      relist: boolean;
      after: Handled | null;
    }
  | { phase: "changes"; token: string; mode: Mode; after: Handled | null };

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

/**
 * The cursor of a position: `l.<token>.<began>.<r|n>` while listing (a
 * relisting or not), `c.<token>.<w|p|q>` after (its mode), and, inside a
 * page, `.<id>.<eTag>`.
 */
const cursorOf = (position: Position): string => {
  const at =
    position.phase === "list"
      ? `l.${encode(position.token ?? "")}.${encode(position.began ?? "")}.${position.relist ? "r" : "n"}`
      : `c.${encode(position.token)}.${position.mode.charAt(0)}`;
  const { after } = position;
  return after === null
    ? at
    : `${at}.${encode(after.id)}.${encode(after.eTag)}`;
};

/** The entry handled, from a cursor's last two parts, if it has them. */
const handledOf = (parts: readonly string[]): Handled | null => {
  if (parts.length === 0) {
    return null;
  }
  const [id = "", eTag, ...rest] = parts;
  if (id === "" || eTag === undefined || rest.length > 0) {
    throw notOurs();
  }
  return { id: decode(id), eTag: decode(eTag) };
};

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, token, ...rest] = cursor.split(".");
  if (phase === "l" && token !== undefined) {
    const [began, relist, ...handled] = rest;
    if (relist !== "r" && relist !== "n") {
      throw notOurs();
    }
    const decoded = decode(token);
    const since = decode(began ?? "");
    return {
      phase: "list",
      token: decoded === "" ? null : decoded,
      began: since === "" ? null : since,
      relist: relist === "r",
      after: handledOf(handled),
    };
  }
  if (phase === "c" && token !== undefined) {
    const [flag = "", ...handled] = rest;
    const decoded = decode(token);
    const mode = Object.hasOwn(modes, flag) ? modes[flag] : undefined;
    if (decoded === "" || mode === undefined) {
      throw notOurs();
    }
    return {
      phase: "changes",
      token: decoded,
      mode,
      after: handledOf(handled),
    };
  }
  throw notOurs();
};

/**
 * The delta token a link Graph handed back carries, in each form Graph
 * writes it: `delta(token='…')`, `delta(token=…)` and `delta?(token='…')`
 * (the delta page's own examples), or `?token=…`. The link itself is never
 * followed.
 */
const quotedToken = /\(token='?(?<token>[^')]+)'?\)/u;

export const tokenOf = (link: string): string => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ToolError("Graph's delta link isn't a URL", { code: "failed" });
  }
  const token =
    quotedToken.exec(decodeURIComponent(url.href))?.groups?.token ??
    url.searchParams.get("token") ??
    undefined;
  if (url.hostname !== graphHost || token === undefined || token === "") {
    throw new ToolError("Graph's delta link has no token", { code: "failed" });
  }
  return token;
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
   * Whether no entry is handled yet: the page's first takes a file late
   * past the deadline without its content, so every read moves on; any
   * later one is left to the next page.
   */
  first: boolean;
}

/**
 * A GET to Graph, its whole answer read before the page's deadline (the
 * kit's `fetchBefore`): "late" when the deadline cut it off.
 */
const get = async (
  room: Room,
  url: URL,
  init: Pick<RequestInit, "headers"> = {}
): Promise<Response | "late"> => {
  room.requests -= 1;
  return await fetchBefore(url, room.deadline, init);
};

/**
 * What a read the page can't go without (the drive, the feed) stands for
 * when it is late: Graph is slow, and the page waits as for a rate limit.
 */
const tooSlow = (): ToolError =>
  new ToolError("Microsoft 365 didn't answer in time", {
    code: "unavailable",
  });

/** Graph's JSON answer to a GET that must succeed. */
const getJson = async <Schema extends z.ZodType>(
  room: Room,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  const response = await get(room, url);
  if (response === "late") {
    throw tooSlow();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return schema.parse(await response.json());
};

/** Whether Graph refused an item (403) or no longer has it (404). */
const isUnreadable = (response: Response): boolean =>
  response.status === 403 || response.status === 404;

/** Graph's own time of an answer (its `Date` header), as a timestamp token. */
export const timeOf = (response: Response): string => {
  const time = Date.parse(response.headers.get("date") ?? "");
  if (Number.isNaN(time)) {
    throw new ToolError("Graph's answer has no Date", { code: "failed" });
  }
  // Whole seconds, as the delta page's own example writes it.
  return new Date(time).toISOString().replace(/\.\d+Z$/u, "Z");
};

/**
 * One page of the delta feed from `token`, and Graph's time of it. A token
 * Graph no longer knows answers 410 with a resync code: the drive is
 * listed again from the start (core compares, as Microsoft asks). A 404
 * to a token is the same; to the first listing, the drive isn't there (a
 * person without a OneDrive licence), which is a failure.
 */
const feedPage = async (room: Room, token: string | null) => {
  const response = await get(
    room,
    graphUrl(delta, {
      token: token ?? undefined,
      $select: entryFields,
      $top: String(graphPageSize),
    }),
    {
      headers: {
        // Sharing information for the roots of permission hierarchies and
        // "items that explicitly have sharing changes", and no parents of
        // changed items (driveitem-delta).
        prefer: "hierarchicalsharing",
        deltaExcludeParent: "true",
      },
    }
  );
  if (response === "late") {
    throw tooSlow();
  }
  if (response.status === 410 || (response.status === 404 && token !== null)) {
    throw new RestartSyncError();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return {
    time: timeOf(response),
    feed: feedSchema.parse(await response.json()),
  };
};

/** A Graph ID as a reader's: Entra object IDs are GUIDs, in lower case. */
const idOf = (identity: z.infer<typeof identitySchema>): string | null =>
  identity?.id?.toLowerCase() ?? null;

/** The readers one grantee stands for: an account, a group, or nobody. */
const granteeReaders = (
  granted: z.infer<typeof grantedSchema>
): SyncReader[] => {
  const user = idOf(granted?.user);
  if (user !== null) {
    return [{ kind: "account", id: user }];
  }
  const group = idOf(granted?.group);
  // A group's members are core's to know (GRA-1761, PR K). A SharePoint
  // site user without an Entra user, a site group (an ID unique only in
  // its site) and an app are nobody here.
  return group === null ? [] : [{ kind: "group", id: group }];
};

/**
 * The readers one permission stands for
 * (https://learn.microsoft.com/en-us/graph/api/resources/sharinglink?view=graph-rest-1.0):
 * a link for anyone (`anonymous`) or for the organisation
 * (`organization`), or of a scope not named, is a `link`, which counts for
 * nobody; a link for specific people (`users`) is those people; a link
 * that gives only those who already have access (`existingAccess`) adds
 * nobody. Anything else is who it's granted to. An invitation nobody has
 * redeemed is granted to nobody yet.
 */
const permissionReaders = (permission: Permission): SyncReader[] => {
  const scope = permission.link?.scope ?? null;
  if (permission.link !== null && permission.link !== undefined) {
    if (scope === "existingAccess") {
      return [];
    }
    if (scope !== "users") {
      return [{ kind: "link" }];
    }
  }
  return [
    permission.grantedToV2,
    ...(permission.grantedToIdentitiesV2 ?? []),
  ].flatMap(granteeReaders);
};

/** Readers, each once, in one order: the same list gives the same version. */
const settled = (readers: SyncReader[]): SyncReader[] => {
  const byKey = new Map(
    readers.map((reader) => [JSON.stringify(reader), reader])
  );
  return [...byKey.keys()].toSorted().flatMap((key) => {
    const reader = byKey.get(key);
    return reader === undefined ? [] : [reader];
  });
};

/**
 * Who may open an item: its owner and every permission's readers; null
 * when Graph pages them (not documented), since a list read in part is
 * never guessed; "gone" when Graph refuses them or no longer has the item;
 * "late" when the page's deadline cut the read off.
 * https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0
 */
const readersOf = async (
  room: Room,
  owner: string,
  id: string
): Promise<SyncReader[] | null | "gone" | "late"> => {
  const response = await get(
    room,
    graphUrl(`${drive}/items/${segment(id)}/permissions`)
  );
  if (response === "late") {
    return "late";
  }
  if (isUnreadable(response)) {
    return "gone";
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const permissions = permissionsSchema.parse(await response.json());
  if (permissions["@odata.nextLink"] !== undefined) {
    return null;
  }
  return settled([
    { kind: "account", id: owner },
    ...permissions.value.flatMap(permissionReaders),
  ]);
};

/** What a content read found: content, none to read, the item gone, or no room. */
type Read = { content: SyncContent | null } | "gone" | "full";

/** JSON bytes of `content` in a page. */
const sizeOf = (content: SyncContent): number =>
  new TextEncoder().encode(JSON.stringify(content)).byteLength;

/** Whether the page has taken no content yet: it takes any file. */
const isEmpty = (room: Room): boolean =>
  room.bytes === syncPageLimits.contentBytes;

/**
 * No room left for an entry's content: the page stops before it, or, if
 * it holds nothing yet, takes it without its content, so every read moves
 * on.
 */
const noRoom = (room: Room): Read =>
  isEmpty(room) ? { content: null } : "full";

/**
 * Past the page's deadline before a file's content came: the page's first
 * entry comes without it, any later one is left to the next page.
 */
const late = (room: Room): Read => (room.first ? { content: null } : "full");

/** Whether a file of `size` bytes may fit what's left of the page. */
const mayFit = (room: Room, size: number): boolean =>
  // Base64 is a third larger than the bytes.
  isEmpty(room) || (size * 4) / 3 <= room.bytes;

/**
 * A file's bytes, for core's extractor, if the page has room. Graph
 * answers with a redirect to the file on SharePoint, which connect's
 * egress follows without the token.
 * https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
 */
const contentOf = async (room: Room, entry: Entry): Promise<Read> => {
  const size = entry.size ?? 0;
  // Nothing in it, or larger than a read takes: nothing to read here.
  if (size === 0 || size > maxReadBytes) {
    return { content: null };
  }
  if (Date.now() >= room.deadline) {
    return late(room);
  }
  const response = await get(
    room,
    graphUrl(`${drive}/items/${segment(entry.id)}/content`)
  );
  if (response === "late") {
    return late(room);
  }
  if (isUnreadable(response)) {
    return "gone";
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxReadBytes) {
    return { content: null };
  }
  const content: SyncContent = {
    type: "file",
    contentType: entry.file?.mimeType ?? unknownType,
    base64: toBase64(bytes),
  };
  const used = sizeOf(content);
  if (used > room.bytes) {
    return noRoom(room);
  }
  room.bytes -= used;
  return { content };
};

/** The SHA-256 of `text`, in hex. */
const digestOf = async (text: string): Promise<string> => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const goneOf = (id: string): SyncItem => ({ gone: true, id, kind: "file" });

/** The drive a page reads: its ID and its owner. */
type Drive = z.infer<typeof driveSchema>;

/**
 * Whether an entry went away for this connection: deleted, or not the
 * person's own (a shortcut to someone else's item, `remoteItem`, or an
 * item of another drive), so their connection doesn't sync it.
 */
const isGone = (own: Drive, entry: Entry): boolean => {
  const elsewhere =
    (entry.parentReference?.driveId ?? own.id).toLowerCase() !==
    own.id.toLowerCase();
  return (
    (entry.deleted !== undefined && entry.deleted !== null) ||
    (entry.remoteItem !== undefined && entry.remoteItem !== null) ||
    elsewhere
  );
};

/**
 * The item an entry now is: a file with its readers and content, gone, or
 * nothing (a folder, the root, a OneNote notebook); "full" when the page
 * has no room left for it.
 */
const itemOf = async (
  room: Room,
  own: Drive,
  entry: Entry
): Promise<SyncItem | null | "full"> => {
  if (isGone(own, entry)) {
    return goneOf(entry.id);
  }
  if (entry.file === null || entry.file === undefined) {
    return null;
  }
  if (room.requests < requestsPerEntry || !mayFit(room, entry.size ?? 0)) {
    return "full";
  }
  const eTag = entry.eTag ?? "";
  const changedAt = entry.lastModifiedDateTime ?? "";
  if (eTag === "" || changedAt === "") {
    throw new ToolError("Graph's file has no eTag or change time", {
      code: "failed",
    });
  }
  const readers = await readersOf(
    room,
    own.owner.user.id.toLowerCase(),
    entry.id
  );
  if (readers === "gone") {
    return goneOf(entry.id);
  }
  if (readers === "late") {
    // Left to the next page; as the page's first, its readers can't be
    // confirmed and it can't hold the sync: it goes away, and comes back
    // when it next changes or at the daily relisting.
    return room.first ? goneOf(entry.id) : "full";
  }
  const read = await contentOf(room, entry);
  if (read === "full") {
    return "full";
  }
  if (read === "gone") {
    return goneOf(entry.id);
  }
  return {
    gone: false,
    id: entry.id,
    kind: "file",
    // Its eTag and its readers: either changing is a new version.
    version: `${eTag} ${await digestOf(JSON.stringify(readers))}`,
    changedAt,
    title: entry.name ?? "",
    content: read.content,
    readers,
    changedBy: idOf(entry.lastModifiedBy?.user),
    partOf: null,
  };
};

/** Where in Graph's page to go on: after `after`, or at its top. */
const startOf = (entries: readonly Entry[], after: Handled | null): number => {
  if (after === null) {
    return 0;
  }
  const index = entries.findIndex(
    ({ id, eTag }) => id === after.id && (eTag ?? "") === after.eTag
  );
  return index + 1;
};

/**
 * The last of each item's entries: "The same item may appear more than
 * once in a delta feed … You should use the last occurrence you see."
 */
const lastOfEach = (items: readonly SyncItem[]): SyncItem[] => {
  const last = new Map(items.map((item, index) => [item.id, index]));
  return items.filter((item, index) => last.get(item.id) === index);
};

/**
 * Whether an entry says a folder was unshared: a folder, not the drive's
 * root, with an empty `shared` facet (see above).
 */
const isUnsharedFolder = (entry: Entry): boolean =>
  entry.folder !== undefined &&
  entry.folder !== null &&
  (entry.root === undefined || entry.root === null) &&
  typeof entry.shared === "object" &&
  entry.shared !== null &&
  Object.keys(entry.shared).length === 0;

/**
 * Where the feed goes on once Graph's page is done: its next page, or,
 * after the listing, from when the listing began (a personal account's
 * drive: from the listing's delta link), or, after changes, from the
 * delta link.
 */
const nextOf = (
  position: Position,
  own: Drive,
  feed: z.infer<typeof feedSchema>,
  began: string | null
): { position: Position; more: boolean } => {
  const next = feed["@odata.nextLink"];
  if (next !== undefined) {
    return {
      position: { ...position, token: tokenOf(next), after: null },
      more: true,
    };
  }
  const end = feed["@odata.deltaLink"];
  if (end === undefined) {
    throw new ToolError("Graph's delta page has no link on", {
      code: "failed",
    });
  }
  if (position.phase === "list" && own.driveType !== "personal") {
    return {
      position: {
        phase: "changes",
        token: began ?? "",
        mode: position.relist ? "quiet" : "watch",
        after: null,
      },
      more: true,
    };
  }
  if (position.phase === "changes" && position.mode === "pending") {
    // The round read to its end: the drive is listed again.
    return {
      position: {
        phase: "list",
        token: null,
        began: null,
        relist: true,
        after: null,
      },
      more: true,
    };
  }
  return {
    position: {
      phase: "changes",
      token: tokenOf(end),
      mode: "watch",
      after: null,
    },
    more: false,
  };
};

/** One page of the person's own drive from `position` on. */
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
  // https://learn.microsoft.com/en-us/graph/api/drive-get?view=graph-rest-1.0
  const own = await getJson(
    room,
    graphUrl(drive, { $select: "id,driveType,owner" }),
    driveSchema
  );
  const { time, feed } = await feedPage(room, position.token);
  const entries = feed.value;
  // The listing began with its first page: Graph's time of that.
  const began = position.phase === "list" ? (position.began ?? time) : null;
  const here: Position =
    position.phase === "list"
      ? { ...position, began }
      : {
          ...position,
          mode:
            position.mode === "watch" && entries.some(isUnsharedFolder)
              ? "pending"
              : position.mode,
        };
  const start = startOf(entries, position.after);
  const items: SyncItem[] = [];
  let handled: Entry | null = null;
  for (const entry of entries.slice(start)) {
    // A page takes at least one entry, so every read moves on.
    if (handled !== null && Date.now() >= room.deadline) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one entry after another, within the page's room
    const item = await itemOf(room, own, entry);
    if (item === "full") {
      break;
    }
    if (item !== null) {
      items.push(item);
    }
    handled = entry;
    room.first = false;
  }
  const done = handled === null ? start : entries.indexOf(handled) + 1;
  if (done < entries.length) {
    return {
      items: lastOfEach(items),
      cursor: cursorOf(
        handled === null
          ? here
          : { ...here, after: { id: handled.id, eTag: handled.eTag ?? "" } }
      ),
      more: true,
    };
  }
  const next = nextOf(here, own, feed, began);
  return {
    items: lastOfEach(items),
    cursor: cursorOf(next.position),
    more: next.more,
  };
};

/** The person's own OneDrive: every file in it, its changes and its readers. */
export const onedriveSync = defineSync({
  name: "drive",
  kind: "file",
  routes: [
    { method: "GET", host: graphHost, path: `${v1}${drive}` },
    { method: "GET", host: graphHost, path: `${v1}${delta}` },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${drive}/items/{item}/permissions`,
    },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${drive}/items/{item}/content`,
      redirects: downloadHosts,
    },
  ],
  read: async ({ place, cursor, deadline }) => {
    if (place !== ownPlace) {
      // SharePoint sites and picked folders come with picks (PR J).
      throw new ToolError("This sync reads the person's own OneDrive only", {
        code: "failed",
      });
    }
    return await readPage(
      cursor === null
        ? {
            phase: "list",
            token: null,
            began: null,
            relist: false,
            after: null,
          }
        : positionOf(cursor),
      deadline
    );
  },
});
