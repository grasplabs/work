import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api, ConnectorTool, Infer } from "@grasp-os/sdk/connector";

import { apisHost, googleScope, nextOf } from "./google.ts";

// Drive, one shared drive per call. Google's Drive API has no path per
// drive: a file is `/drive/v3/files/{id}` whichever drive holds it, so
// the egress can't bind a request to the drive, and this code holds each
// call to it:
//
// - A list asks for the drive's corpus in the query
//   (`corpora=drive&driveId=...`), which Google holds it to, whatever its
//   `q` says. Only items Google says are in that drive (`driveId`) are
//   passed on.
// - A file read addresses the file by its ID alone. The tool reads the
//   file's metadata first (`fileIn`) and goes no further unless it is in
//   the bound drive and not trashed.
//
// A person's My Drive isn't a shared drive and has no drive ID to hold a
// call to, or to check a file against: it is left out. An organization's
// files live in shared drives, so these tools reach `company`. Scoping is
// per drive, not per folder.

const files = `${apisHost}/drive/v3/files`;

/** A file's metadata: its drive is checked from what it answers. */
const file = `${files}/{fileId}`;

/** The route of a file's metadata, which a tool reads to check its drive. */
export const fileRoute = `GET ${file}` as const;

/** A shared drive's ID, as Drive's `driveId` names it. */
export const driveIdArg = v.string().min(1).max(256);

/** A file as Drive gives it, narrowed to `fileFields`. */
const driveFile = v.object({
  id: v.string(),
  name: v.string(),
  mimeType: v.string(),
  /** In bytes, as a string (an int64); none for Google's own formats. */
  size: v.string().optional(),
  modifiedTime: v.string().optional(),
  webViewLink: v.string().optional(),
  parents: v.array(v.string()).optional(),
  driveId: v.string().optional(),
  trashed: v.boolean().optional(),
});
type DriveFile = Infer<typeof driveFile>;

const fileFields =
  "id,name,mimeType,size,modifiedTime,webViewLink,parents,driveId,trashed";

/**
 * The file `fileId`'s metadata, only when Google says it is in `driveId`,
 * is the file asked for and isn't trashed: anything else is refused as not
 * found, before anything of its content is asked for.
 */
export const fileIn = async (
  api: Api,
  driveId: string,
  fileId: string
): Promise<DriveFile> => {
  const found = await api.get(file, {
    path: { fileId },
    query: { supportsAllDrives: true, fields: fileFields },
    returns: driveFile,
  });
  if (
    found.driveId !== driveId ||
    found.id !== fileId ||
    found.trashed === true
  ) {
    throw new ToolError("This drive has no such file", { code: "not_found" });
  }
  return found;
};

const filePage = v.object({
  files: v.array(driveFile).optional(),
  nextPageToken: v.string().optional(),
});

export const driveTools: Readonly<Record<string, ConnectorTool>> = {
  "drive.files.list": tool({
    description:
      "Lists the files and folders of a shared drive that match q, Drive's search query: \"'<folder ID>' in parents\" for a folder's (the drive's own ID for its top folder), \"fullText contains 'invoice'\" to search by name and content, most relevant first. Trashed items are left out.",
    args: {
      driveId: driveIdArg,
      q: v.string().min(1).max(2048).optional(),
      orderBy: v.string().min(1).max(256).optional(),
      pageSize: v.number().integer().min(1).max(100).optional(),
      pageToken: v.string().min(1).max(4096).optional(),
    },
    returns: page(driveFile),
    readOnly: true,
    reach: "company",
    resource: "driveId",
    scopes: [googleScope("drive.readonly")],
    routes: [`GET ${files}`],
    handler: async ({ driveId, q, orderBy, pageSize, pageToken }, api) => {
      const answered = await api.get(files, {
        query: {
          corpora: "drive",
          driveId,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          q: q === undefined ? "trashed = false" : `(${q}) and trashed = false`,
          orderBy,
          pageSize: pageSize ?? 50,
          pageToken,
          fields: `nextPageToken,files(${fileFields})`,
        },
        returns: filePage,
      });
      return {
        items: (answered.files ?? []).filter(
          (each) => each.driveId === driveId && each.trashed !== true
        ),
        next: nextOf(answered.nextPageToken),
      };
    },
  }),
};
