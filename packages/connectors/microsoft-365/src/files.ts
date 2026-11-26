import { contentAs, page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api, Infer } from "@grasp-os/sdk/connector";

import {
  checkDrive,
  checkIds,
  drive,
  graphId,
  graphPage,
  next,
  nextOf,
  positionOf,
  top,
} from "./graph-sdk.ts";
import { textOf } from "./word.ts";

// Files, in one drive per call: a person's OneDrive or a SharePoint site's
// document library, both as `/drives/{drive}`, so a call's capability
// binds every request to its drive. Items are addressed by ID only. A
// tool reaches as far as any call of it can, so these reach `company`.
// Graph answers with the person's own rights: a file they can't open is
// refused, its versions too.

/**
 * Where a download may be redirected to: Graph answers a file's `/content`
 * with a redirect to a pre-authenticated URL on the tenant's SharePoint
 * (`<tenant>.sharepoint.com`, `<tenant>-my.sharepoint.com` for OneDrive),
 * which connect's egress follows without the token.
 */
export const downloadHosts = ["*.sharepoint.com"];

/** Largest file a tool reads, in bytes, as the SDK's `contentAs` takes it. */
export const maxReadBytes = 4 * 1024 * 1024;

/** Refuses content past the read limit, before it is asked for. */
export const checkSize = (size: number | null | undefined): void => {
  if ((size ?? 0) > maxReadBytes) {
    throw new ToolError(
      `This is over ${maxReadBytes / 1024 / 1024} MiB, more than a tool reads`,
      { code: "too_large" }
    );
  }
};

const rootChildrenRoute = "/drives/{drive}/root/children";
const childrenRoute = "/drives/{drive}/items/{folder}/children";
const searchRoute = "/drives/{drive}/root/search(q='{q}')";
const itemRoute = "/drives/{drive}/items/{item}";
const contentRoute = "/drives/{drive}/items/{item}/content";
const versionsRoute = "/drives/{drive}/items/{item}/versions";
const versionRoute = "/drives/{drive}/items/{item}/versions/{version}";
const versionContentRoute =
  "/drives/{drive}/items/{item}/versions/{version}/content";

const driveItemFields = {
  id: v.string(),
  name: v.string(),
  size: v.number().integer().min(0).nullable().optional(),
  webUrl: v.string().nullable().optional(),
  lastModifiedDateTime: v.string().nullable().optional(),
  file: v
    .object({ mimeType: v.string().nullable().optional() })
    .nullable()
    .optional(),
  folder: v
    .object({ childCount: v.number().nullable().optional() })
    .nullable()
    .optional(),
  parentReference: v
    .object({
      id: v.string().nullable().optional(),
      driveId: v.string().nullable().optional(),
    })
    .nullable()
    .optional(),
};

/** A file or a folder (Graph's driveItem), narrowed to these fields. */
const DriveItem = v.object(driveItemFields);
type Item = Infer<typeof DriveItem>;

const select = Object.keys(driveItemFields).join(",");

/**
 * Whether an item is in `drive`, as Graph says. A search can find items
 * shared from elsewhere; only the bound drive's are passed on.
 */
const isIn = (inDrive: string, item: Item): boolean =>
  item.parentReference?.driveId === inDrive;

/** A page of Graph's driveItems as a list tool answers it: the drive's own. */
const itemsIn = (
  inDrive: string,
  answer: { value: Item[]; "@odata.nextLink"?: string | undefined }
) => ({
  items: answer.value.filter((item) => isIn(inDrive, item)),
  next: nextOf(answer["@odata.nextLink"]),
});

/**
 * Search text for Graph's `search(q='...')`, inside one path segment: no
 * character the egress refuses in a parameter.
 */
const searchText = /^[^/\\?#%;:\p{Cc}]+$/u;

/**
 * A file of `drive`, as Graph describes it. A tool on a file's versions or
 * content asks this first: the item is in the bound drive, and a file (not
 * a folder) the person may open.
 */
const fileIn = async (
  api: Api,
  inDrive: string,
  item: string
): Promise<Item> => {
  const found = await api.get(itemRoute, {
    path: { drive: inDrive, item },
    query: { $select: select },
    returns: DriveItem,
  });
  if (!isIn(inDrive, found)) {
    throw new ToolError("This drive has no such item", { code: "not_found" });
  }
  if (
    (found.folder !== undefined && found.folder !== null) ||
    found.file === undefined ||
    found.file === null
  ) {
    throw new ToolError("This isn't a file", { code: "not_a_file" });
  }
  return found;
};

/** The most text of a Word document a read returns, in characters. */
const maxWordTextLength = 2 * 1024 * 1024;

const readAs = v.enum(["text", "base64"]);

/**
 * A file's bytes as the caller asked for them. A Word document read as
 * text is its words, a line per paragraph with its tabs and line breaks,
 * as plain text: what a Google Doc exports to.
 */
const contentOf = (file: Item, bytes: Uint8Array, as: "text" | "base64") => {
  const words = as === "text" ? textOf(bytes) : undefined;
  if (words !== undefined && words.length > maxWordTextLength) {
    throw new ToolError("This document's text is too long to return", {
      code: "too_large",
    });
  }
  return {
    id: file.id,
    name: file.name,
    contentType:
      words === undefined
        ? (file.file?.mimeType ?? "application/octet-stream")
        : "text/plain",
    size: bytes.byteLength,
    ...contentAs(
      words === undefined ? bytes : new TextEncoder().encode(words),
      as
    ),
  };
};

/** A file's content (`answersFile`), with the file's ID and its size. */
const FileContent = v.object({
  id: v.string(),
  name: v.string(),
  contentType: v.string(),
  size: v.number().integer().min(0),
  encoding: readAs,
  content: v.string(),
});

/**
 * A version of a file (Graph's driveItemVersion), narrowed to these
 * fields: Graph's `@microsoft.graph.downloadUrl`, a pre-authenticated
 * link to its content, is never passed on.
 */
const DriveItemVersion = v.object({
  id: v.string(),
  lastModifiedDateTime: v.string().nullable().optional(),
  size: v.number().integer().min(0).nullable().optional(),
  lastModifiedBy: v
    .object({
      user: v
        .object({
          displayName: v.string().nullable().optional(),
          email: v.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const contentDescription =
  "As text (a Word document as its words, a line per paragraph) or as base64 to extract its content (a PDF, say). Up to 4 MiB.";

/**
 * The file tools, by name: each named from its route
 * (`GET /drives/{drive}/items/{item}/versions` is
 * `drives.items.versions.list`).
 */
export const fileTools = {
  "drives.root.children.list": tool({
    description:
      "Lists the files and folders at the top of a drive (a OneDrive, or a SharePoint document library), a page at a time.",
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "drive",
    routes: [`GET ${rootChildrenRoute}`],
    args: { drive, top, next },
    returns: page(DriveItem),
    handler: async (args, api) => {
      checkDrive(args.drive);
      return itemsIn(
        args.drive,
        await api.get(rootChildrenRoute, {
          path: { drive: args.drive },
          query: {
            $select: select,
            $top: args.top ?? 50,
            ...positionOf(args.next),
          },
          returns: graphPage(DriveItem),
        })
      );
    },
  }),
  "drives.items.children.list": tool({
    description:
      "Lists the files and folders in a folder of a drive (a OneDrive, or a SharePoint document library), a page at a time.",
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "drive",
    routes: [`GET ${childrenRoute}`],
    args: { drive, folder: graphId, top, next },
    returns: page(DriveItem),
    handler: async (args, api) => {
      checkDrive(args.drive);
      checkIds({ folder: args.folder });
      return itemsIn(
        args.drive,
        await api.get(childrenRoute, {
          path: { drive: args.drive, folder: args.folder },
          query: {
            $select: select,
            $top: args.top ?? 50,
            ...positionOf(args.next),
          },
          returns: graphPage(DriveItem),
        })
      );
    },
  }),
  "drives.root.search": tool({
    description:
      "Searches a drive (a OneDrive, or a SharePoint document library) for files and folders by name and content, a page at a time. Items Graph finds in other drives are left out.",
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "drive",
    routes: [`GET ${searchRoute}`],
    args: { drive, q: v.string().min(1).max(256), top, next },
    returns: page(DriveItem),
    handler: async (args, api) => {
      checkDrive(args.drive);
      if (!searchText.test(args.q)) {
        throw new ToolError(
          "Invalid input: q holds a character a path can't carry (/ \\ ? # % ; : or a control)",
          { code: "invalid" }
        );
      }
      return itemsIn(
        args.drive,
        await api.get(searchRoute, {
          // OData quotes a quote by doubling it.
          path: { drive: args.drive, q: args.q.replaceAll("'", "''") },
          query: {
            $select: select,
            $top: args.top ?? 50,
            ...positionOf(args.next),
          },
          returns: graphPage(DriveItem),
        })
      );
    },
  }),
  "drives.items.versions.list": tool({
    description:
      "Lists a file's versions, newest first: when each was saved and by whom. The first on the first page is the current version; read an older one with drives.items.versions.content.download.",
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "drive",
    routes: [`GET ${versionsRoute}`, `GET ${itemRoute}`],
    args: { drive, item: graphId, top, next },
    returns: page(DriveItemVersion),
    handler: async (args, api) => {
      checkDrive(args.drive);
      checkIds({ item: args.item });
      await fileIn(api, args.drive, args.item);
      const answer = await api.get(versionsRoute, {
        path: { drive: args.drive, item: args.item },
        query: { $top: args.top ?? 50, ...positionOf(args.next) },
        returns: graphPage(DriveItemVersion),
      });
      return { items: answer.value, next: nextOf(answer["@odata.nextLink"]) };
    },
  }),
  "drives.items.content.download": tool({
    description: `Reads the current version of a file in a drive (a OneDrive, or a SharePoint document library). ${contentDescription}`,
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "drive",
    answersFile: true,
    routes: [`GET ${contentRoute}`, `GET ${itemRoute}`],
    // Graph answers with a redirect to the file on SharePoint, which the
    // egress follows without the token.
    redirects: { [`GET ${contentRoute}`]: downloadHosts },
    args: { drive, item: graphId, as: readAs.optional() },
    returns: FileContent,
    handler: async (args, api) => {
      checkDrive(args.drive);
      checkIds({ item: args.item });
      const file = await fileIn(api, args.drive, args.item);
      checkSize(file.size);
      const bytes = await api.get(contentRoute, {
        path: { drive: args.drive, item: args.item },
        as: "bytes",
      });
      return contentOf(file, bytes, args.as ?? "text");
    },
  }),
  "drives.items.versions.content.download": tool({
    description: `Reads an older version of a file in a drive, by its ID from drives.items.versions.list, to compare it with the current one. ${contentDescription}`,
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "drive",
    answersFile: true,
    routes: [
      `GET ${versionContentRoute}`,
      `GET ${itemRoute}`,
      `GET ${versionRoute}`,
    ],
    redirects: { [`GET ${versionContentRoute}`]: downloadHosts },
    args: { drive, item: graphId, version: graphId, as: readAs.optional() },
    returns: FileContent,
    handler: async (args, api) => {
      checkDrive(args.drive);
      checkIds({ item: args.item, version: args.version });
      const file = await fileIn(api, args.drive, args.item);
      const path = {
        drive: args.drive,
        item: args.item,
        version: args.version,
      };
      // An older version has its own size, checked before its content is
      // asked for, as the file's is.
      const older = await api.get(versionRoute, {
        path,
        returns: DriveItemVersion,
      });
      checkSize(older.size);
      const bytes = await api.get(versionContentRoute, { path, as: "bytes" });
      return contentOf(file, bytes, args.as ?? "text");
    },
  }),
};
