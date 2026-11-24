import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { checkReadable } from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  downloadHosts,
  graphFetch,
  graphHost,
  graphJson,
  graphUrl,
  v1,
} from "./graph.ts";
import { effectKeyOf, wordDocument } from "./word.ts";

// Drafts in a person's own OneDrive: a letter or a summary Stephen wrote,
// as a new file in one folder of theirs, "Drafts from Stephen", for them to
// finish and send. Unlike the other file tools, this one names no drive:
// every route is under `/me/drive`, the signed-in person's own OneDrive, so
// no input can point it at a colleague's drive or a SharePoint site, and it
// reaches `own`. Graph's path addressing is used only here, with the folder
// fixed by this code and the file's name one plain segment, never a path.
// A new file never replaces one: Graph is told to fail on a name taken.

/** The folder of the person's OneDrive drafts go in. */
export const draftsFolder = "Drafts from Stephen";

const me = `${v1}/me/drive/root:/{folder}`;

/**
 * A file name OneDrive takes, without its extension: none of the
 * characters it or the egress refuse, not starting or ending with a space
 * or a dot, and not one of Office's lock-file names (`~$`). One pattern:
 * the kit refuses an input whose JSON Schema splits it into branches.
 */
const nameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    // oxlint-disable-next-line no-control-regex -- controls are refused
    /^(?!~\$)(?![ .])[^"*:<>?/\\|#%;\u0000-\u001F\u007F]+(?<![ .])$/u,
    { message: "Not a file name OneDrive takes" }
  );

const formats = {
  word: { extension: "docx" },
  text: { extension: "txt" },
} as const;

const formatSchema = z.enum(["word", "text"]);
type Format = z.infer<typeof formatSchema>;

const input = z.strictObject({
  name: nameSchema,
  format: formatSchema,
  text: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
type Input = z.output<typeof input>;

const graphFile = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative().nullish(),
  webUrl: z.string().nullish(),
});

const output = z.strictObject({
  folder: z.string(),
  id: z.string(),
  name: z.string(),
  size: z.number().nullable(),
  webUrl: z.string().nullable(),
});

/** The draft's file name, with its format's extension. */
const fileName = (name: string, format: Format): string =>
  `${name}.${formats[format].extension}`;

/** The path of the draft's file, in the drafts folder of the person's own drive. */
const pathOf = ({ name, format }: Input): string =>
  `/me/drive/root:/${segment(draftsFolder)}/${segment(fileName(name, format))}`;

/** The file's bytes: plain text as UTF-8, or a Word document carrying `key`. */
const bytesOf = ({ format, text }: Input, key: string | null): Uint8Array =>
  format === "word" ? wordDocument(text, key) : new TextEncoder().encode(text);

const outputOf = (file: z.infer<typeof graphFile>): z.input<typeof output> => ({
  folder: draftsFolder,
  id: file.id,
  name: file.name,
  size: file.size ?? null,
  webUrl: file.webUrl ?? null,
});

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

const createDraft = defineTool({
  name: "files.createDraft",
  description: `Writes a new draft document (a Word document or plain text) to the "${draftsFolder}" folder of the person's own OneDrive, for them to finish and send. Never replaces a file: a name already taken there is refused.`,
  input,
  output,
  readOnly: false,
  reach: "own",
  destructive: false,
  routes: [
    { method: "GET", host: graphHost, path: `${me}/{name}` },
    // Graph answers a file's content with a redirect to the file on
    // SharePoint, which the egress follows without the token.
    {
      method: "GET",
      host: graphHost,
      path: `${me}/{name}:/content`,
      redirects: downloadHosts,
    },
    { method: "PUT", host: graphHost, path: `${me}/{name}:/content` },
  ],
  describe: {
    title: "Write a draft document in your OneDrive",
    fields: [
      { label: "File name", input: "name" },
      { label: "Format", input: "format" },
      { label: "Text", input: "text" },
    ],
  },
  run: async (call, { key }) => {
    const url = graphUrl(`${pathOf(call)}:/content`);
    url.search = "?@microsoft.graph.conflictBehavior=fail";
    const file = await graphJson(url, graphFile, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytesOf(call, key),
    });
    return { output: outputOf(file) };
  },
  // Made, if the draft's file is there and is the call's: a Word document
  // carrying its key, or text of exactly its bytes. Not there: never made.
  // Something else at its name: a file this call didn't write, or one a
  // person changed since, so whether it was made can't be told.
  find: async (call, { key }) => {
    let file: z.infer<typeof graphFile>;
    try {
      file = await graphJson(
        graphUrl(pathOf(call), { $select: "id,name,size,webUrl" }),
        graphFile
      );
    } catch (error) {
      if (error instanceof ToolError && error.details?.code === "not_found") {
        return null;
      }
      throw error;
    }
    checkReadable(file.size ?? 0);
    const response = await graphFetch(graphUrl(`${pathOf(call)}:/content`));
    const bytes = new Uint8Array(await response.arrayBuffer());
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
    return { output: outputOf(file) };
  },
});

export const draftTools = [createDraft];
