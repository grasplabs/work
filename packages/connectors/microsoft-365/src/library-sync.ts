import { ToolError } from "@grasp-os/connector-kit/connector";
import { maxReadBytes, toBase64 } from "@grasp-os/connector-kit/content";
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
// Who may read what it brings is the connection's Brain audience, which an
// admin chooses inside Grasp (GRA-1831): the library's permissions are not
// mirrored, so none are read (saving SharePoint's 5 resource units a
// permissions call costs), and every item's readers are null.
//
// Where a read stops, and where the next goes on: the kit's paging
// (`fillPage`), keyed by an entry's ID and eTag, so an entry that changed
// since, which Graph moves on, is no longer the one handled.
//
// The places to pick: the SharePoint sites the account can find
// (`GET /sites?search=*`, https://learn.microsoft.com/en-us/graph/api/site-search?view=graph-rest-1.0),
// less personal OneDrive sites, and each site's document libraries
// (`GET /sites/{id}/drives`, https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0).
// A listing too long for one read goes on after the last site it handled,
// by its ID, in Graph's page of sites; a site whose libraries a read
// couldn't finish is listed again from its start.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft): which
// sites `search=*` answers for a delegated account (the page says only
// that it searches "across a SharePoint tenant"); and, as for OneDrive,
// that a delta token read again answers the same entries in the same
// order.

const drives = "/drives";
const libraryType = "documentLibrary";

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
});
type Entry = z.infer<typeof entrySchema>;

const entryFields =
  "id,name,eTag,lastModifiedDateTime,size,file,deleted,remoteItem,parentReference,lastModifiedBy";

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

const goneOf = (id: string): SyncItem => ({ gone: true, id, kind: "file" });

/** Whether an entry went away from the library: deleted, a shortcut, or another drive's. */
const isGone = (place: string, entry: Entry): boolean =>
  (entry.deleted !== undefined && entry.deleted !== null) ||
  (entry.remoteItem !== undefined && entry.remoteItem !== null) ||
  (entry.parentReference?.driveId ?? place).toLowerCase() !==
    place.toLowerCase();

/** A file as an item, with `content`. */
const fileOf = (entry: Entry, content: SyncContent | null): SyncItem => {
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
    // The connection's Brain audience reads it (GRA-1831).
    readers: null,
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
  entry: Entry
): Promise<EntryItems> => {
  const known = withoutContent(place, entry);
  const size = entry.size ?? 0;
  if (known[0]?.gone !== false || size === 0 || size > maxReadBytes) {
    return known;
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
    return known;
  }
  const taken = takeContent(room, {
    type: "file",
    contentType: entry.file?.mimeType ?? unknownType,
    base64: toBase64(bytes),
  });
  return taken === null ? "full" : [fileOf(entry, taken.content)];
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
  const { items, at, done } = await fillPage({
    room,
    entries: feed.value,
    at: position.at,
    keyOf: (entry) => `${entry.id} ${entry.eTag ?? ""}`,
    itemsFor: async (entry) => await itemsOf(room, place, entry),
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

/** A listing's position: Graph's page of sites, and the last site handled in it. */
interface Listing {
  page: string | null;
  after: string | null;
}

const listingCursor = ({ page, after }: Listing): string =>
  `${cursorPart(page)}.${cursorPart(after)}`;

/** The listing a cursor this sync wrote names; any other starts it over. */
const listingOf = (cursor: string | null): Listing => {
  if (cursor === null) {
    return { page: null, after: null };
  }
  const [page, after, ...rest] = cursor.split(".");
  if (rest.length > 0) {
    throw notOurs();
  }
  return { page: fromCursorPart(page), after: fromCursorPart(after) };
};

/** Out of room part-way through a listing. */
class OutOfRoomError extends Error {
  constructor() {
    super("Out of room part-way through a listing");
    this.name = "OutOfRoomError";
  }
}

/** One GET of a listing, within the read's room, or `OutOfRoomError`. */
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

/** Every document library of `site`, as places to pick, Graph's pages followed. */
const librariesOf = async (
  room: SyncRoom,
  site: z.infer<typeof siteSchema>
): Promise<SyncChoice[]> => {
  const siteName = site.displayName ?? site.name ?? "";
  const choices: SyncChoice[] = [];
  let page: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const answer = await listingGet(
      room,
      atPage(
        graphUrl(`/sites/${segment(site.id)}/drives`, {
          $select: "id,name,driveType",
        }),
        page
      ),
      drivesSchema
    );
    for (const library of answer.value) {
      if (
        library.driveType === libraryType &&
        syncPlaceSchema.safeParse(library.id).success
      ) {
        choices.push({
          place: library.id,
          title: `${siteName} › ${library.name ?? ""}`,
        });
      }
    }
    page = nextPageOf(answer["@odata.nextLink"]) ?? undefined;
  } while (page !== undefined);
  return choices;
};

/**
 * The document libraries of the SharePoint sites the account can find, a
 * read at a time: a site's libraries whole, or none of them, going on
 * after the last site handled, by its ID, in Graph's page of sites.
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
        if (!isPersonal(site)) {
          // oxlint-disable-next-line no-await-in-loop -- one site after another
          choices.push(...(await librariesOf(room, site)));
        }
        listing.after = site.id;
      }
      const next = nextPageOf(sites["@odata.nextLink"]);
      if (next === null) {
        return { choices, cursor: null };
      }
      listing.page = next;
      listing.after = null;
    }
  } catch (error) {
    if (!(error instanceof OutOfRoomError)) {
      throw error;
    }
  }
  const at = listingCursor(listing);
  // Nothing moved on: Graph is too slow for one read to take a site.
  if (at === from) {
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
