// The Brain's sources as a person reads them on the Brain's Sources page
// (`session.brainSources`): the sources they may read, a page at a time;
// one source's versions and text; and search, which is recall itself for
// that person: the pack as recall answers it, nothing ranked again. Core
// answers each from what the person may read alone, as if nothing else
// existed. A person also uploads a file here, straight into the Brain,
// choosing who may read it; its uploader re-uploads it as its next
// version, and deletes it for good.

import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

/**
 * Who added a source: an upload, a chat, a workflow run, or what an agent
 * fetched through a connection (`capture`).
 */
export type BrainSourceProducer = "upload" | "chat" | "run" | "capture";

/** A source, as its producer names it. */
export interface BrainSourceRef {
  producer: BrainSourceProducer;
  id: string;
}

/**
 * A source the person may read: its current version and when that was
 * added (ISO 8601), its first line as its text gives it (empty when it
 * opens with none), whether it is theirs alone (nobody else sees it,
 * admins included), and how many of its versions they may read.
 */
export interface BrainSourceListed {
  source: BrainSourceRef;
  version: number;
  addedAt: string;
  firstLine: string;
  personal: boolean;
  versions: number;
}

/** Where the next page of sources starts: after this one. */
export interface BrainSourcesAfter {
  addedAt: string;
  source: BrainSourceRef;
}

/** A page of sources, newest first, and where the next starts: null at the last. */
export interface BrainSourcePage {
  sources: BrainSourceListed[];
  next: BrainSourcesAfter | null;
}

/** A page of a source's versions, newest first, and the version the next starts below. */
export interface BrainSourceVersionPage {
  versions: { version: number; addedAt: string }[];
  before: number | null;
}

/** A version of a source, whole. */
export interface BrainSourceText {
  source: BrainSourceRef;
  version: number;
  addedAt: string;
  text: string;
}

/**
 * How recall found a passage: as the question wrote it (`exact`), by its
 * words, by its commonest words alone (`stop words`), or by meaning alone.
 */
export type BrainFoundBy = "exact" | "words" | "stop words" | "meaning";

/** A passage of a pack: where it is, its text, and how it was found. */
export interface BrainSearchItem {
  source: BrainSourceRef;
  version: number;
  /** Its place in the version, from 0. */
  position: number;
  text: string;
  /** Whether `text` is the whole passage, not its best part. */
  whole: boolean;
  found: BrainFoundBy;
}

/**
 * How recall found a memory: by its words, along the entities the
 * question names, or as another side of a contested fact it found.
 */
export type BrainMemoryFoundBy = "words" | "entities" | "contested";

/**
 * A memory of a pack: the Brain's store it is in (the person's own, theirs
 * alone, or the shared one) and that store's id for it; what it says; the
 * words of its source it rests on and the passage around them, when the
 * pack holds them; the source's version it was drawn from, if any, and
 * whose word it is (`said`: the person's own, another person's, an
 * outside party's, an agent's or a system's, as its producer said it);
 * whether a person confirmed it, whether sources disagree on it, and how
 * it was found.
 */
export interface BrainSearchMemory {
  store: "own" | "shared";
  id: string;
  statement: string;
  quote: string | null;
  context: { position: number; text: string } | null;
  source: { source: BrainSourceRef; version: number } | null;
  said: "you" | "person" | "outside" | "agent" | "system";
  confirmed: boolean;
  contested: boolean;
  found: BrainMemoryFoundBy;
}

/**
 * What a search found, as recall packs it: the passages and the memories,
 * each best first (a contested memory with every other side of its fact
 * right after it, or none of them); the parts of the question nothing the
 * person may read holds; and whether the budget left something out.
 */
export interface BrainSearchPack {
  items: BrainSearchItem[];
  memories: BrainSearchMemory[];
  notFound: string[];
  truncated: boolean;
}

/**
 * The first line of `text` that holds something, trimmed: a source's
 * title, as its listing and its page show it. Empty when none does.
 */
export const firstLineOf = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** Most characters of a question: the Brain's own limit, which the search box holds to too. */
export const brainQuestionMaxLength = 2000;

/** How many tokens a search's pack may hold (the Brain's own estimate). */
export const brainSearchBudget = 4000;

/**
 * Who may read an upload, as its uploader chooses: only them (nobody
 * else, admins included), one of their teams, or everyone in the
 * organization. Fixed for the upload's life: other readers are a new
 * upload.
 */
export const brainUploadReadersSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("me") }),
  z.strictObject({ kind: z.literal("team"), teamId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("everyone") }),
]);
export type BrainUploadReaders = z.infer<typeof brainUploadReadersSchema>;

/** A file to upload into the Brain: its name and itself. */
export interface BrainUploadFile {
  /** Such as `Travel policy.docx`: its type is read from its extension. */
  name: string;
  bytes: Uint8Array;
}

/** An upload in the Brain, as the person may act on it. */
export interface BrainUpload {
  source: BrainSourceRef;
  readers: BrainUploadReaders;
  /** Whether they may upload its next version: its uploader alone. */
  mayAddVersion: boolean;
  /**
   * Whether they may delete it, which erases it for good: its uploader,
   * when it is theirs alone; an admin, when it is shared with a team or
   * everyone. Its uploader asks an admin to remove a shared one.
   */
  mayDelete: boolean;
}

/**
 * An upload shared with a team or everyone, as an admin's listing shows
 * it to erase: its file's name, who may read it, who uploaded it and
 * when. Never its text.
 */
export interface BrainSharedUpload {
  source: BrainSourceRef;
  /**
   * The file's name: null when the admin may not read the upload (a
   * team's they aren't in), as its name is its readers' alone too.
   */
  name: string | null;
  readers: BrainUploadReaders;
  /** The team's name, for a team's upload: null for everyone's, and for a team since deleted. */
  teamName: string | null;
  uploaderName: string;
  /** ISO 8601. */
  uploadedAt: string;
}

/** Where the next page of shared uploads starts: after this one. */
export interface BrainSharedUploadsAfter {
  uploadedAt: string;
  id: string;
}

/** A page of shared uploads, newest first, and where the next starts: null at the last. */
export interface BrainSharedUploadPage {
  uploads: BrainSharedUpload[];
  next: BrainSharedUploadsAfter | null;
}

/** The Brain's sources, for the person signed in. */
export interface BrainSourcesApi {
  /** A page of the sources they may read, newest first, after `after`. */
  list: (after?: BrainSourcesAfter | null) => Promise<BrainSourcePage>;
  /** A page of a source's versions they may read, newest first, below `before`. */
  versions: (
    source: BrainSourceRef,
    before?: number
  ) => Promise<BrainSourceVersionPage>;
  /** A version of a source, whole: null when there is none or they may not read it, alike. */
  read: (
    source: BrainSourceRef,
    version: number
  ) => Promise<BrainSourceText | null>;
  /** Recall for `question` as them, within `brainSearchBudget` tokens. */
  search: (question: string) => Promise<BrainSearchPack>;
  /**
   * Uploads `file` into the Brain for `readers`: a new source, its text
   * read from the file, findable at once. Returns its first version.
   */
  upload: (
    file: BrainUploadFile,
    readers: BrainUploadReaders,
    /**
     * The upload's id, a UUID the page mints for the file it was given
     * and sends again when it retries: a retry is the same upload.
     */
    uploadId: string
  ) => Promise<{ source: BrainSourceRef; version: number }>;
  /** Uploads `file` as the next version of their upload `uploadId`, for the same readers. */
  uploadVersion: (
    uploadId: string,
    file: BrainUploadFile,
    /**
     * The version's id, a UUID the page mints for the file it was given
     * and sends again when it retries: a retry is the same version.
     */
    versionId: string
  ) => Promise<{ source: BrainSourceRef; version: number }>;
  /** An upload they may read, with what they may do to it: null when there is none or they may not read it, alike. */
  uploadOf: (uploadId: string) => Promise<BrainUpload | null>;
  /** Deletes an upload for good: every version, from the Brain and core alike. */
  deleteUpload: (uploadId: string) => Promise<void>;
  /**
   * For an admin: a page of the uploads shared with a team or everyone,
   * newest first, after `after`, to erase one they may not read.
   */
  sharedUploads: (
    after?: BrainSharedUploadsAfter | null
  ) => Promise<BrainSharedUploadPage>;
}

/**
 * Why core's Brain refused a call: a producer's add it refuses (final,
 * never retried), or an argument that isn't of the kind the call takes.
 */
export const brainSourceErrors = defineErrorFamily({
  "brain.source_erased":
    "What this adds was erased: it stays erased, and isn't added.",
  "brain.request_invalid": "That isn't a valid request to the Brain.",
  "brain.source_change_taken":
    "This change was added before with other text or readers; nothing changed.",
  "brain.source_no_text": "There's no text in this to keep.",
  "brain.source_too_large": "This text is too large for the Brain to keep.",
});

export const brainUploadErrors = defineErrorFamily({
  "brain.upload_not_found": "There's no such upload, or you can't see it.",
  "brain.upload_admin_only":
    "Only an admin can remove an upload shared with a team or everyone. Ask an admin to remove it.",
  "brain.upload_not_allowed":
    "Only the person who uploaded this file can do that (or an admin can delete it, when it isn't one person's own).",
  "brain.upload_readers":
    "You can share an upload only with yourself, a team you're in, or everyone.",
  "brain.upload_deleted":
    "This upload was deleted, so it takes no new version.",
  "brain.upload_text_too_long":
    "This file's text is too long to keep. Split it into smaller files and upload those.",
  "brain.upload_other_file":
    "This upload was already made with another file, which is kept as it was. Choose the file again to upload it as a new upload, or add it as a new version.",
  "brain.upload_retry_refused":
    "This upload can't go on. Choose the file again to upload it.",
  "brain.upload_busy":
    "Files are being read for many people at the moment. Upload it again in a minute.",
});
