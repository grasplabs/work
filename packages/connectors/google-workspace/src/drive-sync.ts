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

import { apisHost, googleFailure, googleUrl } from "./google.ts";

// Native sync of a person's own Drive (GRA-1758): every file they own in
// My Drive, then what changed, what went away, and who may open each. A
// person's own connection syncs only what that person owns: a file shared
// with them is synced by its owner's connection, once, with the whole
// reader list only an owner sees (Google gives readers and commenters no
// detailed permissions). Shared drives come only through a shared
// connection's picked places (shared-drive-sync.ts), which read one shared
// drive each through the same steps, scoped to that drive (`Scope`).
//
// How it reads (Google's "Manage changes"): first the change feed's start
// token, then the listing of every owned file, then the change feed from
// that start token, so nothing changed during the listing is missed. A
// change gives the file as it is now, so a page read twice, or a change
// read after the listing, yields the same version.
//
// Content never runs ahead of its version: after a file's bytes, its
// `version` is read again, and a file that changed in between gives
// nothing here; the change feed brings its newer version.
//
// What goes away: Drive's `removed` (deleted, or the account lost access:
// Google doesn't say which), a file in the bin, and a file the person no
// longer owns all come as `gone`. Readers come from the file's own
// `permissions`, which Google fills for anyone who can share it, as an
// owner can: a user or a group by address; a domain as the tenant only
// when its people can find the file in their own search
// (`allowFileDiscovery`), else as a link, like "anyone with the link": a
// link counts for nobody.
//
// Where a read stops, and where the next goes on: the kit's paging
// (`fillPage`). An entry's key is the file's ID in the listing, ordered
// by `createdTime`, which no edit changes; and the file's ID with the
// change's time in the change feed, so a file changed again, whose entry
// Google moves on, is no longer the entry handled.

const files = "/drive/v3/files";
const changes = "/drive/v3/changes";

const xlsx =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Google's own formats with content to read, as what each is exported to:
 * documents and presentations as text; spreadsheets as an xlsx workbook,
 * every sheet of it (Google's CSV export holds the first sheet only), for
 * core's extractor.
 */
const exportAs: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": xlsx,
  "application/vnd.google-apps.presentation": "text/plain",
};

const folderMimeType = "application/vnd.google-apps.folder";
const googleAppsPrefix = "application/vnd.google-apps.";

/** Entries asked of Google per page of the listing or the change feed. */
const googlePageSize = 100;

const permissionSchema = z.object({
  type: z.string(),
  emailAddress: z.string().nullish(),
  domain: z.string().nullish(),
  allowFileDiscovery: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
});

const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** In bytes, as a string (an int64); none for Google's own formats. */
  size: z.string().regex(/^\d+$/u).nullish(),
  modifiedTime: z.string(),
  /** Moves with every change of the file, its sharing too. */
  version: z.string(),
  trashed: z.boolean().nullish(),
  ownedByMe: z.boolean().nullish(),
  driveId: z.string().nullish(),
  lastModifyingUser: z.object({ emailAddress: z.string().nullish() }).nullish(),
  permissions: z.array(permissionSchema).nullish(),
});
export type DriveFile = z.infer<typeof fileSchema>;

const fileFields =
  "id,name,mimeType,size,modifiedTime,version,trashed,ownedByMe,driveId,lastModifyingUser(emailAddress),permissions(type,emailAddress,domain,allowFileDiscovery,deleted)";

const startSchema = z.object({ startPageToken: z.string().min(1) });

const listSchema = z.object({
  files: z.array(fileSchema).nullish(),
  nextPageToken: z.string().nullish(),
});

const changeSchema = z.object({
  fileId: z.string().nullish(),
  removed: z.boolean().nullish(),
  time: z.string(),
  file: fileSchema.nullish(),
});
type Change = z.infer<typeof changeSchema>;

const changesSchema = z.object({
  changes: z.array(changeSchema).nullish(),
  nextPageToken: z.string().nullish(),
  newStartPageToken: z.string().nullish(),
});

/**
 * What a read covers: the query parameters that hold each Drive call to
 * it, which of the files Drive gives back are in it, and who may open one.
 * The person's own Drive (`ownDrive`), or one shared drive
 * (shared-drive-sync.ts).
 */
export interface Scope {
  /** `files.list`'s parameters: its corpora and query. */
  listing: Readonly<Record<string, string>>;
  /** `changes.getStartPageToken`'s. */
  start: Readonly<Record<string, string>>;
  /** `changes.list`'s. */
  changes: Readonly<Record<string, string>>;
  /** `files.get`'s, for a file's metadata or bytes. */
  file: Readonly<Record<string, string>>;
  /** Whether a file is one this read syncs; else it comes as gone. */
  holds: (file: DriveFile) => boolean;
  /** Who may open a file, as the item names them. */
  readers: (file: DriveFile) => SyncReader[] | null;
}

/**
 * Where a read is: listing the files, or reading the change feed; in
 * Google's page `token`, where in it (`at`).
 */
type Position =
  | {
      phase: "list";
      start: string;
      token: string | null;
      at: InPage;
    }
  | { phase: "changes"; token: string; at: InPage };

const cursorOf = (position: Position): string =>
  position.phase === "list"
    ? `l.${cursorPart(position.start)}.${cursorPart(position.token)}.${inPagePart(position.at)}`
    : `c.${cursorPart(position.token)}.${inPagePart(position.at)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, ...parts] = cursor.split(".");
  if (phase === "l" && parts.length === 3) {
    const [start, token] = parts.slice(0, 2).map(fromCursorPart);
    if (start !== null && start !== undefined) {
      return {
        phase: "list",
        start,
        token: token ?? null,
        at: fromInPagePart(parts[2]),
      };
    }
  }
  if (phase === "c" && parts.length === 2) {
    const token = fromCursorPart(parts[0]);
    if (token !== null) {
      return { phase: "changes", token, at: fromInPagePart(parts[1]) };
    }
  }
  throw new RestartSyncError("Not a cursor this sync wrote");
};

/** Sends one GET for a page: its answer if it succeeded; a 404 or 410 starts over. */
const getJson = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  const response = await fetchInRoom(room, url);
  if (response === "late") {
    throw new ToolError("Google didn't answer in time", {
      code: "unavailable",
    });
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    throw new RestartSyncError();
  }
  if (!response.ok) {
    throw await googleFailure(response);
  }
  return schema.parse(await response.json());
};

/** Who may open a file, as its permissions say; null without them. */
const readersOf = (file: DriveFile): SyncReader[] | null => {
  if (file.permissions === null || file.permissions === undefined) {
    return null;
  }
  return file.permissions.flatMap((permission): SyncReader[] => {
    if (permission.deleted === true) {
      return [];
    }
    const address = permission.emailAddress?.toLowerCase() ?? "";
    const domain = permission.domain?.toLowerCase() ?? "";
    if (permission.type === "user" && address !== "") {
      return [{ kind: "account", id: address }];
    }
    if (permission.type === "group" && address !== "") {
      return [{ kind: "group", id: address }];
    }
    // The domain finds it in its own search only when Google says so.
    if (
      permission.type === "domain" &&
      domain !== "" &&
      permission.allowFileDiscovery === true
    ) {
      return [{ kind: "tenant", id: domain }];
    }
    if (permission.type === "domain" || permission.type === "anyone") {
      return [{ kind: "link" }];
    }
    return [];
  });
};

/** Whether a file is one this connection syncs: owned, in My Drive, not in the bin. */
const isOwned = (file: DriveFile): boolean =>
  file.ownedByMe === true &&
  (file.driveId ?? null) === null &&
  file.trashed !== true;

/** The person's own Drive: every file they own in My Drive. */
const ownDrive: Scope = {
  listing: {
    corpora: "user",
    q: `'me' in owners and trashed = false and mimeType != '${folderMimeType}'`,
  },
  start: {},
  changes: {},
  file: {},
  holds: isOwned,
  readers: readersOf,
};

/** How a file's content is read: exported, its own bytes, or not at all. */
const howToRead = (
  file: DriveFile
): { export: string } | { media: true } | null => {
  if (Object.hasOwn(exportAs, file.mimeType)) {
    return { export: exportAs[file.mimeType] ?? "text/plain" };
  }
  if (file.mimeType.startsWith(googleAppsPrefix)) {
    return null;
  }
  return Number(file.size ?? 0) > maxReadBytes ? null : { media: true };
};

/**
 * What a content read found: content, none to read, the file gone, the
 * file changed since its metadata was read, or no room.
 */
type Read =
  | { content: SyncContent | null }
  | { gone: true }
  | { moved: true }
  | { full: true }
  | { late: true };

const versionSchema = z.object({ version: z.string() });

/**
 * The file's version now, read after its bytes: Drive's `version` moves
 * with every change of a file, a Docs Editors file's too, while
 * `headRevisionId` and `md5Checksum` exist only for files with bytes of
 * their own (https://developers.google.com/workspace/drive/api/reference/rest/v3/files).
 */
const versionNow = async (
  room: SyncRoom,
  scope: Scope,
  path: string
): Promise<{ version: string } | "gone" | "late"> => {
  if (!mayRequest(room)) {
    return "late";
  }
  const response = await fetchInRoom(
    room,
    googleUrl(apisHost, path, { ...scope.file, fields: "version" })
  );
  if (response === "late") {
    return "late";
  }
  if (response.status === 404) {
    return "gone";
  }
  if (!response.ok) {
    throw await googleFailure(response);
  }
  return versionSchema.parse(await response.json());
};

/** The content an answer holds, as the file is read. */
const contentFrom = (
  file: DriveFile,
  how: { export: string } | { media: true },
  bytes: Uint8Array
): SyncContent | null => {
  if ("export" in how && how.export.startsWith("text/")) {
    try {
      return {
        type: "text",
        text: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes),
      };
    } catch {
      return null;
    }
  }
  return {
    type: "file",
    contentType: "export" in how ? how.export : file.mimeType,
    base64: toBase64(bytes),
  };
};

/** A file's content, if the page has room for it. */
/** No room left for this entry's bytes: an empty page goes on without its content. */
const noRoom = (room: SyncRoom): Read =>
  room.empty ? { content: null } : { full: true };

/** A file's bytes as it is now, or what a read found instead. */
const download = async (
  room: SyncRoom,
  scope: Scope,
  path: string,
  how: { export: string } | { media: true }
): Promise<Uint8Array | Read> => {
  const response = await fetchInRoom(
    room,
    // `files.export` takes only `mimeType`
    // (https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export).
    "export" in how
      ? googleUrl(apisHost, `${path}/export`, { mimeType: how.export })
      : googleUrl(apisHost, path, { ...scope.file, alt: "media" })
  );
  // Given up at the deadline: the kit's paging decides (`fillPage`).
  if (response === "late") {
    return { late: true };
  }
  if (response.status === 404) {
    return { gone: true };
  }
  // Not the owner's to download, or too large to export: nothing to read.
  // A rate limit, which Google also answers 403, waits.
  if (response.status === 403) {
    const failure = await googleFailure(response);
    if (failure.details?.code === "throttled") {
      throw failure;
    }
    return { content: null };
  }
  if (!response.ok) {
    throw await googleFailure(response);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * Whether bytes read now are still the version the file's metadata gave:
 * null if so, else what the read found. Content never runs ahead of its
 * version: if the file changed since, this entry gives nothing, and the
 * change feed, which reports every change after the position it was read
 * from, brings the newer version. A later read never returns to this
 * entry, so it can't loop.
 */
const sameVersion = async (
  room: SyncRoom,
  scope: Scope,
  path: string,
  file: DriveFile
): Promise<Read | null> => {
  const now = await versionNow(room, scope, path);
  if (now === "late") {
    return { late: true };
  }
  if (now === "gone") {
    return { gone: true };
  }
  return now.version === file.version ? null : { moved: true };
};

/** A file's content, if the page has room for it. */
const contentOf = async (
  room: SyncRoom,
  scope: Scope,
  file: DriveFile
): Promise<Read> => {
  const how = howToRead(file);
  if (how === null) {
    return { content: null };
  }
  // Out of requests or time before it starts: the next read takes it.
  if (!mayRequest(room)) {
    return { full: true };
  }
  // Base64 is a third larger than the bytes.
  if ("media" in how && (Number(file.size ?? 0) * 4) / 3 > room.bytes) {
    return noRoom(room);
  }
  const path = `${files}/${segment(file.id)}`;
  const bytes = await download(room, scope, path, how);
  if (!(bytes instanceof Uint8Array)) {
    return bytes;
  }
  const changed = await sameVersion(room, scope, path, file);
  if (changed !== null) {
    return changed;
  }
  const content =
    bytes.byteLength > maxReadBytes ? null : contentFrom(file, how, bytes);
  if (content === null) {
    return { content };
  }
  return takeContent(room, content) ?? { full: true };
};

/** A file that is there, as an item, with `content`. */
const itemOf = (
  scope: Scope,
  file: DriveFile,
  changedAt: string,
  content: SyncContent | null
): SyncItem => ({
  gone: false,
  id: file.id,
  kind: "file",
  version: file.version,
  changedAt,
  title: file.name,
  content,
  readers: scope.readers(file),
  changedBy: file.lastModifyingUser?.emailAddress?.toLowerCase() ?? null,
  partOf: null,
});

const goneOf = (id: string): SyncItem => ({ gone: true, id, kind: "file" });

/**
 * What a file is without reading its content: nothing for a folder, gone
 * when this connection no longer syncs it, else the item without content.
 */
const withoutContent = (
  scope: Scope,
  file: DriveFile,
  changedAt: string
): SyncItem[] => {
  if (file.mimeType === folderMimeType) {
    return [];
  }
  if (!scope.holds(file)) {
    return [goneOf(file.id)];
  }
  return [itemOf(scope, file, changedAt, null)];
};

/** The item a file now is, read with its content when it is synced. */
const fileItem = async (
  room: SyncRoom,
  scope: Scope,
  file: DriveFile,
  changedAt: string
): Promise<EntryItems> => {
  const known = withoutContent(scope, file, changedAt);
  if (known.length === 0 || known[0]?.gone === true) {
    return known;
  }
  const read = await contentOf(room, scope, file);
  if ("full" in read) {
    return "full";
  }
  if ("late" in read) {
    return "late";
  }
  if ("moved" in read) {
    return [];
  }
  return "gone" in read
    ? [goneOf(file.id)]
    : [itemOf(scope, file, changedAt, read.content)];
};

/** One page of the listing of every file the scope holds. */
const listPage = async (
  room: SyncRoom,
  scope: Scope,
  position: Extract<Position, { phase: "list" }>
): Promise<SyncPage> => {
  const listed = await getJson(
    room,
    googleUrl(
      apisHost,
      files,
      {
        ...scope.listing,
        // An order no edit changes, so a file kept in place stays after the
        // ones before it.
        orderBy: "createdTime",
        pageSize: String(googlePageSize),
        fields: `nextPageToken,files(${fileFields})`,
      },
      position.token ?? undefined
    ),
    listSchema
  );
  const { items, at, done } = await fillPage({
    room,
    entries: listed.files ?? [],
    at: position.at,
    keyOf: (file) => file.id,
    itemsFor: async (file) =>
      await fileItem(room, scope, file, file.modifiedTime),
    passOver: (file) => withoutContent(scope, file, file.modifiedTime),
  });
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, at }),
      more: true,
    };
  }
  const next = listed.nextPageToken ?? "";
  // The listing done, the change feed from before it is due at once.
  return {
    items,
    cursor: cursorOf(
      next === ""
        ? { phase: "changes", token: position.start, at: startOfPage }
        : { ...position, token: next, at: startOfPage }
    ),
    more: true,
  };
};

/**
 * A change's key: its file and its time, so a file changed again, whose
 * entry Google moves on in its page, is no longer the entry handled.
 */
const changeKey = (change: Change): string =>
  `${change.file?.id ?? change.fileId ?? ""}@${change.time}`;

/** What a change makes without reading content: gone, nothing, or the file's item. */
const changeWithoutContent = (scope: Scope, change: Change): SyncItem[] => {
  const id = change.file?.id ?? change.fileId;
  if (id === null || id === undefined) {
    return [];
  }
  if (
    change.removed === true ||
    change.file === null ||
    change.file === undefined
  ) {
    return [goneOf(id)];
  }
  return withoutContent(scope, change.file, change.time);
};

/** The item a change makes: the file as it now is, gone, or none. */
const changeItem = async (
  room: SyncRoom,
  scope: Scope,
  change: Change
): Promise<EntryItems> =>
  change.file === null || change.file === undefined || change.removed === true
    ? changeWithoutContent(scope, change)
    : await fileItem(room, scope, change.file, change.time);

/** One page of the change feed. */
const changesPage = async (
  room: SyncRoom,
  scope: Scope,
  position: Extract<Position, { phase: "changes" }>
): Promise<SyncPage> => {
  const changed = await getJson(
    room,
    googleUrl(apisHost, changes, {
      ...scope.changes,
      pageToken: position.token,
      pageSize: String(googlePageSize),
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${fileFields}))`,
    }),
    changesSchema
  );
  const { items, at, done } = await fillPage({
    room,
    entries: changed.changes ?? [],
    at: position.at,
    keyOf: changeKey,
    itemsFor: async (change) => await changeItem(room, scope, change),
    passOver: (change) => changeWithoutContent(scope, change),
  });
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, at }),
      more: true,
    };
  }
  const next = changed.nextPageToken ?? "";
  if (next !== "") {
    return {
      items,
      cursor: cursorOf({ phase: "changes", token: next, at: startOfPage }),
      more: true,
    };
  }
  const start = changed.newStartPageToken ?? "";
  if (start === "") {
    throw new ToolError("Drive's change feed has no next position", {
      code: "failed",
    });
  }
  return {
    items,
    cursor: cursorOf({ phase: "changes", token: start, at: startOfPage }),
    more: false,
  };
};

/** The routes a read of files sends: the change feed, the listing, a file. */
export const fileRoutes = [
  { method: "GET", host: apisHost, path: `${changes}/startPageToken` },
  { method: "GET", host: apisHost, path: changes },
  { method: "GET", host: apisHost, path: files },
  { method: "GET", host: apisHost, path: `${files}/{item}` },
  { method: "GET", host: apisHost, path: `${files}/{item}/export` },
] as const;

/**
 * One page of what `scope` holds from `cursor` on (from the start when
 * null), within `room`: first where its change feed stands, then the
 * listing, then the change feed from that start.
 */
export const readFiles = async (
  scope: Scope,
  cursor: string | null,
  room: SyncRoom
): Promise<SyncPage> => {
  if (cursor === null) {
    // Where the change feed stands before anything is listed.
    const { startPageToken } = await getJson(
      room,
      googleUrl(apisHost, `${changes}/startPageToken`, scope.start),
      startSchema
    );
    return await listPage(room, scope, {
      phase: "list",
      start: startPageToken,
      token: null,
      at: startOfPage,
    });
  }
  const position = positionOf(cursor);
  return position.phase === "list"
    ? await listPage(room, scope, position)
    : await changesPage(room, scope, position);
};

/** The person's own Drive: every file they own, its changes and its readers. */
export const driveSync = defineSync({
  name: "drive",
  kind: "file",
  routes: fileRoutes,
  read: async ({ place, cursor, deadline }) => {
    if (place !== ownPlace) {
      // Shared drives are read by shared-drive-sync.ts, on a shared
      // connection, picked.
      throw new ToolError("This sync reads the person's own Drive only", {
        code: "failed",
      });
    }
    return await readFiles(ownDrive, cursor, syncRoom(deadline));
  },
});
