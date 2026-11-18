import { ToolError } from "@grasp-os/connector-kit/connector";
import { segment } from "@grasp-os/connector-kit/provider";
import {
  RestartSyncError,
  cursorPart,
  defineSync,
  fetchInRoom,
  fromCursorPart,
  mayRequest,
  syncRoom,
} from "@grasp-os/connector-kit/sync";
import type { SyncRoom } from "@grasp-os/connector-kit/sync";
import { syncPlaceSchema } from "@grasp-os/shared/sync";
import type { SyncChoice } from "@grasp-os/shared/sync";
import { z } from "zod";

import { fileRoutes, readFiles } from "./drive-sync.ts";
import type { DriveFile, Scope } from "./drive-sync.ts";
import { apisHost, googleFailure, googleUrl } from "./google.ts";

// Native sync of a shared connection's picked shared drives (GRA-1758):
// each shared drive an admin picked, as a place of its own, read through
// that drive's own change feed. A shared connection never syncs the
// connected account's own Drive, mail or calendar (connect refuses those
// syncs on it), and this sync reads nothing else: every call it sends
// names the picked drive (`driveId`, `corpora=drive`), and a file Drive
// gives back from anywhere else comes as gone.
//
// How it reads, as Google documents it for shared drives
// (https://developers.google.com/workspace/drive/api/guides/enable-shareddrives):
// `changes.getStartPageToken` with `driveId` and `supportsAllDrives`, then
// `files.list` with `corpora=drive`, the `driveId`,
// `includeItemsFromAllDrives` and `supportsAllDrives`, then `changes.list`
// with the same, which reports "changes to the particular shared drive
// that was specified and items inside that shared drive". `files.get`
// takes `supportsAllDrives` too; `files.export` takes only its `mimeType`
// (https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export).
// Everything else (content, versions, the bin, `removed`, where a read
// stops) is the person's own Drive sync's (drive-sync.ts), on this scope.
//
// Who may read what it brings is the connection's Brain audience, which an
// admin chooses inside Grasp (GRA-1831): the drive's own permissions are
// not mirrored, so none are read, and every item's readers are null.
//
// Each page first reads the drive itself (`drives.get`): a drive the
// account can no longer see, or an ID that is no shared drive at all,
// answers 404 and fails the read, before any file of it is asked for.
// Core's sync run drops the place once the places listing no longer has
// it.
//
// The places to pick are the shared drives the account is a member of
// (`drives.list`, https://developers.google.com/workspace/drive/api/reference/rest/v3/drives/list),
// a page of Google's at a time, at most 100 a page, Google's own largest.
// A listing too long for one read goes on from Google's own page token:
// each read takes whole pages, so it never stops inside one.

const drives = "/drive/v3/drives";

/** Shared drives Google lists per page: its largest ("The maximum value is 100"). */
const drivesPageSize = 100;

const driveSchema = z.object({ id: z.string() });

const drivesSchema = z.object({
  drives: z
    .array(z.object({ id: z.string(), name: z.string().nullish() }))
    .nullish(),
  nextPageToken: z.string().nullish(),
});

/** The parameters every Drive call of a shared drive sends. */
const ofAllDrives = { supportsAllDrives: "true" } as const;

/** One picked shared drive, as a read's scope. */
const sharedDrive = (driveId: string): Scope => ({
  listing: {
    ...ofAllDrives,
    corpora: "drive",
    driveId,
    includeItemsFromAllDrives: "true",
    q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
  },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken
  start: { ...ofAllDrives, driveId },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
  changes: { ...ofAllDrives, driveId, includeItemsFromAllDrives: "true" },
  file: ofAllDrives,
  // In this drive, and not in the bin: anything else went away from it.
  holds: (file: DriveFile) => file.driveId === driveId && file.trashed !== true,
  // The connection's Brain audience reads it, not the drive's members.
  readers: () => null,
});

/** Whether a read failed for lack of time: Google is slow, and the read waits. */
const tooSlow = (): ToolError =>
  new ToolError("Google didn't answer in time", { code: "unavailable" });

/**
 * That `driveId` is a shared drive the account sees: Drive answers 404 for
 * one it doesn't, or for an ID that is no shared drive.
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/drives/get
 */
const requireDrive = async (room: SyncRoom, driveId: string): Promise<void> => {
  const response = await fetchInRoom(
    room,
    googleUrl(apisHost, `${drives}/${segment(driveId)}`, { fields: "id" })
  );
  if (response === "late") {
    throw tooSlow();
  }
  if (response.status === 404) {
    throw new ToolError("No such shared drive for this account", {
      code: "failed",
    });
  }
  if (!response.ok) {
    throw await googleFailure(response);
  }
  if (driveSchema.parse(await response.json()).id !== driveId) {
    throw new ToolError("Drive answered another shared drive", {
      code: "failed",
    });
  }
};

/**
 * The shared drives the account is a member of, a read at a time: whole
 * pages of Google's, until the read has no room left, going on from
 * Google's own page token, never from a position inside a page.
 */
const choicesOf = async ({
  cursor,
  deadline,
}: {
  cursor: string | null;
  deadline: number;
}): Promise<{ choices: SyncChoice[]; cursor: string | null }> => {
  const room = syncRoom(deadline);
  let token = cursor === null ? null : fromCursorPart(cursor);
  const choices: SyncChoice[] = [];
  for (;;) {
    const read = mayRequest(room)
      ? // oxlint-disable-next-line no-await-in-loop -- one page after another
        await fetchInRoom(
          room,
          googleUrl(
            apisHost,
            drives,
            {
              pageSize: String(drivesPageSize),
              fields: "nextPageToken,drives(id,name)",
            },
            token ?? undefined
          )
        )
      : "late";
    if (read === "late") {
      // Out of room: what this read took, and on from the same page.
      if (choices.length === 0) {
        throw tooSlow();
      }
      return { choices, cursor: cursorPart(token) };
    }
    if (read.status === 400 && token !== null) {
      // "If the token is rejected, throw it away and start paging again
      // from the first page."
      // oxlint-disable-next-line no-await-in-loop -- the one failure
      await read.body?.cancel();
      throw new RestartSyncError("Google rejected the page token");
    }
    if (!read.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the one failure
      throw await googleFailure(read);
    }
    // oxlint-disable-next-line no-await-in-loop -- this page's answer
    const page = drivesSchema.parse(await read.json());
    for (const each of page.drives ?? []) {
      if (syncPlaceSchema.safeParse(each.id).success) {
        choices.push({ place: each.id, title: each.name ?? "" });
      }
    }
    const next = page.nextPageToken ?? "";
    if (next === "") {
      return { choices, cursor: null };
    }
    token = next;
  }
};

/** A shared connection's picked shared drives: their files, changes and deletions. */
export const sharedDriveSync = defineSync({
  name: "shared-drives",
  kind: "file",
  routes: [
    { method: "GET", host: apisHost, path: drives },
    { method: "GET", host: apisHost, path: `${drives}/{place}` },
    ...fileRoutes,
  ],
  choices: choicesOf,
  read: async ({ place, cursor, deadline }) => {
    const room = syncRoom(deadline);
    await requireDrive(room, place);
    return await readFiles(sharedDrive(place), cursor, room);
  },
});
