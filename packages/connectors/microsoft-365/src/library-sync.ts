import { ToolError } from "@grasp-os/connector-kit/connector";
import { maxReadBytes, toBase64 } from "@grasp-os/connector-kit/content";
import { tenantHost } from "@grasp-os/connector-kit/manifest";
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
  syncPageLimits,
  syncRoom,
  takeContent,
} from "@grasp-os/connector-kit/sync";
import type {
  EntryItems,
  InPage,
  SyncRoom,
} from "@grasp-os/connector-kit/sync";
import { syncPlaceSchema } from "@grasp-os/shared/sync";
import type {
  SyncChoice,
  SyncContent,
  SyncItem,
  SyncPage,
  SyncReader,
} from "@grasp-os/shared/sync";
import { z } from "zod";

import {
  atPage,
  downloadHosts,
  graphFailure,
  graphHost,
  graphUrl,
  nextPageOf,
  v1,
} from "./graph.ts";
import { timeOf, tokenOf } from "./onedrive-sync.ts";

// Native sync of a shared connection's picked SharePoint document libraries
// (GRA-1759): each library an admin picked, as a place of its own, read
// through its own driveItem delta. A shared connection never syncs the
// connected account's own OneDrive, mail or calendar (connect refuses
// those syncs on it), and this sync reads nothing under `/me`: every call
// names the picked library (`/drives/{place}`).
//
// What a place is: a drive whose `driveType` is `documentLibrary`, which
// Graph gives SharePoint's document libraries alone ("OneDrive personal
// drives return `personal`. OneDrive for Business returns `business`.
// SharePoint document libraries return `documentLibrary`",
// https://learn.microsoft.com/en-us/graph/api/resources/drive?view=graph-rest-1.0).
// Every page reads the drive first and refuses any other kind, so a pick
// that named someone's OneDrive is never read.
//
// How it reads: driveItem delta on the drive
// (https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0),
// first without a token (the whole library), then once more from when the
// listing began as a timestamp token, which the same page documents for
// OneDrive for Business and SharePoint, then from each delta link's token.
// Graph's links are never followed: only their token is kept. A token
// Graph no longer knows (410, or a 404 to a token) lists the library
// again.
//
// What goes away: an entry with the `deleted` facet, one that is a
// shortcut to another drive's item (`remoteItem`) or of another drive,
// and a file whose content Graph refuses (403) or no longer has (404).
//
// Who may read what it brings (GRA-2145): those SharePoint lets open each
// file, of whom core lets read only those the connection's Brain audience
// holds. Microsoft Graph lists an item's permissions whole to its owners
// alone ("For a non-owner caller, only the sharing permissions that apply
// to the caller are returned") and a site group's members to no one, so
// they are read from SharePoint's own REST API, on the company's host,
// with connect's token for it (`tenantHost`): the item's role assignments
// (`roleassignments`, inherited or its own), and each SharePoint group's
// users (`sitegroups/getbyid(<id>)/users`). Only someone who may manage
// the item's permissions (a site owner) may read its role assignments:
// SharePoint refuses anyone else, and a refusal, a group whose members it
// hides, a list it pages, or a host connect holds no token for (a
// connection made before the right was asked for), is nobody's. A role
// counts only if it lets someone view the library's items
// (`ViewListItems`): "Limited Access" doesn't. Sharing changed on a file
// comes with it; a change of a group's members or of a library's sharing
// reaches the file at core's daily relist (brain-sync.ts `relistMs`).
//
// Where a read stops, and where the next goes on: the kit's paging
// (`fillPage`), keyed by an entry's ID and eTag, so an entry that changed
// since, which Graph moves on, is no longer the one handled.
//
// The places to pick: the SharePoint sites the account can find
// (`GET /sites?search=*`, https://learn.microsoft.com/en-us/graph/api/site-search?view=graph-rest-1.0),
// less personal OneDrive sites, and each site's document libraries
// (`GET /sites/{id}/drives`, https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0).
// A listing too long for one read goes on after the last site it
// finished, by its ID, in Graph's page of sites, and inside a site under
// way from Graph's position in its drives: every page read is kept.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft): which
// sites `search=*` answers for a delegated account (the page says only
// that it searches "across a SharePoint tenant"); and, as for OneDrive,
// that a delta token read again answers the same entries in the same
// order.

const drives = "/drives";
const libraryType = "documentLibrary";

/** SharePoint REST's JSON without its metadata. */
const restJson = { accept: "application/json;odata=nometadata" };

/**
 * SharePoint's `ViewListItems`, the lowest bit of `BasePermissions.Low`
 * (https://learn.microsoft.com/en-us/previous-versions/office/sharepoint-csom/ee556747(v=office.15)):
 * what a role must let someone do to read a library's files.
 */
const viewListItems = 1;

/**
 * SharePoint's `EnumeratePermissions`, the 31st bit of
 * `BasePermissions.High` (same page): what reading an item's role
 * assignments takes.
 */
const enumeratePermissions = 0x40_00_00_00;

/** Whether `mask` holds `bit` (a power of two), as SharePoint's masks are read. */
const holdsBit = (mask: number, bit: number): boolean =>
  Math.floor(mask / bit) % 2 === 1;

/** The requests a page sends besides its entries': the drive, the feed. */
const requestsPerPage = 2;

/**
 * Entries asked of Graph per page of the feed (`$top`): no more than one of
 * our pages can read the content of, one request each, within what a page
 * may send (`syncPageLimits.requests`).
 */
const graphPageSize = syncPageLimits.requests - requestsPerPage;

/** The content type of a file Graph names none for. */
const unknownType = "application/octet-stream";

const librarySchema = z.object({
  id: z.string().min(1),
  driveType: z.string().nullish(),
});

/**
 * One entry of the delta feed
 * (https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0).
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
  lastModifiedBy: z
    .object({ user: z.object({ id: z.string().nullish() }).nullish() })
    .nullish(),
  /** Where SharePoint keeps the file: its site, list and list item. */
  sharepointIds: z
    .object({
      siteUrl: z.string().nullish(),
      listId: z.string().nullish(),
      listItemId: z.string().nullish(),
    })
    .nullish(),
});
type Entry = z.infer<typeof entrySchema>;

const entryFields =
  "id,name,eTag,lastModifiedDateTime,size,file,deleted,remoteItem,parentReference,lastModifiedBy,sharepointIds";

const feedSchema = z.object({
  value: z.array(entrySchema),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

/**
 * Where a read is: listing the library from a delta token (none: from the
 * start) and when the listing began, as Graph's clock said; or reading its
 * changes from a token. Either way, where in that token's page.
 */
type Position =
  | { phase: "list"; token: string | null; began: string | null; at: InPage }
  | { phase: "changes"; token: string; at: InPage };

const notOurs = (): RestartSyncError =>
  new RestartSyncError("Not a cursor this sync wrote");

const cursorOf = (position: Position): string =>
  position.phase === "list"
    ? `l.${cursorPart(position.token)}.${cursorPart(position.began)}.${inPagePart(position.at)}`
    : `c.${cursorPart(position.token)}.${inPagePart(position.at)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, ...parts] = cursor.split(".");
  if (phase === "l" && parts.length === 3) {
    return {
      phase: "list",
      token: fromCursorPart(parts[0]),
      began: fromCursorPart(parts[1]),
      at: fromInPagePart(parts[2]),
    };
  }
  if (phase === "c" && parts.length === 2) {
    const token = fromCursorPart(parts[0]);
    if (token !== null) {
      return { phase: "changes", token, at: fromInPagePart(parts[1]) };
    }
  }
  throw notOurs();
};

/** What a read the page can't go without stands for when it is late. */
const tooSlow = (): ToolError =>
  new ToolError("Microsoft 365 didn't answer in time", {
    code: "unavailable",
  });

/**
 * That `place` is a document library the account can open: its drive,
 * of the library kind. Anything else fails the read before any of it is
 * asked for. https://learn.microsoft.com/en-us/graph/api/drive-get?view=graph-rest-1.0
 */
const requireLibrary = async (room: SyncRoom, place: string): Promise<void> => {
  const response = await fetchInRoom(
    room,
    graphUrl(`${drives}/${segment(place)}`, { $select: "id,driveType" })
  );
  if (response === "late") {
    throw tooSlow();
  }
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    throw new ToolError("No such document library for this account", {
      code: "failed",
    });
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const library = librarySchema.parse(await response.json());
  if (library.id !== place || library.driveType !== libraryType) {
    throw new ToolError("Not a SharePoint document library", {
      code: "failed",
    });
  }
};

/** One page of the library's delta feed from `token`, and Graph's time of it. */
const feedPage = async (
  room: SyncRoom,
  place: string,
  token: string | null
) => {
  const response = await fetchInRoom(
    room,
    graphUrl(`${drives}/${segment(place)}/root/delta`, {
      token: token ?? undefined,
      $select: entryFields,
      $top: String(graphPageSize),
    })
  );
  if (response === "late") {
    throw tooSlow();
  }
  if (response.status === 410 || (response.status === 404 && token !== null)) {
    await response.body?.cancel();
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

/**
 * A SharePoint principal as a role assignment or a group's users name it
 * (`SP.Principal`): its ID in the site, its claim (`LoginName`), its
 * kind, and, for a user, their Entra object ID.
 */
const principalSchema = z.object({
  Id: z.number().int(),
  LoginName: z.string(),
  PrincipalType: z.number().int(),
  AadObjectId: z.object({ NameId: z.string().nullish() }).nullish(),
});
type Principal = z.infer<typeof principalSchema>;

/** `SP.BasePermissions`: two 32-bit masks, as numbers or strings. */
const basePermissionsSchema = z.object({
  Low: z.coerce.number().int(),
  High: z.coerce.number().int(),
});

const roleAssignmentsSchema = z.object({
  value: z.array(
    z.object({
      Member: principalSchema,
      RoleDefinitionBindings: z.array(
        z.object({ BasePermissions: basePermissionsSchema })
      ),
    })
  ),
  "odata.nextLink": z.string().optional(),
});

const usersSchema = z.object({
  value: z.array(principalSchema),
  "odata.nextLink": z.string().optional(),
});

/** `SP.PrincipalType`: a SharePoint group, whose users are read apart. */
const sharePointGroupType = 8;

const guid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const guidPattern = new RegExp(`^${guid}$`, "iu");
/** "Everyone except external users": the company's tenant. */
const everyoneButGuests = new RegExp(
  `^c:0-\\.f\\|rolemanager\\|spo-grid-all-users/(${guid})$`,
  "iu"
);
/** An Entra security group. */
const securityGroup = new RegExp(`^c:0t\\.c\\|tenant\\|(${guid})$`, "iu");
/** A Microsoft 365 group's members (its owners end in `_o`: nobody here). */
const groupMembers = new RegExp(
  `^c:0o\\.c\\|federateddirectoryclaimprovider\\|(${guid})$`,
  "iu"
);
/** "Everyone", guests and anyone signed in with them: a link's reach. */
const everyone = "c:0(.s|true";
/** A sharing link's group for the organisation or anyone: a link. */
const linkGroup = /^SharingLinks\.[^.]+\.(?:Organization|Anonymous)/iu;
const listItemIdPattern = /^\d+$/u;

/**
 * The readers a user or a group a SharePoint group can hold stands for:
 * a user by their Entra object ID; an Entra group or a Microsoft 365
 * group's members by its object ID; everyone in the company but guests as
 * the tenant; everyone as a link, which counts for nobody; anyone else
 * (a user without an Entra object ID, a group's owners) nobody.
 */
const memberReaders = ({ LoginName, AadObjectId }: Principal): SyncReader[] => {
  const user = AadObjectId?.NameId ?? "";
  if (LoginName.startsWith("i:0#.f|membership|")) {
    return guidPattern.test(user)
      ? [{ kind: "account", id: user.toLowerCase() }]
      : [];
  }
  const tenant = everyoneButGuests.exec(LoginName)?.[1];
  if (tenant !== undefined) {
    return [{ kind: "tenant", id: tenant.toLowerCase() }];
  }
  const group =
    securityGroup.exec(LoginName)?.[1] ?? groupMembers.exec(LoginName)?.[1];
  if (group !== undefined) {
    return [{ kind: "group", id: group.toLowerCase() }];
  }
  return LoginName.toLowerCase() === everyone ? [{ kind: "link" }] : [];
};

/** The REST API's URL for `path` under `site`'s web. */
const restUrl = (site: URL, path: string, query = {}): URL => {
  const url = new URL(
    `${site.pathname.replace(/\/$/u, "")}/_api/web/${path}`,
    site.origin
  );
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url;
};

/**
 * One GET of SharePoint's REST API on the company's host: its answer, or
 * null when it was refused (by SharePoint, or by connect's egress, which
 * holds no token for the host) or isn't what `schema` reads, or "late". A
 * throttled or failing SharePoint fails the page, which waits.
 */
const restGet = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema> | null | "late"> => {
  if (!mayRequest(room)) {
    return "late";
  }
  const response = await fetchInRoom(room, url, { headers: restJson });
  if (response === "late") {
    return "late";
  }
  if (response.status === 429 || response.status >= 500) {
    throw await graphFailure(response);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return schema.safeParse(await response.json()).data ?? null;
};

/**
 * A SharePoint group's readers, read once a page (`groups`): its users,
 * or a link for a sharing link's group for the organisation or anyone;
 * null when SharePoint refuses or pages them.
 */
const groupReaders = async (
  room: SyncRoom,
  site: URL,
  group: Principal,
  groups: Map<string, SyncReader[] | null>
): Promise<SyncReader[] | null | "late"> => {
  if (linkGroup.test(group.LoginName)) {
    return [{ kind: "link" }];
  }
  const key = `${site.href} ${group.Id}`;
  const known = groups.get(key);
  if (known !== undefined) {
    return known;
  }
  const users = await restGet(
    room,
    restUrl(site, `sitegroups/getbyid(${group.Id})/users`),
    usersSchema
  );
  if (users === "late") {
    return "late";
  }
  const readers =
    users === null || users["odata.nextLink"] !== undefined
      ? null
      : users.value.flatMap(memberReaders);
  groups.set(key, readers);
  return readers;
};

/**
 * Who may open `entry`, as SharePoint's role assignments of its list item
 * say, each SharePoint group's users read too: null when any of it can't
 * be read whole; "late" when the page has no room left for it.
 */
const readersOf = async (
  room: SyncRoom,
  entry: Entry,
  groups: Map<string, SyncReader[] | null>
): Promise<SyncReader[] | null | "late"> => {
  const site = URL.parse(entry.sharepointIds?.siteUrl ?? "");
  const list = entry.sharepointIds?.listId ?? "";
  const item = entry.sharepointIds?.listItemId ?? "";
  if (
    site?.protocol !== "https:" ||
    !guidPattern.test(list) ||
    !listItemIdPattern.test(item)
  ) {
    return null;
  }
  const assigned = await restGet(
    room,
    restUrl(site, `lists(guid'${list}')/items(${item})/roleassignments`, {
      $expand: "Member,RoleDefinitionBindings",
    }),
    roleAssignmentsSchema
  );
  if (assigned === "late" || assigned === null) {
    return assigned;
  }
  if (assigned["odata.nextLink"] !== undefined) {
    return null;
  }
  const readers: SyncReader[] = [];
  for (const { Member, RoleDefinitionBindings } of assigned.value) {
    const views = RoleDefinitionBindings.some(({ BasePermissions }) =>
      holdsBit(BasePermissions.Low, viewListItems)
    );
    if (views) {
      const found =
        Member.PrincipalType === sharePointGroupType
          ? // oxlint-disable-next-line no-await-in-loop -- within the page's room, one group at a time
            await groupReaders(room, site, Member, groups)
          : memberReaders(Member);
      if (found === "late" || found === null) {
        return found;
      }
      readers.push(...found);
    }
  }
  return [
    ...new Map(
      readers.map((reader) => [JSON.stringify(reader), reader])
    ).values(),
  ];
};

/**
 * Whether the account may read who may open the files of the site at
 * `webUrl` (`EnumeratePermissions` of its web): false when SharePoint or
 * connect's egress refuses; "late" when the read has no room left.
 */
const sharingReadOf = async (
  room: SyncRoom,
  webUrl: string
): Promise<boolean | "late"> => {
  const site = URL.parse(webUrl);
  if (site?.protocol !== "https:") {
    return false;
  }
  const answer = await restGet(
    room,
    restUrl(site, "effectiveBasePermissions"),
    basePermissionsSchema
  );
  if (answer === "late") {
    return "late";
  }
  return answer !== null && holdsBit(answer.High, enumeratePermissions);
};

const goneOf = (id: string): SyncItem => ({ gone: true, id, kind: "file" });

/** Whether an entry went away from the library: deleted, a shortcut, or another drive's. */
const isGone = (place: string, entry: Entry): boolean =>
  (entry.deleted !== undefined && entry.deleted !== null) ||
  (entry.remoteItem !== undefined && entry.remoteItem !== null) ||
  (entry.parentReference?.driveId ?? place).toLowerCase() !==
    place.toLowerCase();

/** A file as an item, with `content`, read by `readers` (null: nobody). */
const fileOf = (
  entry: Entry,
  content: SyncContent | null,
  readers: SyncReader[] | null = null
): SyncItem => {
  const eTag = entry.eTag ?? "";
  const changedAt = entry.lastModifiedDateTime ?? "";
  if (eTag === "" || changedAt === "") {
    throw new ToolError("Graph's file has no eTag or change time", {
      code: "failed",
    });
  }
  return {
    gone: false,
    id: entry.id,
    kind: "file",
    version: eTag,
    changedAt,
    title: entry.name ?? "",
    content,
    readers,
    changedBy: entry.lastModifiedBy?.user?.id?.toLowerCase() ?? null,
    partOf: null,
  };
};

/** What an entry is without reading its content: gone, nothing, or the file. */
const withoutContent = (place: string, entry: Entry): SyncItem[] => {
  if (isGone(place, entry)) {
    return [goneOf(entry.id)];
  }
  if (entry.file === null || entry.file === undefined) {
    return [];
  }
  return [fileOf(entry, null)];
};

/**
 * The item an entry now is, with the file's bytes for core's extractor
 * when the page has room. Graph answers with a redirect to the file on
 * SharePoint, which connect's egress follows without the token.
 * https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
 */
const itemsOf = async (
  room: SyncRoom,
  place: string,
  entry: Entry,
  groups: Map<string, SyncReader[] | null>
): Promise<EntryItems> => {
  const known = withoutContent(place, entry);
  if (known[0]?.gone !== false) {
    return known;
  }
  // Its readers first: an entry left for the next read loses only those.
  const readers = await readersOf(room, entry, groups);
  if (readers === "late") {
    return "late";
  }
  const size = entry.size ?? 0;
  if (size === 0 || size > maxReadBytes) {
    return [fileOf(entry, null, readers)];
  }
  // Base64 is a third larger than the bytes.
  if (!mayRequest(room) || (!room.empty && (size * 4) / 3 > room.bytes)) {
    return "full";
  }
  const response = await fetchInRoom(
    room,
    graphUrl(`${drives}/${segment(place)}/items/${segment(entry.id)}/content`)
  );
  if (response === "late") {
    return "late";
  }
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return [goneOf(entry.id)];
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxReadBytes) {
    return [fileOf(entry, null, readers)];
  }
  const taken = takeContent(room, {
    type: "file",
    contentType: entry.file?.mimeType ?? unknownType,
    base64: toBase64(bytes),
  });
  return taken === null ? "full" : [fileOf(entry, taken.content, readers)];
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
 * Where the feed goes on once Graph's page is done: its next page; after
 * the listing, from when it began, as a timestamp token; after changes,
 * from the delta link.
 */
const nextOf = (
  position: Position,
  feed: z.infer<typeof feedSchema>,
  began: string | null
): { position: Position; more: boolean } => {
  const next = feed["@odata.nextLink"];
  if (next !== undefined) {
    return {
      position: { ...position, token: tokenOf(next), at: startOfPage },
      more: true,
    };
  }
  const end = feed["@odata.deltaLink"];
  if (end === undefined) {
    throw new ToolError("Graph's delta page has no link on", {
      code: "failed",
    });
  }
  if (position.phase === "list") {
    return {
      position: { phase: "changes", token: began ?? "", at: startOfPage },
      more: true,
    };
  }
  return {
    position: { phase: "changes", token: tokenOf(end), at: startOfPage },
    more: false,
  };
};

/** One page of a picked library from `position` on. */
const readPage = async (
  place: string,
  position: Position,
  deadline: number
): Promise<SyncPage> => {
  const room = syncRoom(deadline);
  await requireLibrary(room, place);
  const { time, feed } = await feedPage(room, place, position.token);
  // The listing began with its first page: Graph's time of that.
  const began = position.phase === "list" ? (position.began ?? time) : null;
  const here: Position =
    position.phase === "list" ? { ...position, began } : position;
  // Each SharePoint group's users, read once a page.
  const groups = new Map<string, SyncReader[] | null>();
  const { items, at, done } = await fillPage({
    room,
    entries: feed.value,
    at: position.at,
    keyOf: (entry) => `${entry.id} ${entry.eTag ?? ""}`,
    itemsFor: async (entry) => await itemsOf(room, place, entry, groups),
    passOver: (entry) => withoutContent(place, entry),
  });
  if (!done) {
    return {
      items: lastOfEach(items),
      cursor: cursorOf({ ...here, at }),
      more: true,
    };
  }
  const next = nextOf(here, feed, began);
  return {
    items: lastOfEach(items),
    cursor: cursorOf(next.position),
    more: next.more,
  };
};

const siteSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  name: z.string().nullish(),
  webUrl: z.string().nullish(),
});

const sitesSchema = z.object({
  value: z.array(siteSchema),
  "@odata.nextLink": z.string().optional(),
});

const drivesSchema = z.object({
  value: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullish(),
      driveType: z.string().nullish(),
    })
  ),
  "@odata.nextLink": z.string().optional(),
});

/** Whether a site is someone's OneDrive, on the `-my` host: no place. */
const isPersonal = (site: z.infer<typeof siteSchema>): boolean =>
  site.id.split(",")[0]?.toLowerCase().endsWith("-my.sharepoint.com") === true;

/**
 * A listing's position: Graph's page of sites (`page`), the last site
 * finished in it (`after`), and the site under way, if any (`site`), with
 * Graph's position in that site's drives (`drivePage`). Every page of drives
 * read is kept at once, so a site with more drives than one read can list
 * goes on where the last read stopped, never from its start again.
 */
interface Listing {
  page: string | null;
  after: string | null;
  site: string | null;
  drivePage: string | null;
}

const listingCursor = ({ page, after, site, drivePage }: Listing): string =>
  [page, after, site, drivePage].map(cursorPart).join(".");

/** The listing a cursor this sync wrote names; any other starts it over. */
const listingOf = (cursor: string | null): Listing => {
  if (cursor === null) {
    return { page: null, after: null, site: null, drivePage: null };
  }
  const parts = cursor.split(".");
  if (parts.length !== 4) {
    throw notOurs();
  }
  const [page = null, after = null, site = null, drivePage = null] =
    parts.map(fromCursorPart);
  return { page, after, site, drivePage };
};

/** Out of room part-way through a listing. */
class OutOfRoomError extends Error {
  constructor() {
    super("Out of room part-way through a listing");
    this.name = "OutOfRoomError";
  }
}

/**
 * One GET of a listing, the only way a listing reaches Graph: within the
 * read's room, checked before the request starts, or `OutOfRoomError`,
 * which ends the read with what it found and the listing's position, so
 * no request goes out without room and no progress is lost.
 */
const listingGet = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  if (!mayRequest(room)) {
    throw new OutOfRoomError();
  }
  const response = await fetchInRoom(room, url);
  if (response === "late") {
    throw new OutOfRoomError();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return schema.parse(await response.json());
};

/** The document libraries of one page of a site's drives, as places to pick. */
const librariesIn = (
  answer: z.infer<typeof drivesSchema>,
  siteName: string,
  sharingRead: boolean
): SyncChoice[] =>
  answer.value.flatMap((library): SyncChoice[] =>
    library.driveType === libraryType &&
    syncPlaceSchema.safeParse(library.id).success
      ? [
          {
            place: library.id,
            title: library.name ?? "",
            within: siteName,
            sharingRead,
          },
        ]
      : []
  );

/**
 * Lists `site`'s document libraries into `choices`, one page of Graph's
 * at a time, from where `listing` stands in it, keeping each page's
 * libraries and position as soon as the page is read.
 */
const listSite = async (
  room: SyncRoom,
  listing: Listing,
  site: z.infer<typeof siteSchema>,
  choices: SyncChoice[]
): Promise<void> => {
  const siteName = site.displayName ?? site.name ?? "";
  if (listing.site !== site.id) {
    listing.site = site.id;
    listing.drivePage = null;
  }
  // Whether the account may read who may open the site's files: one
  // request a site, so a library whose own permissions differ is shown
  // as its site is, and its files read as SharePoint answers for each.
  const sharingRead = await sharingReadOf(room, site.webUrl ?? "");
  if (sharingRead === "late") {
    throw new OutOfRoomError();
  }
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const answer = await listingGet(
      room,
      atPage(
        graphUrl(`/sites/${segment(site.id)}/drives`, {
          $select: "id,name,driveType",
        }),
        listing.drivePage ?? undefined
      ),
      drivesSchema
    );
    choices.push(...librariesIn(answer, siteName, sharingRead));
    const next = nextPageOf(answer["@odata.nextLink"]);
    if (next === null) {
      break;
    }
    listing.drivePage = next;
  }
  listing.after = site.id;
  listing.site = null;
  listing.drivePage = null;
};

/**
 * Lists the document libraries of the SharePoint sites the account can
 * find into `choices`, from where `listing` stands, until Graph's last
 * page of sites or `OutOfRoomError`.
 */
const listSites = async (
  room: SyncRoom,
  listing: Listing,
  choices: SyncChoice[]
): Promise<void> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const sites = await listingGet(
      room,
      atPage(
        // The page documents `search` alone.
        graphUrl("/sites", { search: "*" }),
        listing.page ?? undefined
      ),
      sitesSchema
    );
    const start =
      listing.after === null
        ? 0
        : sites.value.findIndex(({ id }) => id === listing.after) + 1;
    for (const site of sites.value.slice(start)) {
      if (isPersonal(site)) {
        listing.after = site.id;
      } else {
        // oxlint-disable-next-line no-await-in-loop -- one site after another
        await listSite(room, listing, site, choices);
      }
    }
    const next = nextPageOf(sites["@odata.nextLink"]);
    if (next === null) {
      return;
    }
    listing.page = next;
    listing.after = null;
  }
};

/**
 * The document libraries of the SharePoint sites the account can find, a
 * read at a time, going on from the cursor: after the last site finished,
 * by its ID, in Graph's page of sites, and inside a site under way from
 * Graph's own position in its drives.
 */
const choicesOf = async ({
  cursor,
  deadline,
}: {
  cursor: string | null;
  deadline: number;
}): Promise<{ choices: SyncChoice[]; cursor: string | null }> => {
  const room = syncRoom(deadline);
  const listing = listingOf(cursor);
  const from = listingCursor(listing);
  const choices: SyncChoice[] = [];
  try {
    await listSites(room, listing, choices);
    return { choices, cursor: null };
  } catch (error) {
    if (!(error instanceof OutOfRoomError)) {
      throw error;
    }
  }
  const at = listingCursor(listing);
  // Nothing moved on: Graph is too slow for one read to take one page.
  if (at === from && choices.length === 0) {
    throw tooSlow();
  }
  return { choices, cursor: at };
};

/** A shared connection's picked document libraries: their files, changes and deletions. */
export const librarySync = defineSync({
  name: "libraries",
  kind: "file",
  routes: [
    { method: "GET", host: graphHost, path: `${v1}/sites` },
    { method: "GET", host: graphHost, path: `${v1}/sites/{site}/drives` },
    { method: "GET", host: graphHost, path: `${v1}${drives}/{place}` },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${drives}/{place}/root/delta`,
    },
    {
      method: "GET",
      host: graphHost,
      path: `${v1}${drives}/{place}/items/{item}/content`,
      redirects: downloadHosts,
    },
    // SharePoint's REST API on the company's own host, under a site at
    // its root, `/sites/<name>` or `/teams/<name>`: a subsite's files are
    // refused, so nobody's.
    ...["", "/sites/{site}", "/teams/{site}"].flatMap((under) =>
      [
        "/_api/web/{list}/{item}/roleassignments",
        "/_api/web/sitegroups/{group}/users",
        "/_api/web/effectiveBasePermissions",
      ].map((path) => ({
        method: "GET" as const,
        host: tenantHost,
        path: `${under}${path}`,
      }))
    ),
  ],
  choices: choicesOf,
  read: async ({ place, cursor, deadline }) =>
    await readPage(
      place,
      cursor === null
        ? { phase: "list", token: null, began: null, at: startOfPage }
        : positionOf(cursor),
      deadline
    ),
});
