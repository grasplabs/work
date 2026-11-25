import {
  checkReadable,
  contentAs,
  page,
  tool,
  ToolError,
  v,
} from "@grasp-os/sdk/connector";
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
// Content: Google serves a stored file's bytes from www.googleapis.com
// itself (`alt=media`, no redirect, so the egress follows none). Google's
// own documents, spreadsheets and presentations have no bytes of their
// own; they are exported as text (`/export`), in one request, too.
//
// A person's My Drive isn't a shared drive and has no drive ID to hold a
// call to, or to check a file against: it is left out. An organization's
// files live in shared drives, so these tools reach `company`. Scoping is
// per drive, not per folder.

const files = `${apisHost}/drive/v3/files`;

/** A file's metadata: its drive is checked from what it answers. */
const file = `${files}/{fileId}`;

/** A Google document, spreadsheet or presentation, as text. */
const fileExport = `${file}/export`;

/** Google's own formats, as the text each is exported to. */
const exportAs: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

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

/**
 * What a file's content is read as: its own bytes (`null`), or the text
 * Google exports it to; `undefined` for a folder, a form, a shortcut or
 * anything else of Google's own with nothing to read.
 */
const contentOf = (mimeType: string): string | null | undefined => {
  if (Object.hasOwn(exportAs, mimeType)) {
    return exportAs[mimeType];
  }
  return mimeType.startsWith("application/vnd.google-apps.") ? undefined : null;
};

const readAs = v.enum(["text", "base64"]);

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
  "drive.files.get": tool({
    description:
      "Reads a file of a shared drive: as text, or as base64 to extract its content (a PDF, say). Google Docs and Slides come as plain text, Sheets as CSV (the first sheet). Up to 4 MiB.",
    args: {
      driveId: driveIdArg,
      fileId: v.string().min(1).max(1024),
      as: readAs.optional(),
    },
    returns: v.object({
      id: v.string(),
      name: v.string(),
      mimeType: v.string(),
      /** The content's type: the file's own, or what it was exported to. */
      contentType: v.string(),
      /** The content's size in bytes, as Drive gives a size: a string. */
      size: v.string(),
      encoding: readAs,
      content: v.string(),
    }),
    readOnly: true,
    // A workflow action may keep it as a file of its run (GRA-886).
    answersFile: true,
    reach: "company",
    resource: "driveId",
    scopes: [googleScope("drive.readonly")],
    // A file has no drive in its path: the handler checks its metadata
    // before its content.
    routes: [`GET ${file}`, `GET ${fileExport}`],
    handler: async ({ driveId, fileId, as = "text" }, api) => {
      const found = await fileIn(api, driveId, fileId);
      const exportType = contentOf(found.mimeType);
      if (exportType === undefined) {
        throw new ToolError("This isn't a file with content to read", {
          code: "not_a_file",
        });
      }
      checkReadable(Number(found.size ?? 0));
      const bytes =
        exportType === null
          ? await api.get(file, {
              path: { fileId },
              query: { alt: "media", supportsAllDrives: true },
              as: "bytes",
            })
          : await api.get(fileExport, {
              path: { fileId },
              query: { mimeType: exportType },
              as: "bytes",
            });
      return {
        id: found.id,
        name: found.name,
        mimeType: found.mimeType,
        contentType: exportType ?? found.mimeType,
        size: String(bytes.byteLength),
        ...contentAs(bytes, as),
      };
    },
  }),
};
