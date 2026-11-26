import { tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api, ToolArgs } from "@grasp-os/sdk/connector";

import { checkSize, downloadHosts } from "./files.ts";
import { effectKeyOf, wordDocument } from "./word.ts";

// Drafts in a person's own OneDrive: a letter or a summary Stephen wrote,
// as a new file in one folder of theirs, "Drafts from Stephen", for them to
// finish and send. Unlike the other file tools, this one names no drive:
// every route is under `/me/drive`, the signed-in person's own OneDrive, so
// no argument can point it at a colleague's drive or a SharePoint site, and
// it reaches `own`. Graph's path addressing is used only here, with the
// folder fixed by this code and the file's name one plain segment, never a
// path. A new file never replaces one: Graph is told to fail on a name
// taken.
//
// Path addressing (`root:/...:`) has no name the naming rule can read, so
// the tool takes Graph's own operation name for this write, "Upload"
// (driveItem's methods), under the route's literal segments.

/** The folder of the person's OneDrive drafts go in. */
const draftsFolder = "Drafts from Stephen";

const fileRoute = "/me/drive/root:/{folder}/{name}";
const contentRoute = "/me/drive/root:/{folder}/{name}:/content";

/**
 * A file name OneDrive takes, without its extension: none of the
 * characters it or the egress refuse, not starting or ending with a space
 * or a dot, and not one of Office's lock-file names (`~$`).
 */
const fileNamePattern =
  // oxlint-disable-next-line no-control-regex -- controls are refused
  /^(?!~\$)(?![ .])[^"*:<>?/\\|#%;\u0000-\u001F\u007F]+(?<![ .])$/u;

const extensions = { word: "docx", text: "txt" } as const;

const args = {
  name: v.string().min(1).max(200),
  format: v.enum(["word", "text"]),
  text: v
    .string()
    .min(1)
    .max(1024 * 1024),
};
type Args = ToolArgs<typeof args>;

/** A file of the person's own OneDrive (Graph's driveItem), narrowed. */
const DriveItem = v.object({
  id: v.string(),
  name: v.string(),
  size: v.number().integer().min(0).nullable().optional(),
  webUrl: v.string().nullable().optional(),
});

/** Refuses, before anything is sent, a name OneDrive wouldn't take. */
const checkName = (name: string): void => {
  if (!fileNamePattern.test(name)) {
    throw new ToolError(
      "Invalid input: name isn't a file name OneDrive takes",
      { code: "invalid" }
    );
  }
};

/** The path of the draft's file, in the drafts folder of the person's own drive. */
const pathOf = ({ name, format }: Args) => ({
  folder: draftsFolder,
  name: `${name}.${extensions[format]}`,
});

/** The file's bytes: plain text as UTF-8, or a Word document carrying `key`. */
const bytesOf = ({ format, text }: Args, key: string | null): Uint8Array =>
  format === "word" ? wordDocument(text, key) : new TextEncoder().encode(text);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

/** The file at the draft's name, or null if there is none. */
const fileAt = async (api: Api, call: Args) => {
  try {
    return await api.get(fileRoute, {
      path: pathOf(call),
      query: { $select: "id,name,size,webUrl" },
      returns: DriveItem,
    });
  } catch (error) {
    if (error instanceof ToolError && error.details?.code === "not_found") {
      return null;
    }
    throw error;
  }
};

/** The draft tool, by name. */
export const draftTools = {
  "me.drive.root.content.upload": tool({
    description: `Uploads a new draft document (a Word document or plain text) to the "${draftsFolder}" folder of the person's own OneDrive, for them to finish and send. Never replaces a file: a name already taken there is refused.`,
    readOnly: false,
    reach: "own",
    scopes: ["Files.ReadWrite"],
    routes: [`PUT ${contentRoute}`, `GET ${fileRoute}`, `GET ${contentRoute}`],
    // Graph answers a file's content with a redirect to the file on
    // SharePoint, which the egress follows without the token.
    redirects: { [`GET ${contentRoute}`]: downloadHosts },
    args,
    returns: DriveItem,
    describe: {
      title: "Write a draft document in your OneDrive",
      fields: [
        { label: "File name", arg: "name" },
        { label: "Format", arg: "format" },
        { label: "Text", arg: "text" },
      ],
    },
    handler: async (call, api, { key }) => {
      checkName(call.name);
      // Graph's 409 to a name taken reaches the caller as a failure, not
      // as their input's: a name taken is refused here first, and
      // `conflictBehavior=fail` still holds against one taken since.
      if ((await fileAt(api, call)) !== null) {
        throw new ToolError(
          "Invalid input: a file in the drafts folder already has this name",
          { code: "invalid" }
        );
      }
      return await api.put(contentRoute, {
        path: pathOf(call),
        query: { "@microsoft.graph.conflictBehavior": "fail" },
        body: bytesOf(call, key),
        contentType: "application/octet-stream",
        returns: DriveItem,
      });
    },
    // Made, if the draft's file is there and is the call's: a Word document
    // carrying its key, or text of exactly its bytes. Not there: never made.
    // Something else at its name: a file this call didn't write, or one a
    // person changed since, so whether it was made can't be told.
    find: async (call, api, { key }) => {
      checkName(call.name);
      const file = await fileAt(api, call);
      if (file === null) {
        return null;
      }
      checkSize(file.size);
      const bytes = await api.get(contentRoute, {
        path: pathOf(call),
        as: "bytes",
      });
      const isCalls =
        call.format === "word"
          ? effectKeyOf(bytes) === key
          : sameBytes(bytes, bytesOf(call, key));
      if (!isCalls) {
        throw new ToolError(
          "Another file is at the draft's name: whether the draft was written can't be told",
          { code: "failed" }
        );
      }
      return file;
    },
  }),
};
