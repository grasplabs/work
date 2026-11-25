import { tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api, ConnectorTool, Infer } from "@grasp-os/sdk/connector";

import { apisHost, googleScope } from "./google.ts";

// Drafts in a person's own Google Drive: a letter or a summary Stephen
// wrote, as a new Google Doc or text file, for them to finish and send, as
// OneDrive's `files.createDraft` does for Microsoft 365. The tool names no
// drive and no folder: a file it makes goes at the top of the person's own
// My Drive, so it reaches `own`. One upload makes it (a tool sends one
// write), its name saying who wrote it ("Draft from Stephen: ...").
//
// It works under `drive.file`, which reaches only the files this app made
// or the person opened with it, never anything else in their drive,
// whatever its args say. A new file never replaces another: Drive makes
// a new one whatever its name.
//
// Recovery `find`: a draft carries the call's effect key as a private app
// property (`graspEffect`), which only this app reads, so a draft whose
// answer was lost is found by it, and never made twice.

/** What a draft's name starts with, so the person knows who wrote it. */
export const draftPrefix = "Draft from Stephen: ";

const files = `${apisHost}/drive/v3/files`;
const uploads = `${apisHost}/upload/drive/v3/files`;

/** What a draft is made as: Google converts text to a Doc. */
const mimeType = v.enum(["application/vnd.google-apps.document", "text/plain"]);

/** A name with a control character, or blank at either end, is no file name. */
// oxlint-disable-next-line no-control-regex -- controls are refused
const notAName = /[\u0000-\u001F\u007F]|^ | $/u;

const driveFile = v.object({
  id: v.string(),
  name: v.string(),
  mimeType: v.string(),
  webViewLink: v.string().optional(),
});
type DriveFile = Infer<typeof driveFile>;

const fields = "id,name,mimeType,webViewLink";

/**
 * The file of the person's own Drive the call with `key` made, not
 * trashed, if this app can see one. The key is 64 hex characters (connect
 * derives it, the runtime checks it): it can't break out of its quotes.
 */
const madeWith = async (
  api: Api,
  key: string
): Promise<DriveFile | undefined> => {
  const { files: found } = await api.get(files, {
    query: {
      spaces: "drive",
      q: `appProperties has { key='graspEffect' and value='${key}' } and trashed = false`,
      pageSize: 1,
      fields: `files(${fields})`,
    },
    returns: v.object({ files: v.array(driveFile).optional() }),
  });
  return found?.[0];
};

export const draftTools: Readonly<Record<string, ConnectorTool>> = {
  "upload.drive.files.create": tool({
    description: `Writes a new draft document (a Google Doc, or plain text as text/plain) to the person's own Google Drive, named "${draftPrefix}<name>", for them to finish and send. Never replaces a file.`,
    args: {
      name: v.string().min(1).max(200),
      mimeType,
      text: v
        .string()
        .min(1)
        .max(1024 * 1024),
    },
    returns: driveFile,
    readOnly: false,
    reach: "own",
    scopes: [googleScope("drive.file")],
    routes: [`GET ${files}`, `POST ${uploads}`],
    describe: {
      title: "Write a draft document in your Google Drive",
      fields: [
        { label: "File name", arg: "name" },
        { label: "Format", arg: "mimeType" },
        { label: "Text", arg: "text" },
      ],
    },
    handler: async ({ name, mimeType: type, text }, api, { key }) => {
      if (notAName.test(name)) {
        throw new ToolError("Not a file name", { code: "invalid" });
      }
      // One upload of the draft's metadata and its text
      // (`multipart/related`).
      const boundary = `grasp-${crypto.randomUUID()}`;
      const metadata = {
        name: `${draftPrefix}${name}`,
        mimeType: type,
        parents: ["root"],
        ...(key === null ? {} : { appProperties: { graspEffect: key } }),
      };
      const made = await api.post(uploads, {
        query: { uploadType: "multipart", fields },
        contentType: `multipart/related; boundary=${boundary}`,
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
        returns: driveFile,
      });
      if (made.mimeType !== type) {
        throw new ToolError("Drive made the draft as something else", {
          outcomeUnknown: true,
        });
      }
      return made;
    },
    // Made, if a file of the person's carries the call's key.
    find: async (_args, api, { key }) => (await madeWith(api, key)) ?? null,
  }),
};
