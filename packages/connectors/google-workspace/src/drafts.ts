import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import type { Effect } from "@grasp-os/connector-kit/connector";
import { z } from "zod";

import { apisHost, googleJson, googleUrl } from "./google.ts";

// Drafts in a person's own Google Drive: a letter or a summary Stephen
// wrote, as a new Google Doc or text file, for them to finish and send, as
// OneDrive's `files.createDraft` does for Microsoft 365. The tool names no
// drive and no folder: a file it makes goes at the top of the person's own
// My Drive, so it reaches `own`. One upload makes it (an action declares
// one write), its name saying who wrote it ("Draft from Stephen: ...").
//
// It works under `drive.file`, which reaches only the files this app made
// or the person opened with it, never anything else in their drive,
// whatever its input says. A new file never replaces another: Drive makes
// a new one whatever its name.
//
// Recovery `find`: a draft carries the call's effect key as a private app
// property (`graspEffect`), which only this app reads, so a draft whose
// answer was lost is found by it, and never made twice.

/** What a draft's name starts with, so the person knows who wrote it. */
export const draftPrefix = "Draft from Stephen: ";

const files = "/drive/v3/files";
const uploads = "/upload/drive/v3/files";

/** What each format is made as: Google converts text to a Doc. */
const mimeTypes = {
  doc: "application/vnd.google-apps.document",
  text: "text/plain",
} as const;

/** A file name: any text, but no controls, and not blank at either end. */
const nameSchema = z
  .string()
  .min(1)
  .max(200)
  // oxlint-disable-next-line no-control-regex -- controls are refused
  .regex(/^(?! )[^\u0000-\u001F\u007F]+(?<! )$/u, {
    message: "Not a file name",
  });

const input = z.strictObject({
  name: nameSchema,
  format: z.enum(["doc", "text"]),
  text: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
type Input = z.output<typeof input>;

const driveFile = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  webViewLink: z.string().nullish(),
});
type DriveFile = z.infer<typeof driveFile>;

const fileList = z.object({ files: z.array(driveFile).nullish() });

const output = z.strictObject({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  webUrl: z.string().nullable(),
});

const fields = "id,name,mimeType,webViewLink";

const outputOf = (file: DriveFile): z.input<typeof output> => ({
  id: file.id,
  name: file.name,
  mimeType: file.mimeType,
  webUrl: file.webViewLink ?? null,
});

/**
 * The file of the person's own Drive the call with `key` made, not
 * trashed, if this app can see one. The key is 64 hex characters (connect
 * derives it, the kit checks it): it can't break out of its quotes.
 */
const madeWith = async (key: string): Promise<DriveFile | undefined> => {
  const { files: found } = await googleJson(
    googleUrl(apisHost, files, {
      spaces: "drive",
      q: `appProperties has { key='graspEffect' and value='${key}' } and trashed = false`,
      pageSize: "1",
      fields: `files(${fields})`,
    }),
    fileList
  );
  return found?.[0];
};

/** One upload of the draft's metadata and its text (`multipart/related`). */
const upload = (
  { name, format, text }: Input,
  { key }: Effect
): RequestInit => {
  const boundary = `grasp-${crypto.randomUUID()}`;
  const metadata = {
    name: `${draftPrefix}${name}`,
    mimeType: mimeTypes[format],
    parents: ["root"],
    ...(key === null ? {} : { appProperties: { graspEffect: key } }),
  };
  return {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      text,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  };
};

const createDraft = defineTool({
  name: "files.createDraft",
  description: `Writes a new draft document (a Google Doc or plain text) to the person's own Google Drive, named "${draftPrefix}<name>", for them to finish and send. Never replaces a file.`,
  input,
  output,
  readOnly: false,
  reach: "own",
  destructive: false,
  routes: [
    { method: "GET", host: apisHost, path: files },
    { method: "POST", host: apisHost, path: uploads },
  ],
  describe: {
    title: "Write a draft document in your Google Drive",
    fields: [
      { label: "File name", input: "name" },
      { label: "Format", input: "format" },
      { label: "Text", input: "text" },
    ],
  },
  run: async (call, effect) => {
    const file = await googleJson(
      googleUrl(apisHost, uploads, { uploadType: "multipart", fields }),
      driveFile,
      upload(call, effect)
    );
    if (file.mimeType !== mimeTypes[call.format]) {
      throw new ToolError("Drive made the draft as something else", {
        outcomeUnknown: true,
      });
    }
    return { output: outputOf(file) };
  },
  // Made, if a file of the person's carries the call's key.
  find: async (_call, { key }) => {
    const made = await madeWith(key);
    return made === undefined ? null : { output: outputOf(made) };
  },
});

export const draftTools = [createDraft];
