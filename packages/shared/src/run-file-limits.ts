// What a run file may be (GRA-724): its limits and its types. Kept apart
// from run-files.ts, and free of dependencies, so a connector's isolate can
// declare a write's attachments by them without loading Zod.

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
  /**
   * How long a start's copy may stay unadmitted before it is swept: a
   * copy is made and admitted within one start, so one left this long was
   * never admitted (GRA-885).
   */
  startOrphanMs: 60 * 60 * 1000,
  /** Longest file name, in characters. */
  nameLength: 200,
  /**
   * An App's files one start hands its run (GRA-885): each copied while
   * the page's start waits, so few, within the run's own limits.
   */
  startFiles: 10,
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
