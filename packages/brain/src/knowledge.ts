import { z } from "zod";

import { searchQueryMaxLength } from "./contract.ts";
import { errorFamily } from "./errors.ts";
import { collectionIdSchema, documentIdSchema, idSchema } from "./ids.ts";
import type { CollectionId, DocumentId } from "./ids.ts";

// The Brain's documents: Markdown with typed frontmatter, in collections.
// A save never overwrites: it adds a version, and names the version it was
// edited from, so two writers at once get a conflict instead of losing a
// change. Only a purge rewrites versions: erasing data from all of them.

/** Longest document path, in characters. */
export const documentPathMaxLength = 512;

// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const controlCharacters = /[\u0000-\u001F\u007F]/u;

/** Characters `[[path#heading|label]]` links use, so no path has them. */
const linkSyntax = /[[\]#|]/u;

/**
 * Why `path` isn't a document path, or `undefined` when it is one. A path is
 * relative, with `/` between folders, and names one document in its
 * collection, such as `handbook/leave.md`.
 */
export const documentPathProblem = (path: string): string | undefined => {
  if (path.length === 0 || path.length > documentPathMaxLength) {
    return `A path has 1 to ${documentPathMaxLength} characters`;
  }
  if (controlCharacters.test(path) || path.includes("\\")) {
    return "A path has no control characters or backslashes";
  }
  if (linkSyntax.test(path)) {
    return "A path has no [, ], # or |";
  }
  if (
    path
      .split("/")
      .some(
        (segment) =>
          segment.trim() === "" || segment === "." || segment === ".."
      )
  ) {
    return "A path has no empty, blank, '.' or '..' folders and doesn't start or end with /";
  }
  return undefined;
};

/**
 * A `[[link]]` in Markdown: `inner` is its target, then its label after
 * any `|`. Global, for `matchAll`.
 */
export const wikiLinkPattern = /\[\[(?<inner>[^[\]\n]+)\]\]/gu;

const extension = /\.[^./]+$/u;

/**
 * The path a `[[link]]` names, from its target (the part before any `|`):
 * relative to the collection, with `.md` added when it names no
 * extension. `undefined` when it isn't a document path. Core indexes
 * links by it, and the web app resolves them by it.
 */
export const linkPath = (target: string): string | undefined => {
  const [withoutHeading = ""] = target.split("#");
  const trimmed = withoutHeading.trim();
  if (trimmed === "") {
    // A link to a heading in the same document.
    return undefined;
  }
  const path = extension.test(trimmed) ? trimmed : `${trimmed}.md`;
  return documentPathProblem(path) === undefined ? path : undefined;
};

export const documentPathSchema = z.string().superRefine((path, context) => {
  const problem = documentPathProblem(path);
  if (problem !== undefined) {
    context.addIssue({ code: "custom", message: problem });
  }
});

const frontmatterFence = /^---[ \t]*$/u;
const lineBreak = /\r?\n/u;
const byteOrderMark = "\uFEFF";

/**
 * A document's frontmatter, the YAML between `---` lines at its top (after
 * a byte order mark, if it has one), and the Markdown after it: `yaml` is
 * `undefined` when it has none, and the whole is `undefined` when it opens
 * a block it never closes, which core refuses to save. Core reads
 * frontmatter by it, and the web app leaves it out of the rendered text.
 */
export const splitFrontmatterBlock = (
  text: string
): { yaml: string | undefined; body: string } | undefined => {
  const source = text.startsWith(byteOrderMark) ? text.slice(1) : text;
  const lines = source.split(lineBreak);
  if (!frontmatterFence.test(lines[0] ?? "")) {
    return { yaml: undefined, body: source };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && frontmatterFence.test(line)
  );
  if (end === -1) {
    return undefined;
  }
  return {
    yaml: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
};

/** A version number: 1 for a document's first version. */
const versionSchema = z.int().min(1);

/**
 * A save: the whole Markdown text of the document at `path`, and the
 * version it was edited from (`ifVersion`, 0 for a new document). If the
 * document has moved past that version, nothing is saved.
 */
export const saveInputSchema = z.strictObject({
  collectionId: collectionIdSchema,
  path: documentPathSchema,
  text: z.string(),
  ifVersion: z.int().min(0),
  /** What changed, for the history. */
  message: z.string().trim().max(500).optional(),
});
export type SaveInput = z.input<typeof saveInputSchema>;

/** A restore: an earlier version's text becomes the next version. */
export const restoreInputSchema = z.strictObject({
  documentId: documentIdSchema,
  version: versionSchema,
  ifVersion: versionSchema,
});
export type RestoreInput = z.input<typeof restoreInputSchema>;

export const versionInputSchema = versionSchema;

/** Most entries one page of a listing holds. */
export const pageMaxLimit = 200;

/** A page of documents: in path order, after `after`. */
export const listDocumentsOptionsSchema = z
  .strictObject({
    after: documentPathSchema.optional(),
    limit: z.int().min(1).max(pageMaxLimit).default(pageMaxLimit),
  })
  .default({ limit: pageMaxLimit });
export type ListDocumentsOptions = z.input<typeof listDocumentsOptionsSchema>;

/** A page of history: newest first, before version `before`. */
export const historyOptionsSchema = z
  .strictObject({
    before: versionSchema.optional(),
    limit: z.int().min(1).max(pageMaxLimit).default(pageMaxLimit),
  })
  .default({ limit: pageMaxLimit });
export type HistoryOptions = z.input<typeof historyOptionsSchema>;

/** The kinds of document the platform knows, each with its own frontmatter. */
export const builtinDocumentTypeSchema = z.enum([
  "doc",
  "skill",
  "memory",
  "decision",
  "file",
]);
export type BuiltinDocumentType = z.infer<typeof builtinDocumentTypeSchema>;

const builtinDocumentTypes: ReadonlySet<string> = new Set(
  builtinDocumentTypeSchema.options
);

/** Whether `type` is one the platform knows, rather than one an older document names. */
export const isBuiltinDocumentType = (
  type: string
): type is BuiltinDocumentType => builtinDocumentTypes.has(type);

/**
 * A document's type: one the platform knows (`builtinDocumentTypeSchema`),
 * or, read from an older document only, any other its frontmatter names:
 * lowercase letters, digits and single hyphens, starting with a letter. A
 * save needs a type the platform knows (`parseFrontmatter` in core).
 */
export const documentTypeSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
    "Lowercase letters, digits and single hyphens, starting with a letter"
  );
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * A stored document's type, as this release reads it: one that isn't a
 * type's name at all reads as a plain `doc`.
 */
export const documentTypeOf = (stored: string): DocumentType =>
  documentTypeSchema.safeParse(stored).data ?? "doc";

/** A document's current state, without its text. */
export interface DocumentSummary {
  id: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  type: DocumentType;
  /** When to use it: what agents see before they read it. */
  description: string;
  /** Its owner, from its frontmatter, or the person who created it. */
  owner: string;
  tags: string[];
  /** When it should be reviewed (`YYYY-MM-DD`), if set. */
  reviewDate: string | null;
  currentVersion: number;
  /**
   * The version search holds: `currentVersion` once indexed, an older one
   * (or `null`, for a new document) while indexing catches up.
   */
  indexedVersion: number | null;
  /**
   * Where indexing the current version stands. A save is done when it
   * returns; search has it only once this is `indexed`.
   */
  indexing: DocumentIndexing;
  /** ISO 8601. */
  updatedAt: string;
}

/** Where indexing a document's current version stands. */
export const documentIndexingStates = [
  "queued",
  "retrying",
  "indexed",
  "failed",
] as const;
export type DocumentIndexing = (typeof documentIndexingStates)[number];

/** One version in a document's history, without its text. */
export interface VersionSummary {
  number: number;
  /** The user ID of the person who saved it. */
  author: string;
  message: string | null;
  /** The version it restored, if it was a restore. */
  restoredFrom: number | null;
  /**
   * Its text's SHA-256, in lowercase hex: what a citation of it pins, and
   * what every read of its text is checked against. It identifies the text,
   * so it goes only to those who may read the version: keep it out of
   * logs, audit details and anything a reader of the document can't see.
   */
  sha256: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A version with its whole text, frontmatter included. */
export interface Version extends VersionSummary {
  text: string;
}

/**
 * Where what a read returned comes from, so whoever builds on it (an agent,
 * an App, a sharing check) can label what it derives from it.
 */
export interface Provenance {
  /** The collections it was read from. */
  collectionIds: CollectionId[];
  /** Some of it is from a sensitive collection: the model data rules apply. */
  sensitive: boolean;
  /**
   * Some of it is restricted data: the chat, App or run that read it can no
   * longer act on or fetch from outside systems. In Knowledge, restricted
   * data is what a sensitive collection holds.
   */
  restricted: boolean;
}

/** A document with one of its versions. */
export interface DocumentRead extends DocumentSummary {
  version: Version;
  provenance: Provenance;
}

/** A page of a collection's documents. */
export interface DocumentPage {
  documents: DocumentSummary[];
  provenance: Provenance;
}

/** A page of a document's history. */
export interface HistoryPage {
  versions: VersionSummary[];
  provenance: Provenance;
}

/** A document that links to another one. */
export interface Backlink {
  documentId: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  /** The link's own text (`[[path|label]]`), if it has one. */
  label: string | null;
}

/** A page of the documents that link to one document. */
export interface BacklinkPage {
  backlinks: Backlink[];
  provenance: Provenance;
}

/** Longest search query, in characters. */

/** Most results one search returns. */
export const searchMaxLimit = 50;

const searchDefaultLimit = 20;

/** A search's words, as someone typed them: no query syntax. */
export const searchQuerySchema = z.string().max(searchQueryMaxLength);

/**
 * How many results a search on one collection returns, best first, and of
 * which type of document only, if one is given.
 */
export const collectionSearchOptionsSchema = z
  .strictObject({
    type: documentTypeSchema.optional(),
    limit: z.int().min(1).max(searchMaxLimit).default(searchDefaultLimit),
  })
  .default({ limit: searchDefaultLimit });
export type CollectionSearchOptions = z.input<
  typeof collectionSearchOptionsSchema
>;

/**
 * Where to search, for which type of document, and how many results to
 * return, best first.
 */
export const searchOptionsSchema = z
  .strictObject({
    /** Only this collection; otherwise every one the reader may read. */
    collectionId: collectionIdSchema.optional(),
    /** Only documents of this type, such as `skill`; otherwise any. */
    type: documentTypeSchema.optional(),
    limit: z.int().min(1).max(searchMaxLimit).default(searchDefaultLimit),
  })
  .default({ limit: searchDefaultLimit });
export type SearchOptions = z.input<typeof searchOptionsSchema>;

/** A section that matched a search, with its document. */
export interface SearchHit {
  documentId: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  type: DocumentType;
  description: string;
  /** The section's place in its document, from 0. */
  section: number;
  /**
   * The version the section is of: the document's indexed one, which can
   * be older than its current one while indexing catches up.
   */
  version: number;
  /** The headings above and of the section, outermost first. */
  headings: string[];
  /** Plain text from the section, around what matched. */
  snippet: string;
}

/**
 * What a search couldn't look at: readable documents in its scope whose
 * current version isn't indexed yet (`pending`) or failed to be
 * (`failed`), counted up to {@link searchCoverageCap}. Search finds them
 * by the version it last indexed, if any.
 */
export interface SearchCoverage {
  pending: number;
  failed: number;
}

/** Most documents a search's coverage counts of each kind. */
export const searchCoverageCap = 1000;

/** A search's results, best first, and where they come from. */
export interface SearchResults {
  hits: SearchHit[];
  coverage: SearchCoverage;
  provenance: Provenance;
}

/**
 * Which part of a document to read: one section, by its place from 0 (a
 * search hit's `section`), or the whole document when none is given.
 */
export const readOptionsSchema = z
  .strictObject({ section: z.int().min(0).optional() })
  .default({});
export type ReadOptions = z.input<typeof readOptionsSchema>;

/**
 * A document or one of its sections, at its current version. A section is
 * its Markdown from its heading to the next one; a whole document is its
 * text, frontmatter included.
 */
export interface KnowledgeRead extends DocumentSummary {
  /** The section read, or `null` for the whole document. */
  section: {
    /** Its place in its document, from 0. */
    position: number;
    /** The version it is of, as a search hit's (`SearchHit.version`). */
    version: number;
    /** The headings above and of the section, outermost first. */
    headings: string[];
  } | null;
  text: string;
  provenance: Provenance;
}

/** A `[[link]]` in a document, and the document it names, if there is one. */
export interface DocumentLink {
  path: string;
  /** The link's own text (`[[path|label]]`), if it has one. */
  label: string | null;
  /** `null` while no document is at `path`. */
  documentId: DocumentId | null;
  title: string | null;
}

/** A document in a skill's folder: one of the files the skill refers to. */
export interface SkillFile {
  documentId: DocumentId;
  path: string;
  title: string;
  type: DocumentType;
  description: string;
}

/** Most backlinks, and most skill files, one `FollowResult` holds. */
export const followMaxEntries = pageMaxLimit;

/**
 * Where a document leads: its links, the documents that link to it, and,
 * for a skill, the files it refers to, each list in path order.
 */
export interface FollowResult {
  /** All of them: a document has at most 500 distinct links. */
  links: DocumentLink[];
  /** The first {@link followMaxEntries}; `backlinks()` pages past them. */
  backlinks: Backlink[];
  /**
   * For a skill, the first {@link followMaxEntries} other documents in its
   * folder and below, where the Agent Skills format keeps the files a skill
   * refers to by relative path. Empty for any other type.
   */
  files: SkillFile[];
  /** Whether `backlinks` or `files` has more than it holds. */
  truncated: boolean;
  provenance: Provenance;
}

/**
 * Why personal data is purged. The audit log records it and can't be
 * purged itself, so it's one of these, never free text that could name
 * the person.
 */
export const purgeReasonSchema = z.enum([
  "offboarding",
  "erasure_request",
  "other",
]);
export type PurgeReason = z.infer<typeof purgeReasonSchema>;

/**
 * Most documents one purge of content names: as many as one audit event
 * names as provenance (the host's audit log holds at most 100 there).
 */
export const purgeMaxDocuments = 100;

/**
 * Most terms one purge of content removes: enough for a person's name, its
 * joined forms ("Toms", "tomVisser") and email addresses, which a purge
 * only finds when each is a term of its own.
 */
export const purgeMaxTerms = 50;

/** Longest term, in characters: a passage of a few sentences. */
export const purgeTermMaxLength = 1000;

/**
 * What each purged term becomes: a plain scalar in YAML frontmatter and
 * plain text in Markdown, so a purged document still reads as one.
 */
export const purgedMarker = "(removed)";

/**
 * Whether `term` could be found again once replaced by the marker, in any
 * case: the marker holds it, it starts with how the marker ends, or it
 * ends with how the marker starts (the marker and the text next to it
 * would make it again).
 */
const overlapsMarker = (term: string): boolean => {
  const marker = purgedMarker.toLowerCase();
  const lower = term.toLowerCase();
  if (marker.includes(lower)) {
    return true;
  }
  for (let length = 1; length <= marker.length; length += 1) {
    if (
      lower.startsWith(marker.slice(-length)) ||
      lower.endsWith(marker.slice(0, length))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * A term to purge: none that overlaps the marker, or a purge would find it
 * again next to or in its own marker, and never finish finding it.
 */
const purgeTermSchema = z
  .string()
  .trim()
  .min(2)
  .max(purgeTermMaxLength)
  .refine((term) => !overlapsMarker(term), {
    message: `A term can't be part of "${purgedMarker}", start with its end or end with its start`,
  });

/**
 * What a purge removes, for good, from every version:
 * - `personal`: the person's Personal collection, with their USER.md and
 *   all its versions;
 * - `content`: every occurrence of the `terms` (a name, an email address,
 *   a passage), in any case and as a whole word (never inside a longer
 *   word), from the documents named, which stay: each becomes
 *   {@link purgedMarker}. A form joined to more letters or digits ("Toms",
 *   "Tom2", "tomVisser" for "Tom") must be a term of its own; the plan
 *   counts where a term still starts a longer word (`inLongerWords`).
 *   In scripts written without spaces (Chinese, Japanese, Thai, Lao,
 *   Khmer, Burmese) a term is found inside running text. A document's
 *   own path stays; links and other fields naming a document are
 *   rewritten like any text.
 */
export const purgeInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("personal"),
    userId: idSchema,
    reason: purgeReasonSchema,
  }),
  z.strictObject({
    type: z.literal("content"),
    documentIds: z
      .array(documentIdSchema)
      .min(1)
      .max(purgeMaxDocuments)
      .transform((ids) => [...new Set(ids)]),
    terms: z.array(purgeTermSchema).min(1).max(purgeMaxTerms),
    reason: purgeReasonSchema,
  }),
]);
export type PurgeInput = z.input<typeof purgeInputSchema>;

/** What a purge would remove, to confirm with `token` before it expires. */
export interface PurgePlan {
  /** Documents it deletes (`personal`) or rewrites (`content`). */
  documents: number;
  /** Versions of them it deletes or rewrites. */
  versions: number;
  /**
   * How often a term is removed from the documents named, in every
   * version. Always 0 for `personal`, which deletes them whole.
   */
  occurrences: number;
  /**
   * How often a term is still in what the purge leaves of the documents
   * named, every version and the one it saves too: inside, at the start
   * or at the end of a longer word or address ("Toms", "tomVisser",
   * "automated", "evil.tom.visser@acme.test" for "Tom" or the address),
   * which a search for part of a word still finds. List the forms to
   * remove as terms of their own. Always 0 for `personal`.
   */
  inLongerWords: number;
  /**
   * Copies the host keeps outside Knowledge a term is removed from
   * (`content`; core's: the brain's gap answers), every one holding a
   * term, whatever documents are named. Always 0 for `personal`, which
   * forgets the person as their author instead.
   */
  hostCopies: number;
  /**
   * Originals of uploaded files it deletes (and the uploads it forgets):
   * those of the collection (`personal`), or every one uploaded as a
   * document named (`content`), whether or not a term is in its text, as
   * a file can hold one where extraction never read it.
   */
  originals: number;
  /** Confirms exactly this purge, by the admin who prepared it. */
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** What a confirmed purge removed. */
export interface PurgeResult {
  /** Names the purge in the audit log. */
  purgeId: string;
  documents: number;
  versions: number;
  /**
   * Documents named that a search still finds by a term, as whole words,
   * once purged (`content`): what the purge leaves on purpose but the
   * index matches by the same tokens, an address or a domain inside a
   * longer one (which the plan counted, `inLongerWords`), a form spelled
   * otherwise that folds to the same ("Rene" for "René"), or a term of
   * several words joined otherwise ("tom-visser" for "tom visser").
   * Gap answers still holding a term count too: one given after the
   * purge read them, left to a purge again. Absent for `personal`.
   */
  stillFound?: number;
}

/** Why a Knowledge call was refused. */
export const knowledgeErrors = errorFamily({
  "knowledge.not_found":
    "There's no such collection, document or version, or you can't see it.",
  "knowledge.forbidden": "You can't change this collection.",
  "knowledge.read_only":
    "This collection is managed by Grasp or an App and can't be changed here.",
  "knowledge.invalid": "That isn't a valid collection or document.",
  "knowledge.too_large": "This document is too large to save.",
  "knowledge.memory_too_large":
    "This memory file is over its size limit. Shorten it: agents have it in their context all the time.",
  "knowledge.too_many_sections":
    "This document has too many headings to save. Split it into several documents.",
  "knowledge.too_many_links":
    "This document has too many links to save. Split it into several documents.",
  "knowledge.conflict":
    "This document changed since you opened it. Load the latest version and apply your change to it.",
  "knowledge.purge_expired":
    "This purge wasn't confirmed in time, or isn't the one prepared. Prepare it again.",
  "knowledge.unavailable":
    "This version's text can't be read right now. Try again in a moment.",
  "knowledge.purge_index_pending":
    "The data is deleted, but the search index isn't cleaned up yet. Run the purge again to finish.",
});
