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
// whole drive), then from the token of its last link
// (https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0).
// Graph's `@odata.nextLink` and `@odata.deltaLink` are never followed:
// only their `token` is kept, and every request is built here, on the
// sync's own routes.
//
// What goes away: an entry with the `deleted` facet; an entry that isn't
// the person's own (a shortcut to someone else's item, `remoteItem`, or
// one in another drive); and an item whose permissions or content Graph
// refuses (403) or no longer has (404): an item that can't be confirmed
// readable goes away. A token Graph no longer knows (410, `resyncRequired`
// and the `resyncChanges…` codes) lists the drive again from the start.
//
// Readers are re-read from the item's own permissions every time it comes
// in the feed, never taken from delta's `sharing` facet, and a file's
// version includes them, so changed readers are always a new version,
// whether or not Graph's eTag moves with them.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft):
// - Whether a change to an item's sharing alone puts it in the delta feed.
//   Microsoft documents a marker for sharing changes only with
//   `Prefer: deltashowsharingchanges`, which needs `Sites.FullControl.All`,
//   which we don't ask for. We send `Prefer: hierarchicalsharing`, under
//   which Microsoft says sharing information comes for "items that
//   explicitly have sharing changes"; whether such an item comes at all
//   when nothing else of it changed is not stated. If it doesn't, an
//   unshared file keeps its old readers until it next changes.
// - How an item the account lost access to shows in the feed (a `deleted`
//   facet, or nothing). If nothing, it is never reported gone here. In a
//   person's own drive the person owns every item, so this needs an admin
//   to take the drive's ownership away.
// - Microsoft documents that descendants don't come in the feed when a
//   folder is renamed ("renaming a folder doesn't result in any
//   descendants of the folder being returned"). The same is likely for a
//   folder that moves or whose sharing changes, which changes the readers
//   its files inherit, unseen until each file next changes.
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

/** The person's drive: its ID, and its owner's Entra object ID. */
const driveSchema = z.object({
  id: z.string().min(1),
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
  parentReference: z.object({ driveId: z.string().nullish() }).nullish(),
  lastModifiedBy: z.object({ user: identitySchema }).nullish(),
});
type Entry = z.infer<typeof entrySchema>;

const entryFields =
  "id,name,eTag,lastModifiedDateTime,size,file,deleted,remoteItem,parentReference,lastModifiedBy";

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
 * Where a read is: the delta token to read from (none: the whole drive
 * from the start), and the entry of that token's page already handled.
 */
interface Position {
  token: string | null;
  after: Handled | null;
}

const base64url = /^[\w-]*$/u;

const encode = (value: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decode = (value: string): string => {
  if (!base64url.test(value)) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0)
    );
  } catch {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
};

/** The cursor of a position: `d.<token>` and, inside a page, `.<id>.<eTag>`. */
const cursorOf = ({ token, after }: Position): string => {
  const at = `d.${encode(token ?? "")}`;
  return after === null
    ? at
    : `${at}.${encode(after.id)}.${encode(after.eTag)}`;
};

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [tag, token, id, eTag, ...rest] = cursor.split(".");
  if (tag !== "d" || token === undefined || rest.length > 0) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  const decoded = decode(token);
  const at = decoded === "" ? null : decoded;
  if (id === undefined && eTag === undefined) {
    return { token: at, after: null };
  }
  if (id === undefined || eTag === undefined || id === "") {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  return { token: at, after: { id: decode(id), eTag: decode(eTag) } };
};

/**
 * The delta token a link Graph handed back carries, in either form Graph
 * writes it: `?token=…`, or `delta(token='…')`. The link itself is never
 * followed.
 */
const tokenOf = (link: string): string => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ToolError("Graph's delta link isn't a URL", { code: "failed" });
  }
  const token =
    url.searchParams.get("token") ??
    /token='(?<token>[^']+)'/u.exec(decodeURIComponent(url.pathname))?.groups
      ?.token;
  if (url.hostname !== graphHost || token === undefined || token === "") {
    throw new ToolError("Graph's delta link has no token", { code: "failed" });
  }
  return token;
};

/** What a page has left: requests, content bytes, and when it stops filling. */
interface Room {
  requests: number;
  bytes: number;
  until: number;
}

/** A GET to Graph: its answer, or the ToolError a failure stands for. */
const get = async (
  room: Room,
  url: URL,
  init?: RequestInit
): Promise<Response> => {
  room.requests -= 1;
  return await fetch(url, init);
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
 * One page of the delta feed from `token`. A token Graph no longer knows
 * answers 410 with a resync code: the drive is listed again from the
 * start (core compares, as Microsoft asks). A 404 to a token is the same;
 * to the first listing, the drive isn't there (a person without a
 * OneDrive licence), which is a failure.
 */
const feedPage = async (room: Room, token: string | null) => {
  const response = await get(
    room,
    graphUrl(delta, {
      token: token ?? undefined,
      $select: entryFields,
      $top: String(graphPageSize),
    }),
    // Sharing information for "items that explicitly have sharing
    // changes" (driveitem-delta, "Scanning permissions hierarchies").
    { headers: { prefer: "hierarchicalsharing" } }
  );
  if (response.status === 410 || (response.status === 404 && token !== null)) {
    await response.body?.cancel();
    throw new RestartSyncError();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return feedSchema.parse(await response.json());
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
 * never guessed; "gone" when Graph refuses them or no longer has the item.
 * https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0
 */
const readersOf = async (
  room: Room,
  owner: string,
  id: string
): Promise<SyncReader[] | null | "gone"> => {
  const response = await get(
    room,
    graphUrl(`${drive}/items/${segment(id)}/permissions`)
  );
  if (isUnreadable(response)) {
    await response.body?.cancel();
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
  const response = await get(
    room,
    graphUrl(`${drive}/items/${segment(entry.id)}/content`)
  );
  if (isUnreadable(response)) {
    await response.body?.cancel();
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
    return isEmpty(room) ? { content: null } : "full";
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

/** One page of the person's own drive from `position` on. */
const readPage = async (position: Position): Promise<SyncPage> => {
  const room: Room = {
    requests: syncPageLimits.requests,
    bytes: syncPageLimits.contentBytes,
    until: Date.now() + syncPageLimits.fillMs,
  };
  // https://learn.microsoft.com/en-us/graph/api/drive-get?view=graph-rest-1.0
  const own = await getJson(
    room,
    graphUrl(drive, { $select: "id,owner" }),
    driveSchema
  );
  const feed = await feedPage(room, position.token);
  const entries = feed.value;
  const start = startOf(entries, position.after);
  const items: SyncItem[] = [];
  let handled: Entry | null = null;
  for (const entry of entries.slice(start)) {
    // A page takes at least one entry, so every read moves on.
    if (handled !== null && Date.now() >= room.until) {
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
  }
  const done = handled === null ? start : entries.indexOf(handled) + 1;
  if (done < entries.length) {
    return {
      items: lastOfEach(items),
      cursor: cursorOf(
        handled === null
          ? position
          : {
              token: position.token,
              after: { id: handled.id, eTag: handled.eTag ?? "" },
            }
      ),
      more: true,
    };
  }
  const next = feed["@odata.nextLink"];
  const end = feed["@odata.deltaLink"];
  if (next === undefined && end === undefined) {
    throw new ToolError("Graph's delta page has no link on", {
      code: "failed",
    });
  }
  return {
    items: lastOfEach(items),
    cursor: cursorOf({ token: tokenOf(next ?? end ?? ""), after: null }),
    more: next !== undefined,
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
  read: async ({ place, cursor }) => {
    if (place !== ownPlace) {
      // SharePoint sites and picked folders come with picks (PR J).
      throw new ToolError("This sync reads the person's own OneDrive only", {
        code: "failed",
      });
    }
    return await readPage(
      cursor === null ? { token: null, after: null } : positionOf(cursor)
    );
  },
});
