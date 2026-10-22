import { z } from "zod";

import { notInFileName } from "./app-file-limits.ts";
import { defineErrorFamily } from "./errors.ts";

// A workflow run's own files (GRA-724): what its actions write through a
// `files` binding and read back, by reference, in later steps of the same
// run. Core keeps the bytes in the deployment's private R2 (EU), in
// chunks, and their record in its own database; a file is its run's
// alone, and goes with the run's details (RUN_RETENTION_DAYS). Nothing of
// it leaves the run but through the bindings the run already has.

const kib = 1024;
const mib = 1024 * kib;
const gib = 1024 * mib;

/** The limits of run files (GRA-724 decision 6), by what they bound. */
export const runFileLimits = {
  /**
   * One file's bytes: what one task's attempt can write of it, in its 32
   * calls of `callBytes` each, its open and finish among them.
   */
  fileBytes: 15 * mib,
  /** All of one run's files' bytes, finished or being written. */
  runBytes: 100 * mib,
  /** One run's files, finished or being written. */
  runFiles: 100,
  /** One run's files being written at once. */
  openWrites: 8,
  /** All of one workflow's live run files' bytes, over its runs. */
  workflowBytes: 5 * gib,
  /**
   * Bytes one call writes or reads: as base64 (a third more) inside the
   * call's JSON, it stays within a step's payload (1 MiB).
   */
  callBytes: 512 * kib,
  /** How long a file may stay unfinished before it is swept. */
  orphanMs: 24 * 60 * 60 * 1000,
  /** Longest file name, in characters. */
  nameLength: 200,
} as const;

/**
 * The types a run file may be (GRA-724 decision 4): each shown by its
 * bytes (`runFileTypeOfBytes`), none a browser runs.
 */
export const runFileTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export type RunFileType = (typeof runFileTypes)[number];

/** The text types: UTF-8 with no NUL, and no binary signature. */
export const runFileTextTypes: ReadonlySet<RunFileType> = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, at) => bytes[at] === byte);

const ascii = (text: string): number[] =>
  Array.from(text, (character) => character.codePointAt(0) ?? 0);

/** A ZIP's local file header: Office documents are ZIP packages. */
const zip = [0x50, 0x4b, 0x03, 0x04];

/** The binary types, by the bytes they start with. */
const signatures: readonly (readonly [
  RunFileType,
  (bytes: Uint8Array) => boolean,
])[] = [
  [
    "image/png",
    (bytes) =>
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ],
  ["image/jpeg", (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  [
    "image/gif",
    (bytes) =>
      startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")),
  ],
  [
    "image/webp",
    (bytes) =>
      startsWith(bytes, ascii("RIFF")) &&
      startsWith(bytes.subarray(8), ascii("WEBP")),
  ],
  ["application/pdf", (bytes) => startsWith(bytes, ascii("%PDF-"))],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    (bytes) => startsWith(bytes, zip),
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    (bytes) => startsWith(bytes, zip),
  ],
];

/**
 * Whether a file declared as `declared`, whose first bytes are `head`,
 * shows that type: a binary type by its signature; a text type by
 * having none (whether all of it is UTF-8 is the writer's to check, as
 * its bytes go by). The declared label alone is never trusted.
 */
export const runFileTypeOfBytes = (
  head: Uint8Array,
  declared: RunFileType
): boolean => {
  const signed = signatures
    .filter(([, matches]) => matches(head))
    .map(([type]) => type);
  return runFileTextTypes.has(declared)
    ? signed.length === 0
    : signed.includes(declared);
};

/** A run file's name: no folders, no controls, no invisible formatting. */
export const runFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(runFileLimits.nameLength)
  .refine((name) => !notInFileName.test(name), {
    message:
      "A file name has no /, \\, control or invisible formatting characters",
  })
  .refine((name) => name !== "." && name !== "..", {
    message: "A file name isn't . or ..",
  })
  .refine((name) => name.isWellFormed(), {
    message: "A file name is well-formed text",
  });

export const runFileTypeSchema = z.enum(runFileTypes);

/**
 * The extension a run file of a type must be named with (GRA-886): a Word
 * or Excel document's, so a file typed as one never carries the name of
 * another (a macro-enabled `.docm`, say) that an app would open as that.
 */
const runFileExtensions: Partial<Record<RunFileType, string>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

/** `text` with ASCII letters in lower case, and nothing else changed. */
const asciiLower = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** Whether `name` carries the extension a file of `type` must, if any. */
export const runFileNameFits = (name: string, type: RunFileType): boolean => {
  const extension = runFileExtensions[type];
  return extension === undefined || asciiLower(name).endsWith(extension);
};

/** What a file with no name left once its extension goes is named. */
const unnamedStem = "document";

/**
 * `name`, a run file's, as a file of `type` is named: as it is when it
 * fits (`runFileNameFits`); otherwise its last extension replaced by the
 * type's, within a run file name's length.
 */
export const runFileNamed = (name: string, type: RunFileType): string => {
  const extension = runFileExtensions[type];
  if (extension === undefined || runFileNameFits(name, type)) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = (dot === -1 ? name : name.slice(0, dot))
    .slice(0, runFileLimits.nameLength - extension.length)
    .trim();
  return `${stem === "" ? unnamedStem : stem}${extension}`;
};

/**
 * The run-file type a file someone else made shows (GRA-886), from its
 * bytes: a binary type by its signature, never by the label it came with,
 * which only names a text type, for bytes with no signature. Undefined
 * when the bytes show none a run file may be, and for a ZIP: a Word and
 * an Excel document are both ZIPs, which only the package's own content
 * types tell apart (core reads them), never the label. Whether all of a
 * text file is UTF-8 is checked as the file is finished.
 */
export const runFileTypeOf = (
  bytes: Uint8Array,
  label: string | null
): RunFileType | undefined => {
  const head = bytes.subarray(0, 16);
  const signed = signatures
    .filter(([, matches]) => matches(head))
    .map(([type]) => type);
  if (signed.length > 0) {
    return signed.length === 1 ? signed[0] : undefined;
  }
  const said = (label ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const text = runFileTypeSchema.safeParse(said);
  return text.success && runFileTextTypes.has(text.data)
    ? text.data
    : undefined;
};

/** Whether `bytes` start as a ZIP does: an Office document's package. */
export const isZip = (bytes: Uint8Array): boolean => startsWith(bytes, zip);

/** A run file's ID: a random UUID, which grants nothing outside its run. */
export const runFileIdSchema = z.uuid();

/**
 * A finished run file, as its run's actions hand it on: holding one
 * grants nothing outside the run that wrote it.
 */
export interface RunFileRef {
  readonly file: string;
  readonly name: string;
  readonly type: RunFileType;
  readonly size: number;
  readonly sha256: string;
}

export const runFileErrors = defineErrorFamily({
  "file.run_too_large": `A run's file is at most ${runFileLimits.fileBytes / mib} MB.`,
  "file.run_full": `A run keeps at most ${runFileLimits.runFiles} files and ${runFileLimits.runBytes / mib} MB of them.`,
  "file.writes_open": `A run writes at most ${runFileLimits.openWrites} files at once: finish one first.`,
  "file.workflow_quota": `This workflow's runs keep at most ${runFileLimits.workflowBytes / gib} GB of files: older runs' files go with their details.`,
  "file.run_type_unsupported":
    "A run's file is a PNG, JPEG, GIF or WebP image, a PDF, a Word or Excel document, or plain text, CSV, Markdown or JSON.",
  "file.not_writable":
    "That file isn't being written by this task: only the task that started it writes it, until it is finished.",
  "file.not_finished": "That file isn't finished yet.",
});
