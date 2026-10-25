import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { checkReadable } from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import { fileIn } from "./files.ts";
import {
  downloadHosts,
  driveSchema,
  graphFetch,
  graphHost,
  graphUrl,
  idSchema,
  v1,
} from "./graph.ts";
import { textOf } from "./word.ts";

// Word documents, in one drive per call like the other file tools: a
// person's OneDrive or a SharePoint library, so this reaches `company`.
// files.read hands a .docx back as base64 for something else to unpack;
// this reads its text here, so a person's question about a contract or a
// procedure is answered from its words.

const drives = `${v1}/drives/{drive}`;

/** The most text a read returns, in characters: a long book's worth. */
const maxTextLength = 2 * 1024 * 1024;

const readDocument = defineTool({
  name: "word.read",
  description:
    "Reads the text of a Word document (.docx) in a drive: one line per paragraph, tabs and line breaks kept. Up to 4 MiB.",
  input: z.strictObject({ drive: driveSchema, item: idSchema }),
  output: z.strictObject({
    drive: z.string(),
    id: z.string(),
    name: z.string(),
    lastModifiedAt: z.string().nullable(),
    webUrl: z.string().nullable(),
    text: z.string(),
  }),
  readOnly: true,
  reach: "company",
  resource: "drive",
  routes: [
    { method: "GET", host: graphHost, path: `${drives}/items/{item}` },
    // Graph answers with a redirect to the file on SharePoint, which the
    // egress follows without the token.
    {
      method: "GET",
      host: graphHost,
      path: `${drives}/items/{item}/content`,
      redirects: downloadHosts,
    },
  ],
  run: async ({ drive, item: id }) => {
    const item = await fileIn(drive, id);
    checkReadable(item.size ?? 0);
    const response = await graphFetch(
      graphUrl(`/drives/${segment(drive)}/items/${segment(id)}/content`)
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    checkReadable(bytes.byteLength);
    const text = textOf(bytes);
    if (text === undefined) {
      throw new ToolError(
        "This isn't a Word document: read it with files.read",
        {
          code: "not_text",
        }
      );
    }
    if (text.length > maxTextLength) {
      throw new ToolError("This document's text is too long to return", {
        code: "too_large",
      });
    }
    return {
      output: {
        drive,
        id: item.id,
        name: item.name,
        lastModifiedAt: item.lastModifiedDateTime ?? null,
        webUrl: item.webUrl ?? null,
        text,
      },
      provenance: [item.id],
    };
  },
});

export const documentTools = [readDocument];
