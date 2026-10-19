import { z } from "zod";

import { fileLimits, fileTypes, notInFileName } from "./app-file-limits.ts";
import type {
  FileDescription,
  FileType,
  FrameFileMessage,
} from "./app-file-limits.ts";
import { defineErrorFamily } from "./errors.ts";
import { platformLimits } from "./platform-limits.ts";

// An App's files (spec 9.6, 10.7.5, 32.5): what a screen uploads through
// its App's `resource.files` declaration, attaches to records by reference
// (`{ id }`) and reads, downloads or deletes again. Core keeps them in the
// App's store: their record in the store's database (core's
// file-host.ts), their bytes in the deployment's private R2, in chunks.
// What core, the page around a screen's frame and the SDK say to each
// other about them is here and in app-file-limits.ts: the paths of core's
// file channel, the limits, the types a file may be and how its bytes
// show which, and the messages of the frame's file port.
//
// Bytes never travel in a JSON call: the frame hands the page the file it
// picked (a `Blob`, over a port of its own), and the page sends it to core
// in bounded chunks (`appFilesPath`). Reading goes the same way back.

export const fileTypeSchema = z.enum(
  // SAFETY: the keys of `fileTypes`, which `FileType` is.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  Object.keys(fileTypes) as [FileType, ...FileType[]]
);

/**
 * A file's name, as it is shown: no folders, no controls, no invisible
 * formatting (`notInFileName`). Saved, it is `downloadNameOf` it.
 */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(fileLimits.nameLength)
  .refine((name) => !notInFileName.test(name), {
    message:
      "A file name has no /, \\, control or invisible formatting characters",
  })
  .refine((name) => name !== "." && name !== "..", {
    message: "A file name isn't . or ..",
  })
  // Half a surrogate pair is no character: a name holding one can't be
  // encoded, in a download's header or anywhere else.
  .refine((name) => name.isWellFormed(), {
    message: "A file name is well-formed Unicode",
  });

/** A file's ID: a random UUID core mints, which grants nothing. */
export const fileIdSchema = z.uuid();

/** An alias of a files resource, as an App declares it. */
export const fileResourceSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/** A SHA-256 digest, as lower-case hex. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** What the page asks core to start an upload with. */
export const beginUploadSchema = z.strictObject({
  name: fileNameSchema,
  type: fileTypeSchema,
  size: z.int().min(1).max(fileLimits.bytes),
  sha256: sha256HexSchema,
  /**
   * The page's key for this one upload, 128 random bits in hex: a start
   * sent again after a lost answer finds the upload it made.
   */
  key: z.string().regex(/^[0-9a-f]{32}$/u),
});
export type BeginUpload = z.input<typeof beginUploadSchema>;

/** Where an upload is, as core answers its start or a look at it. */
export const uploadStateSchema = z.strictObject({
  file: fileIdSchema,
  state: z.enum(["uploading", "published", "cancelled"]),
  chunkBytes: z.int().min(1),
  /** The chunks core holds, by index. */
  received: z.array(z.int().min(0)).max(fileLimits.chunks),
});
export type UploadState = z.infer<typeof uploadStateSchema>;

/** A file as its reader sees it: never its bytes, nor where they are. */
export const fileDescriptionSchema = z.strictObject({
  id: fileIdSchema,
  name: fileNameSchema,
  mimeType: fileTypeSchema,
  size: z.int().min(1).max(fileLimits.bytes),
}) satisfies z.ZodType<FileDescription>;

/** What a deletion carries: the caller's key, if any. */
export const deleteFileSchema = z.strictObject({
  idempotencyKey: z
    .string()
    .regex(/^[ -~]{1,128}$/u)
    .optional(),
});

export const fileErrors = defineErrorFamily({
  "file.not_found": "That file isn't available.",
  "file.operation_denied":
    "This App's screens may not do that with these files.",
  "file.unavailable": "This App keeps no records, so it keeps no files.",
  "file.invalid": "That isn't a file this App can take.",
  "file.too_large": `A file is at most ${platformLimits.appFileBytes / 1024 / 1024} MB.`,
  "file.type_unsupported":
    "Only PNG, JPEG, GIF and WebP images, PDFs, and plain text or CSV files can be uploaded.",
  "file.content_mismatch":
    "The file's content isn't what it says it is, or changed on the way.",
  "file.incomplete": "Not all of the file has arrived yet.",
  "file.upload_expired": "The upload took too long. Upload the file again.",
  "file.upload_active":
    "An upload is already running here: wait for it, or cancel it first.",
  "file.uploads_open":
    "You have too many uploads open in this App. Finish or cancel one first.",
  "file.unattached_limit":
    "You have too many files that aren't attached to anything here. Attach or delete some first.",
  "file.quota_exceeded":
    "There's no room for this file: the storage for files here is full.",
  "file.gesture_required":
    "A file is downloaded only when you ask for it, with a click.",
  "file.cancelled": "The upload was cancelled.",
  "file.referenced":
    "A record still holds this file. Remove it from the record first.",
});

const callSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * What a frame may send over its file port (`FrameFileMessage`), read by
 * the page before anything else. The file of an upload must be a `File`:
 * its name and type are only what the frame says, checked again by core.
 */
export const frameFileMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("upload"),
    call: callSchema,
    resource: fileResourceSchema,
    file: z.instanceof(Blob),
    name: z.string().max(1024),
  }),
  z.strictObject({ type: z.enum(["cancel", "stop"]), call: callSchema }),
  z.strictObject({
    type: z.enum(["read", "download"]),
    call: callSchema,
    resource: fileResourceSchema,
    file: fileIdSchema,
  }),
  z.strictObject({
    type: z.literal("delete"),
    call: callSchema,
    resource: fileResourceSchema,
    file: fileIdSchema,
    idempotencyKey: z
      .string()
      .regex(/^[ -~]{1,128}$/u)
      .optional(),
  }),
]) satisfies z.ZodType<FrameFileMessage>;
