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

import { apisHost, googleFailure, googleUrl } from "./google.ts";

// Native sync of a person's own Drive (GRA-1758): every file they own in
// My Drive, then what changed, what went away, and who may open each. A
// person's own connection syncs only what that person owns: a file shared
// with them is synced by its owner's connection, once, with the whole
// reader list only an owner sees (Google gives readers and commenters no
// detailed permissions). Shared drives come only through a shared
// connection's picked places (GRA-1758, PR J).
//
// How it reads (Google's "Manage changes"): first the change feed's start
// token, then the listing of every owned file, then the change feed from
// that start token, so nothing changed during the listing is missed. A
// change gives the file as it is now, so a page read twice, or a change
// read after the listing, yields the same version.
//
// What goes away: Drive's `removed` (deleted, or the account lost access:
// Google doesn't say which), a file in the bin, and a file the person no
// longer owns all come as `gone`. Readers come from the file's own
// `permissions`, which Google fills for anyone who can share it, as an
// owner can: a user or a group by address, a domain as a tenant;
// "anyone with the link" is left out, so it gives nobody access.
//
// The cursor is the phase, Google's token (base64url, so it stays in the
// cursor's alphabet), and how far into Google's page a read got: a page
// stops once its requests or its content reach `syncPageLimits`, and the
// next read goes on from there in the same Google page.

const files = "/drive/v3/files";
const changes = "/drive/v3/changes";

/** Google's own formats with text to read, as the text each is exported to. */
const exportAs: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
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
type DriveFile = z.infer<typeof fileSchema>;

const fileFields =
  "id,name,mimeType,size,modifiedTime,version,trashed,ownedByMe,driveId,lastModifyingUser(emailAddress),permissions(type,emailAddress,domain,deleted)";

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

const changesSchema = z.object({
  changes: z.array(changeSchema).nullish(),
  nextPageToken: z.string().nullish(),
  newStartPageToken: z.string().nullish(),
});

/** Where a read is: listing the files, or reading the change feed. */
type Position =
  | { phase: "list"; start: string; token: string | null; offset: number }
  | { phase: "changes"; token: string; offset: number };

const token = /^[\w-]*$/u;

const encode = (value: string): string =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const decode = (value: string): string => {
  if (!token.test(value)) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  return atob(value.replaceAll("-", "+").replaceAll("_", "/"));
};

const cursorOf = (position: Position): string =>
  position.phase === "list"
    ? `l.${encode(position.start)}.${encode(position.token ?? "")}.${position.offset}`
    : `c.${encode(position.token)}.${position.offset}`;

const offsetOf = (value: string | undefined): number => {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  return offset;
};

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, ...parts] = cursor.split(".");
  if (phase === "l" && parts.length === 3) {
    const [start = "", listed = "", offset] = parts;
    const listToken = decode(listed);
    return {
      phase: "list",
      start: decode(start),
      token: listToken === "" ? null : listToken,
      offset: offsetOf(offset),
    };
  }
  if (phase === "c" && parts.length === 2) {
    const [changed = "", offset] = parts;
    return {
      phase: "changes",
      token: decode(changed),
      offset: offsetOf(offset),
    };
  }
  throw new RestartSyncError("Not a cursor this sync wrote");
};

/** The requests and content a page has left. */
interface Room {
  requests: number;
  bytes: number;
}

/** Sends one GET: its answer if it succeeded; a 404 or 410 starts over. */
const getJson = async <Schema extends z.ZodType>(
  room: Room,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  room.requests -= 1;
  const response = await fetch(url);
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
    if (permission.type === "domain" && domain !== "") {
      return [{ kind: "tenant", id: domain }];
    }
    // "Anyone with the link", and anything else: nobody.
    return [];
  });
};

/** Whether a file is one this connection syncs: owned, in My Drive, not in the bin. */
const isOwned = (file: DriveFile): boolean =>
  file.ownedByMe === true &&
  (file.driveId ?? null) === null &&
  file.trashed !== true;

/** How a file's content is read: exported as text, its own bytes, or not at all. */
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

/** What a content read found: content, none to read, the file gone, or no room. */
type Read = { content: SyncContent | null } | { gone: true } | { full: true };

/** JSON bytes of `content` in a page. */
const sizeOf = (content: SyncContent): number =>
  new TextEncoder().encode(JSON.stringify(content)).byteLength;

/** A file's content, if the page has room for it. */
const contentOf = async (room: Room, file: DriveFile): Promise<Read> => {
  const how = howToRead(file);
  if (how === null) {
    return { content: null };
  }
  // A page with nothing in it yet takes any file, without its content if
  // that doesn't fit, so every read moves on.
  const empty = room.bytes === syncPageLimits.contentBytes;
  // Base64 is a third larger than the bytes.
  const known = (Number(file.size ?? 0) * 4) / 3;
  if (room.requests <= 0) {
    return { full: true };
  }
  if ("media" in how && known > room.bytes) {
    return empty ? { content: null } : { full: true };
  }
  const path = `${files}/${segment(file.id)}`;
  room.requests -= 1;
  const response = await fetch(
    "export" in how
      ? googleUrl(apisHost, `${path}/export`, { mimeType: how.export })
      : googleUrl(apisHost, path, { alt: "media" })
  );
  if (response.status === 404) {
    await response.body?.cancel();
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxReadBytes) {
    return { content: null };
  }
  let content: SyncContent;
  if ("export" in how) {
    try {
      content = {
        type: "text",
        text: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes),
      };
    } catch {
      return { content: null };
    }
  } else {
    content = {
      type: "file",
      contentType: file.mimeType,
      base64: toBase64(bytes),
    };
  }
  const size = sizeOf(content);
  if (size > room.bytes) {
    return empty ? { content: null } : { full: true };
  }
  room.bytes -= size;
  return { content };
};

/** A file that is there, as an item, with `content`. */
const itemOf = (
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
  readers: readersOf(file),
  changedBy: file.lastModifyingUser?.emailAddress?.toLowerCase() ?? null,
  partOf: null,
});

const goneOf = (id: string): SyncItem => ({ gone: true, id, kind: "file" });

/**
 * The items of `entries` from `offset` on, until the page is full: each
 * entry an item, gone, or nothing (a folder). How far it got.
 */
const fill = async <Entry>(
  room: Room,
  entries: readonly Entry[],
  offset: number,
  itemFor: (entry: Entry) => Promise<SyncItem | null | "full">
): Promise<{ items: SyncItem[]; reached: number }> => {
  const items: SyncItem[] = [];
  let reached = offset;
  for (const entry of entries.slice(offset)) {
    // oxlint-disable-next-line no-await-in-loop -- one file after another, within the page's room
    const item = await itemFor(entry);
    if (item === "full") {
      break;
    }
    if (item !== null) {
      items.push(item);
    }
    reached += 1;
  }
  return { items, reached };
};

/** The item a file now is, read with its content when it is synced. */
const fileItem = async (
  room: Room,
  file: DriveFile,
  changedAt: string
): Promise<SyncItem | null | "full"> => {
  if (file.mimeType === folderMimeType) {
    return null;
  }
  if (!isOwned(file)) {
    return goneOf(file.id);
  }
  const read = await contentOf(room, file);
  if ("full" in read) {
    return "full";
  }
  return "gone" in read
    ? goneOf(file.id)
    : itemOf(file, changedAt, read.content);
};

/** One page of the listing of every file the person owns. */
const listPage = async (
  room: Room,
  position: Extract<Position, { phase: "list" }>
): Promise<SyncPage> => {
  const listed = await getJson(
    room,
    googleUrl(
      apisHost,
      files,
      {
        corpora: "user",
        q: `'me' in owners and trashed = false and mimeType != '${folderMimeType}'`,
        pageSize: String(googlePageSize),
        fields: `nextPageToken,files(${fileFields})`,
      },
      position.token ?? undefined
    ),
    listSchema
  );
  const entries = listed.files ?? [];
  const { items, reached } = await fill(
    room,
    entries,
    position.offset,
    async (file) => await fileItem(room, file, file.modifiedTime)
  );
  if (reached < entries.length) {
    return {
      items,
      cursor: cursorOf({ ...position, offset: reached }),
      more: true,
    };
  }
  const next = listed.nextPageToken ?? "";
  // The listing done, the change feed from before it is due at once.
  return {
    items,
    cursor: cursorOf(
      next === ""
        ? { phase: "changes", token: position.start, offset: 0 }
        : { ...position, token: next, offset: 0 }
    ),
    more: true,
  };
};

/** One page of the change feed. */
const changesPage = async (
  room: Room,
  position: Extract<Position, { phase: "changes" }>
): Promise<SyncPage> => {
  const changed = await getJson(
    room,
    googleUrl(apisHost, changes, {
      pageToken: position.token,
      pageSize: String(googlePageSize),
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${fileFields}))`,
    }),
    changesSchema
  );
  const entries = changed.changes ?? [];
  const { items, reached } = await fill(
    room,
    entries,
    position.offset,
    async (change) => {
      const id = change.file?.id ?? change.fileId;
      if (id === null || id === undefined) {
        return null;
      }
      if (
        change.removed === true ||
        change.file === null ||
        change.file === undefined
      ) {
        return goneOf(id);
      }
      return await fileItem(room, change.file, change.time);
    }
  );
  if (reached < entries.length) {
    return {
      items,
      cursor: cursorOf({ ...position, offset: reached }),
      more: true,
    };
  }
  const next = changed.nextPageToken ?? "";
  if (next !== "") {
    return {
      items,
      cursor: cursorOf({ phase: "changes", token: next, offset: 0 }),
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
    cursor: cursorOf({ phase: "changes", token: start, offset: 0 }),
    more: false,
  };
};

/** The person's own Drive: every file they own, its changes and its readers. */
export const driveSync = defineSync({
  name: "drive",
  kind: "file",
  routes: [
    { method: "GET", host: apisHost, path: `${changes}/startPageToken` },
    { method: "GET", host: apisHost, path: changes },
    { method: "GET", host: apisHost, path: files },
    { method: "GET", host: apisHost, path: `${files}/{item}` },
    { method: "GET", host: apisHost, path: `${files}/{item}/export` },
  ],
  read: async ({ place, cursor }) => {
    if (place !== ownPlace) {
      // Picked shared drives come with picks (GRA-1758, PR J).
      throw new ToolError("This sync reads the person's own Drive only", {
        code: "failed",
      });
    }
    const room: Room = {
      requests: syncPageLimits.requests,
      bytes: syncPageLimits.contentBytes,
    };
    if (cursor === null) {
      // Where the change feed stands before anything is listed.
      const { startPageToken } = await getJson(
        room,
        googleUrl(apisHost, `${changes}/startPageToken`),
        startSchema
      );
      return await listPage(room, {
        phase: "list",
        start: startPageToken,
        token: null,
        offset: 0,
      });
    }
    const position = positionOf(cursor);
    return position.phase === "list"
      ? await listPage(room, position)
      : await changesPage(room, position);
  },
});
