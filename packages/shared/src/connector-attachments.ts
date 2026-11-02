import { z } from "zod";

import { sha256HexOfBytes } from "./encoding.ts";
import {
  runFileLimits,
  runFileNameSchema,
  runFileTypeSchema,
} from "./run-files.ts";

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

const mib = 1024 * 1024;

/**
 * What one write attaches, at most (GRA-887): inside the provider's
 * request bound for a message that carries its files inline. Microsoft
 * Graph's `sendMail` takes a JSON body of about 4 MB, where each file is
 * base64 (4 bytes for every 3): 2.75 MiB of files is about 3.67 MiB of
 * base64, which leaves room for the message itself. A larger file needs
 * an upload session, a later path.
 */
export const attachmentLimits = {
  /** Files in one write. */
  files: 10,
  /** One file's bytes. */
  fileBytes: 2.75 * mib,
  /** All of one write's files' bytes together. */
  totalBytes: 2.75 * mib,
} as const;

/** A SHA-256 as lowercase hex. */
export const sha256Pattern = /^[0-9a-f]{64}$/u;

/** The name of an input property that carries a write's attachments. */
export const attachmentsProperty = "attachments";

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

/** Run file IDs are random UUIDs, lowercase as `crypto.randomUUID` writes them. */
export const runFileIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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
 * Whether `bytes` are exactly the files `entries` name: a part for each
 * digest and no other, each as long as its entries say and hashing to its
 * key. Equal files (the same digest) are one part; their entries must all
 * give its length.
 */
export const attachmentsMatch = async (
  entries: readonly AttachmentEntry[],
  bytes: Readonly<Record<string, Uint8Array>>
): Promise<boolean> => {
  const wanted = new Map<string, number>();
  for (const { sha256, size } of entries) {
    if ((wanted.get(sha256) ?? size) !== size) {
      return false;
    }
    wanted.set(sha256, size);
  }
  const supplied = Object.keys(bytes);
  if (
    supplied.length !== wanted.size ||
    !supplied.every((sha256) => wanted.has(sha256))
  ) {
    return false;
  }
  const checks = await Promise.all(
    [...wanted].map(async ([sha256, size]) => {
      const part = bytes[sha256];
      return (
        part !== undefined &&
        part.byteLength === size &&
        (await sha256HexOfBytes(part)) === sha256
      );
    })
  );
  return checks.every(Boolean);
};

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
