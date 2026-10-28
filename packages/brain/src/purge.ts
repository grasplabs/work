import { and, asc, count, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit.ts";
import type { Brain } from "./brain.ts";
import type { CollectionRow } from "./collections.ts";
import { inList } from "./db/d1.ts";
import {
  brainPayloads,
  collections,
  documents,
  links,
  sections,
  transcripts,
  versions,
} from "./db/schema.ts";
import { checkedText, indexedValuesOf, writeVersion } from "./documents.ts";
import type { DocumentRow, Writer } from "./documents.ts";
import { fromBase64Url, sha256Hex, toBase64Url } from "./encoding.ts";
import { forgetCollectionEntities } from "./entities.ts";
import { erasedDocumentsWrite } from "./erasures.ts";
import type { BrainEvent } from "./events.ts";
import { parseBaseFields } from "./frontmatter.ts";
import { requireCurrentIndexed } from "./indexing.ts";
import type { Json } from "./json.ts";
import { canonicalJson } from "./json.ts";
import {
  knowledgeErrors,
  purgeInputSchema,
  purgeMaxDocuments,
  purgedMarker,
} from "./knowledge.ts";
import type { PurgePlan, PurgeResult } from "./knowledge.ts";
import { log } from "./log.ts";
import {
  countStatements,
  eraseStatements,
  forgetPerson,
  personCounts,
} from "./memories.ts";
import {
  collectPayloads,
  commitPayload,
  committedKey,
  isUncommitted,
  readPayload,
  releasing,
  stagePayload,
} from "./payloads.ts";
import type { PayloadRef, StagedPayload } from "./payloads.ts";
import {
  collectionPlan,
  eraseCollectionFromSearchIndex,
  eraseFromSearchIndex,
  errorNameOf,
  owedWritesDone,
  rebuildOwed,
  rebuildOwedIfChanged,
  secureDeleteReady,
} from "./search-erasure.ts";
import {
  replaceTranscript,
  rewrittenTranscript,
  storedTranscript,
  transcriptTexts,
} from "./transcripts.ts";
import type { ReadAt, Transcript } from "./transcripts.ts";
import { unicode61Dropped, unicode61Kept } from "./unicode61.ts";

// Purging personal data from Knowledge, for good, when someone leaves or
// asks (GDPR erasure): an admin prepares a purge, which says how much it
// removes and returns a token, and confirms it with that token. Two kinds:
//
// - `personal`: the person's Personal collection (their USER.md and
//   whatever else is in it) is deleted with every version, section, link,
//   transcript and search row, and so are their Brain memories and command receipts
//   (memories.ts). One batch, with its audit event, which counts them.
// - `content`: every occurrence of some terms (a name, an email address, a
//   passage), in any case and as a whole word as the search index's
//   tokenizer draws words (never inside a longer word, except in scripts
//   written without spaces), with the diacritics the tokenizer drops
//   around it, is replaced with `purgedMarker` in every version of the
//   documents named. Preparing one also counts how often it removes a term
//   (`occurrences`) and how often one is left inside, at the start or at
//   the end of a longer word or address ("Toms", "automated"), which a
//   search for part of a word still finds, so the admin can add those
//   forms as terms of their own. Once done, a purge asks the index whether
//   a term still finds a document it named (`stillFound`). Whenever anything changed, the current text is also
//   saved as the next version, which makes its sections, links, search
//   rows and the document's title and description again, and fails for
//   anyone who saved meanwhile from text not yet purged.
//
// A content purge rewrites a named document's transcript (transcripts.ts)
// as it rewrites its text: every speaker, turn and chapter title, counted
// in its plan and its check, kept with the version it saves, or rewritten
// where it stands (audited, `knowledge.transcript.purged`) when no
// version's text held a term.
//
// A content purge reaches the Brain's memory records too, everyone's,
// whatever documents it names (memories.ts, `eraseStatements`): each
// statement holding a term is redacted as text is, and deleted when no
// word is left of it but the markers (`erasedStatement`), matched
// decomposed (NFD) as text is. Its plan counts them (`memories`), each change is
// audited, and its check counts one still holding a term with the
// documents a term still finds (`stillFound`): remembered after the purge
// read it, or a form it leaves on purpose, as the index would find it
// (`foldedHolds`: "Rene" for "René", "tom-visser" for "tom visser").
//
// Both reach the copies of people's words the host keeps outside
// Knowledge too, through its `OnErase` hook (core's: the brain's gap
// answers and records, and the onboarding's readings of the documents
// shared in it), so Knowledge names none of them: a personal purge forgets
// the person as the author of any, a content purge rewrites every one
// holding a term, whatever documents it names, and forgets every copy made
// of a document it names, whatever it holds, before its documents. Its plan
// counts the copies holding a term (`hostCopies`), and its check counts one
// still holding one (written after the rewrite read it, or a form it leaves
// on purpose, as a memory statement's) with the documents a term still
// finds (`stillFound`).
//
// Both have the host forget the files it keeps as the documents they
// purge (`OnErase` `forgetFiles`; core's: the originals of uploaded files,
// uploads.ts), before anything of a document changes: a file holds the
// data too. A content purge does so for every document it names, whether
// or not it finds a term in the text, since a file can hold one where
// Knowledge never read it (an image in a PDF). Preparing one says how
// many it erases (`originals`).
//
// Then nothing of it is left in the search index (search-erasure.ts): a
// content purge's deletes are secure ones, which take a row's terms out of
// the index's pages, and the pages' directory is checked for a term left
// behind; the index is rebuilt from what it holds now when one is, or
// when that can't be told (a term that isn't plain ASCII, a platform that
// refuses secure deletes). A personal purge, whose terms it doesn't name,
// reads every version of the collection's documents before deleting it
// and checks the tokens they gave the index the same way, up to caps past
// which it rebuilds. The cleanup runs after the data is
// committed, and on every purge, also one with nothing left to change, so
// when it fails (`knowledge.purge_index_pending`) running the purge again
// finishes it.
//
// The audit log can't be purged, so what it records of a purge is who,
// when, why (a reason from a fixed list), which documents and how many
// versions (and, when preparing, how often a term starts a longer word):
// never the terms or the text removed. Preparing is recorded too: its
// counts tell whether text is in a collection the admin can't read, so
// trying terms one by one leaves a trace.
//
// What a purge doesn't reach: paths (a document named after someone keeps
// its name; a `[[link]]` or a frontmatter field naming it is rewritten
// like any text, and then names no document), the Grasp skills (the release's text,
// which the next sync puts back: a purge naming one is refused), the App
// itself (its name, description and versions' AGENTS.md: a purge naming
// the App's entry in the Apps collection is refused while what indexing
// would write now holds a term, or when the App can't be read to tell;
// once the App no longer holds it, the purge rewrites the entry's
// history, until the App is set back to a version that holds it or given
// it again), collection names and
// descriptions, other documents that quote the text, a term split by
// Markdown or a line break, a term spelled otherwise (a variant, an
// accent left out of the text: "Rene" for the term "René", which the
// index folds to the same token; a term without one removes the accented
// form, as text and terms are matched decomposed, NFD), a term joined to more of a word
// ("Toms", "tomVisser", "automated": not removed, only counted; the words
// index keeps those as other tokens, the trigram index finds the term
// inside them), an address or a domain inside a longer one
// ("evil.tom.visser@acme.test": another address, counted, and still found
// by its tokens), memory already cached in a running isolate (never served again,
// gone once evicted), fragments of a word of at most three characters
// left in the search index's page directory (search-erasure.ts: any text
// with those letters leaves the same; a token with a digit, never three
// of its characters), beyond what live text holds, the pages SQLite freed, which keep their old bytes
// until reused (D1 has no `PRAGMA secure_delete`), D1's own point-in-time
// recovery, and anything outside Knowledge. And it reaches too far where a name is an
// ordinary word too (Will, Mark, May): every "will" goes.

/** How long an admin has to confirm a purge they prepared. */
const tokenLifetimeMs = 10 * 60 * 1000;

/** Versions read at once when rewriting a document's: up to 1 MB each. */
const versionsPerPage = 5;

/**
 * Largest text and message of a version a purge writes, in bytes of UTF-8.
 * D1 keeps a row to 2 MB; this leaves the rest of the row a clear margin.
 * A version saved at the 1 MB limit grows past it when many short terms
 * become the longer marker.
 */
const rewrittenMaxBytes = 1.5 * 1024 * 1024;

type PurgeInput = z.output<typeof purgeInputSchema>;
type PersonalPurge = Extract<PurgeInput, { type: "personal" }>;
type ContentPurge = Extract<PurgeInput, { type: "content" }>;

interface Counts {
  documents: number;
  versions: number;
}

const nothing: Counts = { documents: 0, versions: 0 };

const sum = (all: Counts[]): Counts => {
  const total = { ...nothing };
  for (const counts of all) {
    total.documents += counts.documents;
    total.versions += counts.versions;
  }
  return total;
};

/**
 * Refuses anyone but the client's own admins: Grasp staff never purge the
 * client's data, whatever their role.
 */
/**
 * Files a host keeps as Knowledge documents, which a purge erases whole:
 * a collection's, or those under one document's path.
 */
export type ErasedFiles =
  | { collectionId: string }
  | { collectionId: string; path: string };

/**
 * How a purge reaches the copies of people's words a host keeps outside
 * Knowledge, so Knowledge itself names none of them. Core's are the
 * brain's gap answers (brain-gaps.ts), the originals of uploaded files
 * (uploads.ts) and the onboarding's readings of the documents shared in
 * it (onboarding/documents.ts).
 */
export interface OnErase {
  /** How many copies `holds` is true of: those holding a purged term. */
  count: (holds: (text: string) => boolean) => Promise<number>;
  /**
   * Rewrites every copy with `rewrite` (a content purge's: its terms
   * replaced), as `person`; a copy it leaves as it is isn't written.
   */
  rewrite: (by: Writer, rewrite: (text: string) => string) => Promise<void>;
  /** Forgets `userId` as the author of any copy (a personal purge). */
  forgetActor: (by: Writer, userId: string) => Promise<void>;
  /**
   * Forgets every copy made of `documents`, the documents a content purge
   * names, whatever it holds: a reading of one may say a term otherwise
   * than the purge spells it.
   */
  forgetDocuments: (
    by: Writer,
    documents: readonly ErasedDocument[]
  ) => Promise<void>;
  /** How many files the host keeps for `scopes` (a plan's `originals`). */
  countFiles: (scopes: readonly ErasedFiles[]) => Promise<number>;
  /**
   * Forgets the files of `scope`, as `person`, before the purge writes
   * anything of it. May refuse (`knowledge.conflict`, for one the host is
   * saving as a document now), which fails the purge before it changes the
   * document: running it again finishes it.
   */
  forgetFiles: (by: Writer, scope: ErasedFiles) => Promise<void>;
  /** The collection a personal purge of `userId` deletes. */
  personalCollection: (userId: string) => Promise<string>;
  /**
   * Refuses (throws) the purge of `document` while the host would write a
   * term back into it (`holds` tells): core's Apps collection, whose
   * entries indexing makes from each App itself.
   */
  requireRewritable: (
    document: ErasedDocument,
    holds: (text: string) => boolean
  ) => Promise<void>;
}

/** A document a purge names, as `OnErase` sees it. */
export interface ErasedDocument {
  id: string;
  collectionId: string;
  path: string;
  /** Its collection's source, as the host set it. */
  source: string;
}

const parseInput = (input: unknown): PurgeInput =>
  knowledgeErrors.parse("knowledge.invalid", purgeInputSchema, input);

const tokenKey = async <C>(brain: Brain<C>): Promise<CryptoKey> =>
  await brain.ports.keys.hmac("grasp-os knowledge purge token", [
    "sign",
    "verify",
  ]);

/** What a token signs: the admin, the purge as parsed, and its expiry. */
const tokenData = (by: Writer, input: PurgeInput, expiresAt: number) =>
  new TextEncoder().encode(canonicalJson([by.userId, input, expiresAt]));

const tokenPattern = /^(?<expiresAt>\d{1,15})\.(?<mac>[\w-]{1,128})$/u;

/**
 * Refuses with `knowledge.purge_expired` unless `token` is one prepared by
 * `person` for exactly `input`, and not yet expired. It holds no purged
 * text: the admin sends the input again.
 */
const requireToken = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: PurgeInput,
  token: unknown
): Promise<void> => {
  const groups =
    typeof token === "string" ? tokenPattern.exec(token)?.groups : undefined;
  const expiresAt = Number(groups?.expiresAt);
  let valid = false;
  if (groups?.mac !== undefined && expiresAt > brain.ports.clock().getTime()) {
    try {
      valid = await crypto.subtle.verify(
        "HMAC",
        await tokenKey(brain),
        fromBase64Url(groups.mac),
        tokenData(by, input, expiresAt)
      );
    } catch {
      // Not base64url: not a token.
    }
  }
  if (!valid) {
    throw knowledgeErrors.create("knowledge.purge_expired");
  }
};

/** A token for `person` to confirm `input` with, and when it expires. */
const tokenFor = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: PurgeInput
): Promise<{ token: string; expiresAt: string }> => {
  const expiresAt = brain.ports.clock().getTime() + tokenLifetimeMs;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await tokenKey(brain),
    tokenData(by, input, expiresAt)
  );
  return {
    token: `${expiresAt}.${toBase64Url(new Uint8Array(mac))}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

/**
 * Runs `cleanup` of the search index, refusing with
 * `knowledge.purge_index_pending` when it fails: the data is deleted
 * already, and running the purge again cleans up again.
 */
const cleanSearchIndex = async (
  cleanup: () => Promise<void>
): Promise<void> => {
  try {
    await cleanup();
  } catch (error) {
    // The data is already deleted by now; running the purge again, which
    // always cleans up, finishes it. The error's name only: a cleanup's
    // query may carry the terms, which its error would repeat.
    log.error("knowledge.purge.rebuild_failed", {
      errorName: errorNameOf(error),
    });
    throw knowledgeErrors.create("knowledge.purge_index_pending");
  }
};

/** The audit event of preparing or running a purge: never its terms. */
const purgeEntry = (
  by: Writer,
  action: "knowledge.purge.prepared" | "knowledge.purged",
  input: PurgeInput,
  scope: { collectionId?: string; documentIds: string[] },
  counts: Partial<Counts> & {
    inLongerWords?: number;
    memories?: number;
    receipts?: number;
  },
  purgeId?: string
): BrainEvent => ({
  actor: by.actor,
  action,
  ...(scope.collectionId === undefined
    ? {}
    : { target: { type: "collection", id: scope.collectionId } }),
  provenance: scope.documentIds.slice(0, purgeMaxDocuments),
  detail: {
    ...(purgeId === undefined ? {} : { purgeId }),
    kind: input.type,
    reason: input.reason,
    ...(input.type === "personal"
      ? { userId: input.userId }
      : { terms: input.terms.length }),
    ...counts,
  },
});

// Personal purges.

/** The person's Personal collection's documents, as a subquery. */
const documentsIn = (db: DrizzleD1Database, collectionId: string) =>
  db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.collectionId, collectionId));

/** What purging `userId`'s Personal collection deletes. */
const personalScope = async (
  db: DrizzleD1Database,
  { userId }: PersonalPurge,
  onErase: OnErase
): Promise<{ collectionId: string; documentIds: string[]; counts: Counts }> => {
  const collectionId = await onErase.personalCollection(userId);
  const found = await documentsIn(db, collectionId);
  const [versionCount] = await db
    .select({ count: count() })
    .from(versions)
    .where(inArray(versions.documentId, documentsIn(db, collectionId)));
  return {
    collectionId,
    documentIds: found.map(({ id }) => id),
    counts: {
      documents: found.length,
      versions: versionCount?.count ?? 0,
    },
  };
};

/**
 * Deletes `userId`'s Personal collection and everything in it, and their
 * Brain memories and receipts, in one batch: all or nothing. Its audit
 * event comes first, with the rebuild it owes, before anything changes;
 * then the host forgets the files it keeps as its documents (`OnErase`
 * `forgetFiles`: core deletes the uploads' originals); then the batch.
 * The sections go first, row by row, so the triggers take them out of the
 * search index; the rest in the order they refer to one another. Nothing
 * of the collection is left in the search index after (search-erasure.ts):
 * every version of its documents is read before the batch, and the tokens
 * they gave the index checked after, also when nothing was left to
 * delete. The rebuild is owed from the start, so a run again after the
 * check or rebuild fails,
 * with the collection gone, still rebuilds, and another when the
 * collection changed since it was read.
 */
const purgePersonal = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: PersonalPurge,
  onErase: OnErase
): Promise<PurgeResult> => {
  const { db } = brain;
  const { collectionId, documentIds, counts } = await personalScope(
    db,
    input,
    onErase
  );
  const memoryCounts = await personCounts(db, input.userId);
  const purgeId = crypto.randomUUID();
  const inCollection = documentsIn(db, collectionId);
  const secure = await secureDeleteReady(db);
  const plan = secure
    ? await collectionPlan(brain, db, collectionId, indexedValuesOf)
    : ({ kind: "unknown" } as const);
  // The versions' payloads, unreferenced once they go, are collected right
  // after: erased from R2 too.
  const released = releasing(db, inArray(versions.documentId, inCollection));
  // Recorded before anything changes, the host's files included, so no
  // purge goes unrecorded however far it gets, with the rebuild it owes
  // (as a content purge records them).
  await auditedBatch(brain.ports, db, [
    outboxed(
      brain,
      purgeEntry(
        by,
        "knowledge.purged",
        input,
        { collectionId, documentIds },
        { ...counts, ...memoryCounts },
        purgeId
      )
    ),
    rebuildOwed(db, purgeId),
  ]);
  try {
    await onErase.forgetFiles(by, { collectionId });
    const [first, ...rest]: BatchItem<"sqlite">[] = [
      ...(plan.kind === "keys"
        ? [
            rebuildOwedIfChanged(
              db,
              `${purgeId}:changed`,
              collectionId,
              plan.versions
            ),
          ]
        : []),
      ...released.before,
      // The entities only its documents name, with their keys, before the
      // documents take their mentions with them.
      forgetCollectionEntities(db, collectionId),
      db.delete(sections).where(inArray(sections.documentId, inCollection)),
      db.delete(links).where(inArray(links.fromDocumentId, inCollection)),
      db
        .delete(transcripts)
        .where(inArray(transcripts.documentId, inCollection)),
      db.delete(versions).where(inArray(versions.documentId, inCollection)),
      db.delete(documents).where(eq(documents.collectionId, collectionId)),
      db.delete(collections).where(eq(collections.id, collectionId)),
      ...released.after,
      ...forgetPerson(db, input.userId, brain.ports.clock()),
    ];
    if (first !== undefined) {
      await db.batch([first, ...rest]);
    }
  } finally {
    // A rebuild from now on covers this purge's writes, also when they
    // failed: it writes no more.
    await owedWritesDone(db, purgeId);
  }
  await collectPayloads(brain, db);
  await cleanSearchIndex(async () => {
    await eraseCollectionFromSearchIndex(db, plan, { secure, id: purgeId });
  });
  // The host's copies keep who wrote them: never the person erased.
  await onErase.forgetActor(by, input.userId);
  return { purgeId, ...counts };
};

// Content purges.

/** A character as a pattern: itself. */
const literalCharacter = (character: string): string =>
  character.replaceAll(/[$()*+./?[\\\]^{|}]/gu, "\\$&");

/** Code point ranges as the inside of a character class. */
const classOf = (ranges: readonly (readonly [number, number])[]): string =>
  ranges
    .map(([from, to]) =>
      from === to
        ? `\\u{${from.toString(16)}}`
        : `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`
    )
    .join("");

/**
 * Scripts written without spaces between words (Chinese, Japanese, Thai,
 * Lao, Khmer, Burmese): a name in running text has letters on both sides,
 * so a character of one never makes a word longer.
 */
const unspacedScripts = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]`;

/**
 * A character that makes a word longer, in any script written with
 * spaces: one the search index's tokenizer keeps inside a token, as it
 * measures it (`unicode61Kept`, SQLite's own Unicode 6.1 tables, not
 * `\p{…}`), that is a letter, a digit or a mark. Everything the tokenizer
 * splits on ends a word, as it ends the index's token: an underscore, a
 * soft hyphen, a zero-width joiner, a combining grapheme joiner, a
 * variation selector, Hebrew points, Arabic harakat, most Indic vowel
 * signs (GRA-698). So a term is removed wherever the index keeps it as a
 * token of its own, and no search for it finds the document after
 * ("Visser_jan"). What the tokenizer keeps but isn't a letter, digit or
 * mark (a private-use character, an emoji, a code point Unicode 6.1 didn't
 * assign, such as a bidi isolate) ends a word too: the term goes, and the
 * index's token that held it is rebuilt (`besideLongerToken`). `\b` knows
 * only ASCII, so it would split "José" after the "Jos".
 */
const joining = String.raw`(?!${unspacedScripts})(?=[\p{L}\p{N}\p{M}])[${classOf(unicode61Kept)}]`;

/**
 * A combining diacritic the tokenizer drops from a token (`unicode61Dropped`,
 * `remove_diacritics 2`): "Visser" with an acute after it is the token
 * "visser". It goes with the term beside it, and doesn't join it.
 */
const dropped = `[${classOf(unicode61Dropped)}]`;

/** A character the tokenizer takes as part of a token: kept or dropped. */
const tokenCharacter = new RegExp(
  `^[${classOf(unicode61Kept)}${classOf(unicode61Dropped)}]$`,
  "u"
);

const startsJoining = new RegExp(`^(?:${joining}|${dropped})`, "u");
const endsJoining = new RegExp(`(?:${joining}|${dropped})$`, "u");

/**
 * A term as a pattern: every character as itself, and any dropped
 * diacritics after each, which the index's token doesn't hold
 * ("Viśser" is the token "visser").
 */
const literal = (term: string): string =>
  // oxlint-disable-next-line typescript/no-misused-spread -- code points on purpose, as the tokenizer reads them
  [...term]
    .map((character) => `${literalCharacter(character)}${dropped}*`)
    .join("");

/**
 * Where a term becomes part of a longer word when the character next to
 * it joins it: at its start and end, when those join (a letter of "Tom"
 * does; the bracket of "(Tom)", the dot ending a passage, or a character
 * of a script written without spaces don't).
 */
const sidesOf = (term: string) => ({
  before: startsJoining.test(term),
  after: endsJoining.test(term),
});

/** A term that is an address or a domain: it holds a dot or an at sign. */
const addressLike = /[.@]/u;

/**
 * What joins a term to more of a word on a side where its edge joins: a
 * joining character, past any dropped diacritics; and, for an address or
 * a domain, a dot or an at sign with one past it, so it is one word
 * ("tom.visser@acme.test" isn't found in "tom.visser@acme.test.evil" or
 * "evil.tom.visser@acme.test", other addresses). For any other term a dot
 * or an at sign ends a word, as it ends the index's token: "Visser" goes
 * from "Tom.Visser" and "tom.visser@acme.test" (GRA-698). A hyphen
 * doesn't join: "Jan-Tom" holds "Tom".
 */
const joinsOf = (term: string): { after: string; before: string } =>
  addressLike.test(term)
    ? {
        after: `${dropped}*(?:[.@]${dropped}*)?${joining}`,
        before: `${joining}${dropped}*(?:[.@]${dropped}*)?`,
      }
    : { after: `${dropped}*${joining}`, before: `${joining}${dropped}*` };

/**
 * A term, with the dropped diacritics before it, and nothing that joins it
 * before, where its start joins. The check before comes after the term's
 * own characters (looking behind them and it), so it runs only where the
 * whole term matched rather than at every position: on text made to be
 * slow, over twice as fast.
 */
const startingWord = (term: string): string => {
  const itself = literal(term);
  return sidesOf(term).before
    ? `${dropped}*${itself}(?<!${joinsOf(term).before}${itself})`
    : itself;
};

/**
 * A term as a pattern that matches it as a whole word, with the dropped
 * diacritics around it: never inside a longer one, so "Tom" leaves
 * "automated" and "Ann" leaves "planned", and frontmatter keys and values
 * that merely contain a term stay as they are.
 */
const wholeWord = (term: string): string =>
  sidesOf(term).after
    ? `${startingWord(term)}(?!${joinsOf(term).after})${dropped}*`
    : startingWord(term);

/** Alternatives in any case, as one pattern; one that never matches if none. */
const anyOf = (alternatives: string[]): RegExp =>
  new RegExp(
    alternatives.length === 0 ? "(?!)" : alternatives.join("|"),
    "giu"
  );

/**
 * The terms: `anywhere` finds them in any case, as themselves wherever
 * they are, which is cheap and tells whether a text needs the other
 * pattern at all; `remove` finds them as whole words; `left`, only when
 * preparing a purge, finds every occurrence anywhere, to count those the
 * purge leaves (inside a longer word or address, which the trigram index
 * still finds). Longest first, so a term inside a longer one doesn't
 * leave the rest of the longer one behind. Of the terms decomposed (NFD),
 * as the texts are matched (`decomposed`).
 */
/**
 * A term or a text decomposed (NFD), as the search index's tokenizer reads
 * it (`remove_diacritics 2`): an accent is a combining character after its
 * letter, which the pattern of each character of a term skips
 * (`literal`), as the index drops it from the token. So "Visser" with an
 * accent after its last letter is the name, whether the accent was typed
 * apart or merged with the letter ("é"), and a term without an accent
 * ("Jose") removes the accented form ("José") too, as the index finds
 * both by it: erasing more, the safe side. A term with an accent
 * ("René") keeps it: "Rene" is another word to it, which the index still
 * finds by the term (`stillFound`).
 */
const decomposed = (text: string): string => text.normalize("NFD");

interface Matcher {
  anywhere: RegExp;
  remove: RegExp;
  left?: RegExp;
}

const matcherOf = (
  terms: string[],
  { countLeft }: { countLeft: boolean }
): Matcher => {
  const longestFirst = terms
    .map(decomposed)
    .toSorted((one, other) => other.length - one.length);
  return {
    // Not global: `test` would carry `lastIndex` from one text to the next.
    anywhere: new RegExp(longestFirst.map(literal).join("|"), "iu"),
    remove: anyOf(longestFirst.map(wholeWord)),
    ...(countLeft ? { left: anyOf(longestFirst.map(literal)) } : {}),
  };
};

/**
 * `text` with every term replaced by the marker, until none is left: a
 * term that ends or starts with a dot or an at sign, once replaced, can
 * leave a term next to it no longer joined ("Tom." and "Ann" in
 * "Tom.Ann"), which one pass would leave to a purge run again. It ends:
 * a term can't overlap the marker (`purgeTermSchema`), so each pass
 * replaces text outside the markers, or markers with fewer of them.
 *
 * Matched decomposed (`decomposed`), as the terms are. Text holding a
 * term comes back composed (NFC); text holding none, as it was, byte for
 * byte. `visit` sees the decomposed text.
 */
const without = (
  text: string,
  matcher: Matcher,
  visit?: (current: string, index: number, length: number) => void
): string => {
  const apart = decomposed(text);
  if (!matcher.anywhere.test(apart)) {
    return text;
  }
  let current = apart;
  for (;;) {
    let next = "";
    let end = 0;
    for (const { index, 0: found } of current.matchAll(matcher.remove)) {
      visit?.(current, index, found.length);
      next += `${current.slice(end, index)}${purgedMarker}`;
      end = index + found.length;
    }
    next += current.slice(end);
    if (next === current) {
      return current === apart ? text : current.normalize("NFC");
    }
    current = next;
  }
};

/**
 * How often a term is still in `texts`, once rewritten: inside or at the
 * start or end of a longer word ("Toms", "tomVisser", "automated" for
 * "Tom") or a longer address or domain; 0 unless the matcher counts them.
 */
const leftIn = (texts: (string | null)[], matcher: Matcher): number => {
  const { anywhere, left } = matcher;
  if (left === undefined) {
    return 0;
  }
  let total = 0;
  for (const text of texts) {
    const apart = text === null ? "" : decomposed(text);
    if (anywhere.test(apart)) {
      total += [...apart.matchAll(left)].length;
    }
  }
  return total;
};

/** A letter or a digit: what makes a word. */
const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * A memory statement with the terms removed (`without`), or `null` when
 * nothing of it is left but the markers, punctuation and spaces: a record
 * that says nothing is deleted rather than kept as a husk. Whether what
 * is left still means what the person meant can't be told without
 * reading it, so any word left keeps it, redacted, as a document is.
 */
const erasedStatement = (
  statement: string,
  matcher: Matcher
): string | null => {
  const now = without(statement, matcher);
  return now === statement ||
    wordCharacter.test(now.replaceAll(purgedMarker, ""))
    ? now
    : null;
};

const keptCharacter = new RegExp(`^[${classOf(unicode61Kept)}]$`, "u");
const droppedCharacter = new RegExp(`^${dropped}$`, "u");

/**
 * `text`'s tokens as the search index's tokenizer folds them (unicode61,
 * `remove_diacritics 2`): runs of the characters it keeps, its dropped
 * diacritics left out, in lower case. Decomposed for compatibility first
 * (NFKD), so a precomposed accent is a dropped diacritic and a ligature
 * ("ﬁ") its letters: a check counts a little more than the index finds,
 * never less.
 */
const foldedTokens = (text: string): string[] => {
  const tokens: string[] = [];
  let token = "";
  for (const character of text.normalize("NFKD")) {
    if (droppedCharacter.test(character)) {
      continue;
    }
    if (keptCharacter.test(character)) {
      token += character.toLowerCase();
    } else if (token !== "") {
      tokens.push(token);
      token = "";
    }
  }
  if (token !== "") {
    tokens.push(token);
  }
  return tokens;
};

/**
 * Whether a text holds a term as the search index would find it: its
 * folded tokens (`foldedTokens`), in order, among the text's, as a phrase
 * query matches. So a form a content purge leaves on purpose is counted
 * too: spelled without its accents ("Rene" for "René"), joined otherwise
 * ("tom-visser" for "tom visser"), or with a ligature. A term with no
 * token (punctuation only) is never found. Alongside what the purge
 * removes (`statementHolds`), never instead of it.
 */
const foldedHolds = (terms: readonly string[]): ((text: string) => boolean) => {
  const phrases = terms.map(foldedTokens).filter((phrase) => phrase.length > 0);
  return (text) => {
    const tokens = foldedTokens(text);
    return phrases.some((phrase) =>
      tokens.some((_, start) =>
        phrase.every((token, at) => tokens[start + at] === token)
      )
    );
  };
};

/** Whether a content purge would remove a term from `text`. */
const holdsTerm = (text: string, matcher: Matcher): boolean =>
  without(text, matcher) !== text;

/**
 * Whether a memory statement or a host's copy (`OnErase` `count`) holds a
 * term, for a plan's and a check's counts of them, which no index holds
 * yet: one the purge
 * removes (`holdsTerm`: inside running text of a script written without
 * spaces, beside an emoji, a Greek final sigma in either case), or one
 * the index would find, which it leaves on purpose (`foldedHolds`).
 */
const statementHolds = (
  terms: readonly string[],
  matcher: Matcher
): ((statement: string) => boolean) => {
  const folded = foldedHolds(terms);
  return (statement) => holdsTerm(statement, matcher) || folded(statement);
};

/** How often a term is removed from `text`, in every pass (`without`). */
const removalsIn = (text: string, matcher: Matcher): number => {
  let removals = 0;
  without(text, matcher, () => {
    removals += 1;
  });
  return removals;
};

/** How often a term is removed from `texts` (`removalsIn`). */
const removedFrom = (texts: (string | null)[], matcher: Matcher): number =>
  texts.reduce(
    (total, text) => total + (text === null ? 0 : removalsIn(text, matcher)),
    0
  );

/** The character (code point) of `text` that ends just before `index`. */
const characterBefore = (text: string, index: number): string => {
  if (index === 0) {
    return "";
  }
  // Where a character of two UTF-16 units ends, its second unit.
  const unit = text.codePointAt(index - 1) ?? 0;
  const lowSurrogate = unit >= 0xdc_00 && unit <= 0xdf_ff;
  const start = lowSurrogate && index >= 2 ? index - 2 : index - 1;
  return String.fromCodePoint(text.codePointAt(start) ?? 0x20);
};

/** The character (code point) of `text` that starts at `index`. */
const characterAt = (text: string, index: number): string =>
  index >= text.length
    ? ""
    : String.fromCodePoint(text.codePointAt(index) ?? 0x20);

const plainAscii = /^[\p{ASCII}]*$/u;
const asciiOrSpace = /^(?:[\p{ASCII}]|\s)?$/u;

/**
 * Whether a character beside a term the purge removes may make it part of
 * a longer token to the search index: one the tokenizer takes into a token
 * that isn't plain ASCII (a character of a script written without spaces,
 * as in "東京Visser" or "Visserさん"; a private-use character; an emoji), or,
 * beside a term of plain ASCII, any character that isn't ASCII or a space
 * (a bidi isolate, a mark of a newer Unicode than the tokenizer's).
 */
const mayJoinToken = (character: string, asciiTerm: boolean): boolean =>
  !asciiOrSpace.test(character) &&
  (asciiTerm || tokenCharacter.test(character));

/**
 * Whether a term in `text` sits beside a character that may make it part
 * of a longer token to the search index (`mayJoinToken`), which the purge
 * removes the term from but whose token holds the term and isn't the
 * term's own. The index's check of a term's tokens (search-erasure.ts)
 * can't find that token, so the index is rebuilt then. It looks at every
 * term `without` removes, in each of its passes: "Visser" in
 * "Foo.Visserさん" is removed only once "Foo." is.
 */
const besideLongerToken = (text: string, matcher: Matcher): boolean => {
  let beside = false;
  without(text, matcher, (current, index, length) => {
    const asciiTerm = plainAscii.test(current.slice(index, index + length));
    beside ||=
      mayJoinToken(characterBefore(current, index), asciiTerm) ||
      mayJoinToken(characterAt(current, index + length), asciiTerm);
  });
  return beside;
};

/**
 * Whether a term in what the search index holds of a version's `text` is
 * part of a longer token (`besideLongerToken`): its text, and its
 * frontmatter's title, description and a skill's name as YAML decodes
 * them ("Visser\u3055\u3093" is "Visserさん"). When the frontmatter doesn't
 * read, a term anywhere in the text can't be told about, so it counts.
 */
const besideInIndexed = (
  path: string,
  text: string,
  matcher: Matcher
): boolean => {
  let decoded: unknown[];
  try {
    const { frontmatter } = parseBaseFields(path, text);
    decoded = [
      frontmatter.title,
      frontmatter.description,
      "name" in frontmatter ? frontmatter.name : undefined,
    ];
  } catch {
    return matcher.anywhere.test(decomposed(text));
  }
  return [text, ...decoded].some(
    (value) => typeof value === "string" && besideLongerToken(value, matcher)
  );
};

/** A version's text and message, rewritten if they change. */
const rewritten = (
  row: { text: string; message: string | null },
  matcher: Matcher
): { text: string; message: string | null } | undefined => {
  const text = without(row.text, matcher);
  const message = row.message === null ? null : without(row.message, matcher);
  return text === row.text && message === row.message
    ? undefined
    : { text, message };
};

/**
 * A version's text as a purge reads it: its payload's, or, when the object
 * is missing or isn't that text (`knowledge.unavailable`), a tombstone
 * (`purgedMarker`) marked `unreadable`, which the purge saves in its place:
 * whatever the object holds can't be checked for the terms, so it goes.
 */
const purgeTextOf = async <C>(
  brain: Brain<C>,
  ref: PayloadRef
): Promise<{ text: string; unreadable: boolean }> => {
  try {
    return { text: await readPayload(brain, ref), unreadable: false };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) !== "knowledge.unavailable") {
      throw error;
    }
    return { text: purgedMarker, unreadable: true };
  }
};

/**
 * What a purge writes for a version (`purgeTextOf`): its tombstone when it
 * couldn't be read, else its text and message rewritten, if they change.
 */
const purgeChangeOf = (
  row: { text: string; message: string | null; unreadable: boolean },
  matcher: Matcher
):
  | { text: string; message: string | null; unreadable: boolean }
  | undefined => {
  if (row.unreadable) {
    const message = row.message === null ? null : without(row.message, matcher);
    return { text: purgedMarker, message, unreadable: true };
  }
  const changed = rewritten(row, matcher);
  return changed === undefined ? undefined : { ...changed, unreadable: false };
};

interface Named {
  document: DocumentRow;
  collection: CollectionRow;
}

/**
 * The documents a content purge names, in ID order. Refuses with
 * `knowledge.not_found`, naming the ones that don't exist, rather than
 * skipping them: a mistyped ID would otherwise leave the text it was meant
 * for where it is, with a purge recorded as done. Refuses the Grasp
 * skills with `knowledge.read_only`, saying why for each: the next sync
 * would put their text back.
 */
const documentsNamed = async (
  db: DrizzleD1Database,
  { documentIds }: ContentPurge
): Promise<Named[]> => {
  const found = await db
    .select({ document: documents, collection: collections })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(inList(documents.id, documentIds))
    .orderBy(asc(documents.id));
  const existing = new Set(found.map(({ document }) => document.id));
  const missing = documentIds.filter((id) => !existing.has(id));
  if (missing.length > 0) {
    throw knowledgeErrors.create("knowledge.not_found", {
      documentIds: missing,
    });
  }
  const skills = found.filter(
    ({ collection }) => collection.source === "grasp"
  );
  if (skills.length > 0) {
    throw knowledgeErrors.create("knowledge.read_only", {
      issues: skills.map(
        ({ document }) =>
          `documentIds: document ${document.id} is a Grasp skill, which is read-only: it holds the release's text, and the next sync would put back anything changed`
      ),
    });
  }
  return found;
};

/** The text (its payload's) and message of `document`'s version `number`. */
const versionOf = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  document: DocumentRow,
  number: number
): Promise<
  { text: string; message: string | null; unreadable: boolean } | undefined
> => {
  const row = await db
    .select({
      key: brainPayloads.key,
      sha256: brainPayloads.sha256,
      message: versions.message,
    })
    .from(versions)
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(
      and(eq(versions.documentId, document.id), eq(versions.number, number))
    )
    .get();
  return row === undefined
    ? undefined
    : { ...(await purgeTextOf(brain, row)), message: row.message };
};

/**
 * Refuses with `knowledge.invalid` unless the current version of `named`,
 * with the terms removed, can be saved as its next version: its
 * frontmatter still fits its type, and it is within a document's limits
 * and a memory file's. Checked for every document named, whether or not
 * its current text holds a term (a purge saves it again when an earlier
 * version does), before a purge changes anything, so one that can't be
 * finished changes nothing. Refuses a document the host would write a
 * term back into (`OnErase` `requireRewritable`). Returns the text it
 * would save.
 */
const requireSavable = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  { document, collection }: Named,
  matcher: Matcher,
  onErase: OnErase
): Promise<string | undefined> => {
  const current = await versionOf(brain, db, document, document.currentVersion);
  if (current === undefined) {
    return undefined;
  }
  await onErase.requireRewritable(
    {
      id: document.id,
      collectionId: document.collectionId,
      path: document.path,
      source: collection.source,
    },
    (text) => without(text, matcher) !== text
  );
  const text = purgeChangeOf(current, matcher)?.text ?? current.text;
  try {
    await checkedText(brain, collection, document.path, text, false, true);
  } catch (error) {
    const code = knowledgeErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `terms: removing them from document ${document.id} leaves text that can't be saved (${code})`,
      ],
    });
  }
  return text;
};

/**
 * Refuses with `knowledge.invalid` when version `number` of `document`,
 * rewritten, is over {@link rewrittenMaxBytes}: D1 would refuse the row.
 */
const requireStorable = (
  document: DocumentRow,
  number: number,
  { text, message }: { text: string; message: string | null }
): void => {
  const encoder = new TextEncoder();
  const bytes =
    encoder.encode(text).byteLength + encoder.encode(message ?? "").byteLength;
  if (bytes > rewrittenMaxBytes) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `terms: removing them makes version ${number} of document ${document.id} too large to store (${bytes} bytes, at most ${rewrittenMaxBytes})`,
      ],
    });
  }
};

/**
 * A document's transcript as a purge finds it (transcripts.ts): as stored,
 * with the version it was saved with, and with the terms removed from its
 * speakers, words and chapter titles; `changed` when that removed any.
 * Refuses with `knowledge.invalid` when the rewrite would be too large to
 * store, as `requireStorable` does for a version.
 */
const transcriptPurgeOf = async (
  db: DrizzleD1Database,
  document: DocumentRow,
  matcher: Matcher
): Promise<
  | {
      version: number;
      at: ReadAt;
      texts: string[];
      redacted: Transcript;
      changed: boolean;
    }
  | undefined
> => {
  const stored = await storedTranscript(db, document.id);
  if (stored === undefined) {
    return undefined;
  }
  const redacted = rewrittenTranscript(stored.transcript, (text) =>
    without(text, matcher)
  );
  const texts = transcriptTexts(stored.transcript);
  const changed = transcriptTexts(redacted).some(
    (text, index) => text !== texts[index]
  );
  const bytes = new TextEncoder().encode(JSON.stringify(redacted)).byteLength;
  if (changed && bytes > rewrittenMaxBytes) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `terms: removing them makes the transcript of document ${document.id} too large to store (${bytes} bytes, at most ${rewrittenMaxBytes})`,
      ],
    });
  }
  return { version: stored.version, at: stored.at, texts, redacted, changed };
};

/**
 * The audit event of a version a purge replaced by its tombstone because
 * its payload couldn't be read: missing, or not the text its hash names.
 */
const replacedEntry = (
  actor: Json,
  document: DocumentRow,
  version: number
): BrainEvent => ({
  actor,
  action: "knowledge.payload.replaced",
  target: { type: "document", id: document.id },
  detail: { version, reason: "unreadable" },
});

/**
 * Points each of `changes`' versions of `document` at a payload of its
 * rewritten text, and rewrites its message, in one batch that marks the
 * payloads left unreferenced for collecting.
 */
const repointVersions = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  document: DocumentRow,
  changes: {
    number: number;
    changed: { text: string; message: string | null; unreadable: boolean };
  }[],
  actor: Json
): Promise<void> => {
  const stage = async () =>
    await Promise.all(
      changes.map(
        async ({ changed }) =>
          await stagePayload(brain, db, document.collectionId, changed.text)
      )
    );
  const released = releasing(
    db,
    and(
      eq(versions.documentId, document.id),
      inArray(
        versions.number,
        changes.map(({ number }) => number)
      )
    ) ?? sql`0`
  );
  const replaced = changes
    .filter(({ changed }) => changed.unreadable)
    .map(({ number }) =>
      outboxed(brain, replacedEntry(actor, document, number))
    );
  const send = async (staged: StagedPayload[]): Promise<void> => {
    const updates = changes.flatMap(({ number, changed }, index) => {
      const payload = staged[index];
      return payload === undefined
        ? []
        : [
            ...commitPayload(db, payload),
            db
              .update(versions)
              .set({
                payloadKey: committedKey(payload),
                message: changed.message,
              })
              .where(
                and(
                  eq(versions.documentId, document.id),
                  eq(versions.number, number)
                )
              ),
          ];
    });
    const [first, ...rest] = released.before;
    if (first === undefined) {
      return;
    }
    // Its audit events drain with the purge's own (`auditedBatch`, after).
    await db.batch([
      first,
      ...rest,
      ...updates,
      ...released.after,
      ...replaced,
    ]);
  };
  // A payload it reuses can be let go of and collected before the batch
  // (another purge, say): the batch is refused (`isUncommitted`), and the
  // texts are stored again, once, as a save's are.
  try {
    await send(await stage());
  } catch (error) {
    if (!isUncommitted(error)) {
      throw error;
    }
    await send(await stage());
  }
};

/**
 * Rewrites the versions of `document` up to `upTo` that hold a term, a
 * page at a time: each one's text as a new payload, which it is pointed
 * at, with its message rewritten in place; the payloads no version refers
 * to any more are collected after (payloads.ts). A version whose payload
 * can't be read is replaced by its tombstone, audited. Only counts them
 * unless `write`. Returns how
 * many hold one, how often a term is removed from them (`removedFrom`)
 * and how often one is left in them (`leftIn`). Refuses with `knowledge.invalid`
 * when one would be too large to store (`requireStorable`): a purge scans
 * them all first, so one that can't be finished changes nothing.
 */
const rewriteVersions = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  document: DocumentRow,
  upTo: number,
  matcher: Matcher,
  /** Who the purge is by, to write; only counted without. */
  write?: Json
): Promise<{
  changed: number;
  removed: number;
  left: number;
  beside: boolean;
}> => {
  let changedVersions = 0;
  let removed = 0;
  let left = 0;
  let beside = false;
  for (let after = 0; ;) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
    const refs = await db
      .select({
        number: versions.number,
        key: brainPayloads.key,
        sha256: brainPayloads.sha256,
        message: versions.message,
      })
      .from(versions)
      .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
      .where(
        and(
          eq(versions.documentId, document.id),
          gt(versions.number, after),
          lte(versions.number, upTo)
        )
      )
      .orderBy(asc(versions.number))
      .limit(versionsPerPage);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
    const page = await Promise.all(
      refs.map(async (ref) => ({
        number: ref.number,
        message: ref.message,
        ...(await purgeTextOf(brain, ref)),
      }))
    );
    const rows = page.map((row) => ({
      row,
      changed: purgeChangeOf(row, matcher),
    }));
    beside ||= rows.some(({ row }) =>
      besideInIndexed(document.path, row.text, matcher)
    );
    removed += removedFrom(
      rows.flatMap(({ row }) => [row.text, row.message]),
      matcher
    );
    left += leftIn(
      rows.flatMap(({ row, changed }) => {
        const { text, message } = changed ?? row;
        return [text, message];
      }),
      matcher
    );
    const changes = rows.flatMap(({ row, changed }) => {
      if (changed !== undefined) {
        requireStorable(document, row.number, changed);
      }
      return changed === undefined ? [] : [{ number: row.number, changed }];
    });
    changedVersions += changes.length;
    if (write !== undefined && changes.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
      await repointVersions(brain, db, document, changes, write);
    }
    const last = page.at(-1);
    if (last === undefined || page.length < versionsPerPage) {
      return { changed: changedVersions, removed, left, beside };
    }
    after = last.number;
  }
};

/**
 * What purging the terms from `named` would change, and how often a term
 * would still start a longer word in what it leaves: every version, the
 * one it saves too. Checks it can.
 */
const countDocument = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  named: Named,
  matcher: Matcher,
  onErase: OnErase
): Promise<{
  counts: Counts;
  removed: number;
  left: number;
  beside: boolean;
}> => {
  const { document } = named;
  const saved = await requireSavable(brain, db, named, matcher, onErase);
  const inVersions = await rewriteVersions(
    brain,
    db,
    document,
    document.currentVersion,
    matcher
  );
  const changes = inVersions.changed > 0;
  // When anything changes, the purge saves the current text, rewritten,
  // as the next version too (`purgeDocument`).
  const savesToo = changes && saved !== undefined;
  const leftInSaved = savesToo ? leftIn([saved], matcher) : 0;
  const transcript = await transcriptPurgeOf(db, document, matcher);
  return {
    counts: {
      documents: changes || transcript?.changed === true ? 1 : 0,
      versions: inVersions.changed,
    },
    removed:
      inVersions.removed +
      (transcript === undefined ? 0 : removedFrom(transcript.texts, matcher)),
    left:
      inVersions.left +
      leftInSaved +
      (transcript === undefined
        ? 0
        : leftIn(transcriptTexts(transcript.redacted), matcher)),
    beside: inVersions.beside,
  };
};

/**
 * The files the host keeps as a document, which a content purge erases,
 * whatever it finds in the text: they may hold the terms where Knowledge
 * never read them (an image in an uploaded PDF, say). One still being
 * saved as the document too: forgotten, it isn't saved.
 */
const filesNamed = (document: DocumentRow): ErasedFiles => ({
  collectionId: document.collectionId,
  path: document.path,
});

/**
 * Purges the terms from `named`, as `person`: rewrites the earlier
 * versions that hold one in place, a page at a time; then, if anything
 * held one, saves the current text, without them, as the next version
 * (`writeVersion`), which makes the sections, links, search rows, title,
 * description, owner and tags again, and gives memory cached by version a
 * new key. In the same batch, the current version is pointed at the new
 * one's payload too, and what that leaves unreferenced is collected after.
 *
 * The save is from the version the purge started at, so anyone who saved
 * or restored meanwhile, from text the purge hadn't rewritten yet, makes
 * it fail with
 * `knowledge.conflict`; running the purge again rewrites theirs too. A purge cut short leaves the current version as it
 * was, so running it again finishes it; one run again after it finished
 * finds nothing, and writes nothing.
 */
const purgeDocument = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  by: Writer,
  named: Named,
  matcher: Matcher,
  onErase: OnErase,
  purgeId: string
): Promise<Counts> => {
  const { document, collection } = named;
  // Before anything of it changes: one the host is saving now refuses, and
  // the purge fails here.
  await onErase.forgetFiles(by, filesNamed(document));
  const at = document.currentVersion;
  const { actor } = by;
  const earlier = await rewriteVersions(
    brain,
    db,
    document,
    at - 1,
    matcher,
    actor
  );
  const current = await versionOf(brain, db, document, at);
  const changed = current && purgeChangeOf(current, matcher);
  const changedVersions = earlier.changed + (changed === undefined ? 0 : 1);
  const transcript = await transcriptPurgeOf(db, document, matcher);
  const counts: Counts = {
    documents: changedVersions > 0 || transcript?.changed === true ? 1 : 0,
    versions: changedVersions,
  };
  if (
    transcript?.changed === true &&
    (current === undefined || changedVersions === 0)
  ) {
    // Only the transcript held a term: rewritten where it stands, with
    // its own event, as no version is saved to carry it.
    // Written only over the transcript as it was read, and recorded only
    // when it was: another purge at once never has its removal undone.
    await auditedBatch(brain.ports, db, [
      replaceTranscript(db, document.id, transcript.at, transcript.redacted),
      outboxedIfChanged(brain, {
        actor,
        action: "knowledge.transcript.purged",
        target: { type: "document", id: document.id },
        detail: { purgeId, version: transcript.version },
      }),
    ]);
  }
  if (current === undefined || changedVersions === 0) {
    // Search may still hold an earlier generation, with the terms, while
    // its current version waits for indexing (a purge that failed to
    // publish, say): published now, or the purge fails.
    await requireCurrentIndexed(brain, db, document.id, by.actor);
    return counts;
  }
  const text = changed?.text ?? current.text;
  const releasedCurrent = releasing(
    db,
    and(eq(versions.documentId, document.id), eq(versions.number, at)) ?? sql`0`
  );
  // The current version is pointed at the new version's payload, the
  // same text, committed earlier in the same batch.
  const pointCurrent: BatchItem<"sqlite">[] =
    changed === undefined
      ? []
      : [
          ...releasedCurrent.before,
          db
            .update(versions)
            .set({
              payloadKey: committedKey({
                collectionId: document.collectionId,
                sha256: await sha256Hex(text),
              }),
              message: changed.message,
            })
            .where(
              and(eq(versions.documentId, document.id), eq(versions.number, at))
            ),
          ...releasedCurrent.after,
          ...(changed.unreadable
            ? [outboxed(brain, replacedEntry(actor, document, at))]
            : []),
        ];
  await writeVersion(brain, by, {
    collection,
    path: document.path,
    text,
    ifVersion: at,
    message: "Personal data removed",
    restoredFrom: null,
    // A term is removed from the frontmatter a document keeps from
    // version to version too, and a document of a type the platform no
    // longer knows, or whose frontmatter no longer fits its type, is
    // purged all the same (`parseBaseFields`).
    purge: true,
    also: pointCurrent,
    // Kept with the version the purge saves, its terms removed: a save
    // without one would take it away.
    ...(transcript?.version === at
      ? { purgedTranscript: transcript.redacted, transcriptRead: transcript.at }
      : {}),
  });
  return counts;
};

/**
 * What a content purge would change, how often it removes a term and how
 * often one is left (when `matcher` counts them), checking every document
 * first.
 */
const contentCounts = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  named: Named[],
  matcher: Matcher,
  onErase: OnErase
): Promise<{
  counts: Counts;
  removed: number;
  left: number;
  tokensKnown: boolean;
}> => {
  const counts: Counts[] = [];
  let removed = 0;
  let left = 0;
  let tokensKnown = true;
  for (const one of named) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time, to bound memory
    const document = await countDocument(brain, db, one, matcher, onErase);
    counts.push(document.counts);
    removed += document.removed;
    left += document.left;
    tokensKnown &&= !document.beside;
  }
  return { counts: sum(counts), removed, left, tokensKnown };
};

/** A term as an FTS5 phrase: its tokens, in order, as the index reads them. */
const phraseOf = (term: string): string => `"${term.replaceAll('"', '""')}"`;

/**
 * How many of `documentIds` a search of the words index still finds by a
 * term, as whole tokens, once purged: the purge's own check of itself.
 * The index matches a term as its tokens, folded, so what a purge leaves
 * on purpose can count here too: an address or a domain inside a longer
 * one, whose tokens are all there (the plan counted it, `inLongerWords`),
 * a form spelled otherwise that folds to the same tokens ("Rene" for
 * "René"), and a term of several words joined otherwise ("tom-visser" for
 * "tom visser"). "Tom" in "Toms" isn't a token of its own, so it doesn't.
 * A term with no token (punctuation only) has nothing to find.
 */
const stillFoundIn = async (
  db: DrizzleD1Database,
  terms: readonly string[],
  documentIds: readonly string[]
): Promise<number> => {
  const found = new Set<string>();
  for (const term of terms) {
    // oxlint-disable-next-line typescript/no-misused-spread -- code points on purpose, as the tokenizer reads them
    if (![...term].some((character) => tokenCharacter.test(character))) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one term at a time
    const rows = await db.all<{ documentId: string }>(
      sql`SELECT DISTINCT r.document_id AS documentId
        FROM search_words w JOIN search_rows r ON r.id = w.rowid
        WHERE search_words MATCH ${phraseOf(term)}
          AND ${inList(sql`r.document_id`, documentIds)}`
    );
    for (const { documentId } of rows) {
      found.add(documentId);
    }
  }
  return found.size;
};

/** How many of `documentIds` have a transcript with a text `holds` is true of. */
const transcriptsHolding = async (
  db: DrizzleD1Database,
  documentIds: readonly string[],
  holds: (text: string) => boolean
): Promise<number> => {
  let holding = 0;
  for (const documentId of documentIds) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time, to bound memory
    const stored = await storedTranscript(db, documentId);
    if (
      stored !== undefined &&
      transcriptTexts(stored.transcript).some(holds)
    ) {
      holding += 1;
    }
  }
  return holding;
};

/**
 * Purges the terms from the documents named: checked first, every version
 * of every one, a page at a time, so a purge that would leave one that
 * can't be saved or stored changes nothing; then recorded in the audit
 * log; then run, one document at a time. The search index is rebuilt
 * last, also when nothing was left to change, so running a purge again
 * finishes a cleanup that failed.
 */
const purgeContent = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: ContentPurge,
  onErase: OnErase
): Promise<PurgeResult> => {
  const { db } = brain;
  const named = await documentsNamed(db, input);
  const matcher = matcherOf(input.terms, { countLeft: false });
  // Read before anything changes: whether a term is part of a longer
  // token anywhere, so the index needs rebuilding, is recorded with the
  // purge, and a run again after its text is rewritten still knows.
  const { tokensKnown } = await contentCounts(
    brain,
    db,
    named,
    matcher,
    onErase
  );
  // Before anything is deleted: so the purge's deletes are secure ones,
  // which leave nothing in the index's pages (search-erasure.ts).
  const secure = await secureDeleteReady(db);
  const purgeId = crypto.randomUUID();
  // Recorded before anything changes, so no purge goes unrecorded however
  // far it gets, with the rebuild it owes until its check finds nothing
  // left: one that fails after its writes, and isn't run again, leaves the
  // next purge to rebuild. A separator another document's text explained
  // at a purge's check that this one then takes the term from is covered
  // so, too.
  await auditedBatch(brain.ports, db, [
    outboxed(
      brain,
      purgeEntry(
        by,
        "knowledge.purged",
        input,
        { documentIds: named.map(({ document }) => document.id) },
        { documents: named.length },
        purgeId
      )
    ),
    rebuildOwed(db, purgeId),
    // The documents it names, before the host's copies of them are
    // forgotten: one made after that is found by them (erasures.ts).
    ...(await erasedDocumentsWrite(
      db,
      purgeId,
      named.map(({ document }) => document),
      brain.ports.clock()
    )),
  ]);
  const done: Counts[] = [];
  try {
    // The Brain's records hold people's words too, everyone's, whatever
    // documents the purge names: before its documents, so one whose purge
    // fails doesn't leave them holding a term.
    await eraseStatements(brain, by.actor, purgeId, (statement) =>
      erasedStatement(statement, matcher)
    );
    // The host's copies hold people's words too: every one is rewritten,
    // whatever documents the purge names. First, so a document whose
    // purge fails doesn't leave them holding a term.
    await onErase.rewrite(by, (text) => without(text, matcher));
    // A copy made of a document named goes whatever it holds, also when
    // the document's own purge then fails.
    await onErase.forgetDocuments(
      by,
      named.map(({ document, collection }) => ({
        id: document.id,
        collectionId: document.collectionId,
        path: document.path,
        source: collection.source,
      }))
    );
    for (const one of named) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time, to bound memory
      const counts = await purgeDocument(
        brain,
        db,
        by,
        one,
        matcher,
        onErase,
        purgeId
      );
      done.push(counts);
    }
  } finally {
    // A rebuild from now on covers this purge's writes, also when one of
    // them failed: it writes no more.
    await owedWritesDone(db, purgeId);
  }
  // What the rewrites let go of leaves R2 now; a failure fails the purge,
  // and running it again collects what's left (`collecting` rows).
  await collectPayloads(brain, db);
  await cleanSearchIndex(async () => {
    await eraseFromSearchIndex(db, input.terms, {
      secure,
      tokensKnown,
      id: purgeId,
    });
  });
  const inDocuments = await stillFoundIn(
    db,
    input.terms,
    named.map(({ document }) => document.id)
  );
  // A record or copy written after the purge read it is left to a purge
  // again.
  const memories = await countStatements(
    brain,
    statementHolds(input.terms, matcher)
  );
  const hostCopies = await onErase.count(statementHolds(input.terms, matcher));
  // A transcript saved after the purge read it, or a form it leaves on
  // purpose, as a memory statement's.
  const inTranscripts = await transcriptsHolding(
    db,
    named.map(({ document }) => document.id),
    statementHolds(input.terms, matcher)
  );
  const stillFound = inDocuments + memories + hostCopies + inTranscripts;
  if (stillFound > 0) {
    log.warn("knowledge.purge_still_found", {
      purgeId,
      documents: inDocuments,
      memories,
      hostCopies,
      transcripts: inTranscripts,
    });
  }
  return { purgeId, ...sum(done), stillFound };
};

/**
 * What the purge `input` would remove, for `person` to confirm with the
 * token returned. Admins only (not Grasp staff), behind `knowledge_purge`.
 * Recorded in the audit log, without the terms.
 */
export const preparePurge = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: unknown,
  onErase: OnErase
): Promise<PurgePlan> => {
  const parsed = parseInput(input);
  const { db } = brain;
  let scope: { collectionId?: string; documentIds: string[] };
  let counts: Counts;
  let originals: number;
  // A personal purge deletes whole documents: nothing is left in a word.
  let removed = 0;
  let left = 0;
  let hostCopies = 0;
  let records: { memories: number; receipts?: number };
  if (parsed.type === "personal") {
    ({ counts, ...scope } = await personalScope(db, parsed, onErase));
    records = await personCounts(db, parsed.userId);
    originals =
      scope.collectionId === undefined
        ? 0
        : await onErase.countFiles([{ collectionId: scope.collectionId }]);
  } else {
    const named = await documentsNamed(db, parsed);
    originals = await onErase.countFiles(
      named.map(({ document }) => filesNamed(document))
    );
    scope = { documentIds: named.map(({ document }) => document.id) };
    const matcher = matcherOf(parsed.terms, { countLeft: true });
    ({ counts, removed, left } = await contentCounts(
      brain,
      db,
      named,
      matcher,
      onErase
    ));
    records = {
      memories: await countStatements(
        brain,
        statementHolds(parsed.terms, matcher)
      ),
    };
    hostCopies = await onErase.count(statementHolds(parsed.terms, matcher));
  }
  await auditedBatch(brain.ports, db, [
    outboxed(
      brain,
      purgeEntry(by, "knowledge.purge.prepared", parsed, scope, {
        ...counts,
        ...(parsed.type === "content"
          ? { occurrences: removed, inLongerWords: left, hostCopies }
          : {}),
        ...records,
      })
    ),
  ]);
  return {
    ...counts,
    occurrences: removed,
    inLongerWords: left,
    memories: records.memories,
    hostCopies,
    originals,
    ...(await tokenFor(brain, by, parsed)),
  };
};

/**
 * Runs the purge `input`, with the token `preparePurge` returned `person`
 * for it. What it removes is counted as it runs, so it may differ from
 * what was prepared; the counts returned are what it removed.
 */
export const purge = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: unknown,
  token: unknown,
  onErase: OnErase
): Promise<PurgeResult> => {
  const parsed = parseInput(input);
  await requireToken(brain, by, parsed, token);
  return parsed.type === "personal"
    ? await purgePersonal(brain, by, parsed, onErase)
    : await purgeContent(brain, by, parsed, onErase);
};
