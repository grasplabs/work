import { z } from "zod";

import {
  attachmentLimits,
  runFileIdPattern,
  sha256Pattern,
} from "./connector-attachment-rules.ts";
import {
  runFileLimits,
  runFileNameSchema,
  runFileTypeSchema,
} from "./run-files.ts";

export {
  attachmentLimits,
  attachmentsMatch,
  attachmentsProperty,
  runFileIdPattern,
  sha256Pattern,
} from "./connector-attachment-rules.ts";

// Files a workflow's connector write attaches (GRA-887): a native
// connector's write names run files, core resolves them to bytes, and
// connect hands the connector the bytes beside the call's input, never in
// it. What every part of the platform that touches an attachment agrees on
// lives here: the limits, what an input carries for each file, and how
// bytes are checked against it.
//
// An input names each file by digest only (`AttachmentEntry`). That is
// all a held write keeps and all its person is shown; the bytes travel
// beside the input (`AttachmentBytes`), keyed by SHA-256, and are checked
// against the digests wherever they arrive: by connect before it holds or
// sends a call, and again by the connector's own tool before it uses them.

/**
 * One attached file as an input names it: by its digest, never its
 * content. The name is one a run file may have, exactly as written (no
 * trimming), so a tool can use it in a message without changing it.
 */
export const attachmentEntrySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(runFileLimits.nameLength)
    .refine((name) => runFileNameSchema.safeParse(name).data === name, {
      message: "A file name is one a run file may have",
    }),
  type: runFileTypeSchema,
  size: z.int().min(0).max(attachmentLimits.fileBytes),
  sha256: z.string().regex(sha256Pattern),
});
export type AttachmentEntry = z.infer<typeof attachmentEntrySchema>;

/** The bytes of all the entries together, as an input would claim them. */
const totalOf = (entries: readonly AttachmentEntry[]): number =>
  entries.reduce((sum, { size }) => sum + size, 0);

/**
 * An input's attachments: at most {@link attachmentLimits}. A tool that
 * takes files has this as its `attachments` property.
 */
export const attachmentsSchema = z
  .array(attachmentEntrySchema)
  .max(attachmentLimits.files)
  .refine((entries) => totalOf(entries) <= attachmentLimits.totalBytes, {
    message: "A write attaches at most 2.75 MiB together",
  });

/**
 * The same attachments as a workflow's action names them: run files by
 * ID. This is the property a tool that takes files has in its generated
 * contract (the workflow-facing shape), in place of the digests its own
 * input holds: core turns one into the other.
 */
export const attachmentRefsSchema = z
  .array(z.strictObject({ file: z.string().regex(runFileIdPattern) }))
  .max(attachmentLimits.files);

/** Bytes as the schema of a call takes them, keyed by SHA-256. */
export const attachmentBytesSchema = z.record(
  z.string().regex(sha256Pattern),
  z.instanceof(Uint8Array)
);

/** The bytes of attached files, by the SHA-256 of each. */
export type AttachmentBytes = z.infer<typeof attachmentBytesSchema>;

/**
 * One attached file as a person is shown it: its name, type, size and
 * digest, never its content.
 */
export const shownAttachment = ({
  name,
  type,
  size,
  sha256,
}: AttachmentEntry): string =>
  `${name} (${type}, ${String(size)} bytes, SHA-256 ${sha256})`;
