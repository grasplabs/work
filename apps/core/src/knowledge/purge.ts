import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  knowledgeErrors,
  purgeInputSchema,
  purgeMaxDocuments,
  purgedMarker,
} from "@grasp-os/shared/knowledge";
import type { PurgePlan, PurgeResult } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, count, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { inList } from "../db/d1.ts";
import {
  collections,
  documents,
  links,
  sections,
  uploads,
  versions,
} from "../db/knowledge/schema.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { appOfEntry } from "./app-entries.ts";
import { entryNow } from "./apps-collection.ts";
import type { CollectionRow } from "./collections.ts";
import {
  checkedText,
  indexedValuesOf,
  personWriter,
  writeVersion,
} from "./documents.ts";
import type { DocumentRow } from "./documents.ts";
import { parseBaseFields } from "./frontmatter.ts";
import { personalCollectionId } from "./memory-files.ts";
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
import { unicode61Dropped, unicode61Kept } from "./unicode61.ts";
import { cleanUpOriginals, forgetUploads } from "./uploads.ts";

// Purging personal data from Knowledge, for good, when someone leaves or
// asks (GDPR erasure): an admin prepares a purge, which says how much it
// removes and returns a token, and confirms it with that token. Two kinds:
//
// - `personal`: the person's Personal collection (their USER.md and
//   whatever else is in it) is deleted with every version, section, link
//   and search row. One batch, with its audit event.
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
// Both delete the originals of the files uploaded as the documents they
// purge (uploads.ts), and forget those uploads: an original holds the data
// too. A content purge does so for every document it names, whether or
// not it finds a term in the text, since a file can hold one where
// extraction never read it (an image in a PDF). Preparing one says how
// many originals it deletes (`originals`). Recorded in the purge's batch,
// and deleted from R2 right after, or by the cron trigger when that fails
// or an upload may still be storing its original.
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
// accent left out or encoded otherwise: "Rene" for "René", which the
// index folds to the same token), a term joined to more of a word
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
const requirePurger = (person: Identity): void => {
  if (person.staff || !isAdmin(person.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

const parseInput = (input: unknown): PurgeInput =>
  knowledgeErrors.parse("knowledge.invalid", purgeInputSchema, input);

const tokenKey = async (env: Env): Promise<CryptoKey> =>
  await derivedHmacKey(env, "grasp-os knowledge purge token", [
    "sign",
    "verify",
  ]);

/** What a token signs: the admin, the purge as parsed, and its expiry. */
const tokenData = (person: Identity, input: PurgeInput, expiresAt: number) =>
  new TextEncoder().encode(canonicalJson([person.userId, input, expiresAt]));

const tokenPattern = /^(?<expiresAt>\d{1,15})\.(?<mac>[\w-]{1,128})$/u;

/**
 * Refuses with `knowledge.purge_expired` unless `token` is one prepared by
 * `person` for exactly `input`, and not yet expired. It holds no purged
 * text: the admin sends the input again.
 */
const requireToken = async (
  env: Env,
  person: Identity,
  input: PurgeInput,
  token: unknown
): Promise<void> => {
  const groups =
    typeof token === "string" ? tokenPattern.exec(token)?.groups : undefined;
  const expiresAt = Number(groups?.expiresAt);
  let valid = false;
  if (groups?.mac !== undefined && expiresAt > Date.now()) {
    try {
      valid = await crypto.subtle.verify(
        "HMAC",
        await tokenKey(env),
        fromBase64Url(groups.mac),
        tokenData(person, input, expiresAt)
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
const tokenFor = async (
  env: Env,
  person: Identity,
  input: PurgeInput
): Promise<{ token: string; expiresAt: string }> => {
  const expiresAt = Date.now() + tokenLifetimeMs;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await tokenKey(env),
    tokenData(person, input, expiresAt)
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
  person: Identity,
  action: "knowledge.purge.prepared" | "knowledge.purged",
  input: PurgeInput,
  scope: { collectionId?: string; documentIds: string[] },
  counts: Partial<Counts> & { inLongerWords?: number },
  purgeId?: string
): AuditEntry => ({
  actor: actorOf(person),
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
  { userId }: PersonalPurge
): Promise<{ collectionId: string; documentIds: string[]; counts: Counts }> => {
  const collectionId = await personalCollectionId(userId);
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
 * Deletes `userId`'s Personal collection and everything in it, with the
 * audit event, in one batch: all or nothing.
 * The sections go first, row by row, so the triggers take them out of the
 * search index; the rest in the order they refer to one another. The
 * originals of files uploaded to it are recorded for deleting in the same
 * batch, and deleted from R2 right after (uploads.ts). Nothing of the
 * collection is left in the search index after (search-erasure.ts): every
 * version of its documents is read before the batch, and the tokens they
 * gave the index checked after, also when nothing was left to delete. The batch records
 * a rebuild as owed, so a run again after the check or rebuild fails,
 * with the collection gone, still rebuilds, and another when the
 * collection changed since it was read.
 */
const purgePersonal = async (
  env: Env,
  person: Identity,
  input: PersonalPurge
): Promise<PurgeResult> => {
  const db = drizzle(env.KNOWLEDGE);
  const { collectionId, documentIds, counts } = await personalScope(db, input);
  const purgeId = crypto.randomUUID();
  const inCollection = documentsIn(db, collectionId);
  const secure = await secureDeleteReady(db);
  const plan = secure
    ? await collectionPlan(db, collectionId, indexedValuesOf)
    : ({ kind: "unknown" } as const);
  await auditedBatch(env, db, [
    rebuildOwed(db, purgeId, { writesDone: true }),
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
    db.delete(sections).where(inArray(sections.documentId, inCollection)),
    db.delete(links).where(inArray(links.fromDocumentId, inCollection)),
    db.delete(versions).where(inArray(versions.documentId, inCollection)),
    ...forgetUploads(db, eq(uploads.collectionId, collectionId)),
    db.delete(documents).where(eq(documents.collectionId, collectionId)),
    db.delete(collections).where(eq(collections.id, collectionId)),
    outboxed(
      db,
      purgeEntry(
        person,
        "knowledge.purged",
        input,
        { collectionId, documentIds },
        counts,
        purgeId
      )
    ),
  ]);
  await cleanUpOriginals(env);
  await cleanSearchIndex(async () => {
    await eraseCollectionFromSearchIndex(db, plan, { secure, id: purgeId });
  });
  return { purgeId, ...counts };
};

// Content purges.

/** A character as a pattern: itself. */
const literalCharacter = (character: string): string =>
  character.replaceAll(/[$()*+./?[\\\]^{|}-]/gu, "\\$&");

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
 * leave the rest of the longer one behind.
 */
interface Matcher {
  anywhere: RegExp;
  remove: RegExp;
  left?: RegExp;
}

const matcherOf = (
  terms: string[],
  { countLeft }: { countLeft: boolean }
): Matcher => {
  const longestFirst = terms.toSorted(
    (one, other) => other.length - one.length
  );
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
 */
const without = (
  text: string,
  matcher: Matcher,
  visit?: (current: string, index: number, length: number) => void
): string => {
  if (!matcher.anywhere.test(text)) {
    return text;
  }
  let current = text;
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
      return current;
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
    if (text !== null && anywhere.test(text)) {
      total += [...text.matchAll(left)].length;
    }
  }
  return total;
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
    return matcher.anywhere.test(text);
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

/** The text and message of `document`'s version `number`. */
const versionOf = async (
  db: DrizzleD1Database,
  document: DocumentRow,
  number: number
) =>
  await db
    .select({ text: versions.text, message: versions.message })
    .from(versions)
    .where(
      and(eq(versions.documentId, document.id), eq(versions.number, number))
    )
    .get();

/**
 * Refuses with `knowledge.read_only` a purge of an App's entry while what
 * indexing would write now (`entryNow`) holds a term, saying where: the
 * next indexing (a version made current, the cron catching up) makes the
 * entry from the App itself, out of a purge's reach, and would put it
 * back, even when the entry is still of an older version without it.
 * Refuses too, failing closed, when the App or its current version can't
 * be read.
 */
const requireIndexedWithout = async (
  env: Env,
  document: DocumentRow,
  matcher: Matcher
): Promise<void> => {
  const refuse = (why: string) =>
    knowledgeErrors.create("knowledge.read_only", {
      issues: [
        `documentIds: document ${document.id} is an App's entry in the Apps collection, made from the App itself: ${why}`,
      ],
    });
  const appId = appOfEntry(document.path);
  let now: Awaited<ReturnType<typeof entryNow>>;
  try {
    now = appId === undefined ? undefined : await entryNow(env, appId);
  } catch (error) {
    log.error("knowledge.purge.app_unreadable", {
      documentId: document.id,
      ...errorFields(error),
    });
    now = undefined;
  }
  if (now === undefined) {
    throw refuse(
      "the App or its current version can't be read, so it can't be checked for the terms; try again later"
    );
  }
  if (without(now.text, matcher) === now.text) {
    return;
  }
  const holds = (text: string) => without(text, matcher) !== text;
  const where = [
    ...(holds(now.agents)
      ? ["a term is in the App's AGENTS.md: publish a version without it"]
      : []),
    ...(holds(now.name) || holds(now.description)
      ? [
          // No API renames an App or changes its description yet.
          "a term is in the App's name or description, which a purge can't reach: the App's builders or Grasp support must change it first",
        ]
      : []),
  ];
  throw refuse(
    `${where.length > 0 ? where.join("; ") : "a term is in what indexing writes for it"}; then purge`
  );
};

/**
 * Refuses with `knowledge.invalid` unless the current version of `named`,
 * with the terms removed, can be saved as its next version: its
 * frontmatter still fits its type, and it is within a document's limits
 * and a memory file's. Checked for every document named, whether or not
 * its current text holds a term (a purge saves it again when an earlier
 * version does), before a purge changes anything, so one that can't be
 * finished changes nothing. Refuses an App's entry while the App holds a
 * term (`requireIndexedWithout`). Returns the text it would save.
 */
const requireSavable = async (
  env: Env,
  db: DrizzleD1Database,
  { document, collection }: Named,
  matcher: Matcher
): Promise<string | undefined> => {
  const current = await versionOf(db, document, document.currentVersion);
  if (current === undefined) {
    return undefined;
  }
  if (collection.source === "apps") {
    await requireIndexedWithout(env, document, matcher);
  }
  const text = rewritten(current, matcher)?.text ?? current.text;
  try {
    await checkedText(env, collection, document.path, text, false, true);
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
 * Rewrites the versions of `document` up to `upTo` that hold a term, in
 * place, a page at a time; only counts them unless `write`. Returns how
 * many hold one, how often a term is removed from them (`removedFrom`)
 * and how often one is left in them (`leftIn`). Refuses with `knowledge.invalid`
 * when one would be too large to store (`requireStorable`): a purge scans
 * them all first, so one that can't be finished changes nothing.
 */
const rewriteVersions = async (
  db: DrizzleD1Database,
  document: DocumentRow,
  upTo: number,
  matcher: Matcher,
  write: boolean
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
    const page = await db
      .select({
        number: versions.number,
        text: versions.text,
        message: versions.message,
      })
      .from(versions)
      .where(
        and(
          eq(versions.documentId, document.id),
          gt(versions.number, after),
          lte(versions.number, upTo)
        )
      )
      .orderBy(asc(versions.number))
      .limit(versionsPerPage);
    const rows = page.map((row) => ({ row, changed: rewritten(row, matcher) }));
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
    const updates = rows.flatMap(({ row, changed }) => {
      if (changed !== undefined) {
        requireStorable(document, row.number, changed);
      }
      return changed === undefined
        ? []
        : [
            db
              .update(versions)
              .set(changed)
              .where(
                and(
                  eq(versions.documentId, document.id),
                  eq(versions.number, row.number)
                )
              ),
          ];
    });
    changedVersions += updates.length;
    const [first, ...rest] = updates;
    if (write && first) {
      // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
      await db.batch([first, ...rest]);
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
const countDocument = async (
  env: Env,
  db: DrizzleD1Database,
  named: Named,
  matcher: Matcher
): Promise<{
  counts: Counts;
  removed: number;
  left: number;
  beside: boolean;
}> => {
  const { document } = named;
  const saved = await requireSavable(env, db, named, matcher);
  const inVersions = await rewriteVersions(
    db,
    document,
    document.currentVersion,
    matcher,
    false
  );
  const changes = inVersions.changed > 0;
  // When anything changes, the purge saves the current text, rewritten,
  // as the next version too (`purgeDocument`).
  const savesToo = changes && saved !== undefined;
  const leftInSaved = savesToo ? leftIn([saved], matcher) : 0;
  return {
    counts: {
      documents: changes ? 1 : 0,
      versions: inVersions.changed,
    },
    removed: inVersions.removed,
    left: inVersions.left + leftInSaved,
    beside: inVersions.beside,
  };
};

/**
 * The uploads under a document's name, whose originals a content purge
 * deletes, whatever it finds in the text: the files may hold the terms
 * where extraction never read them (an image in a PDF, say). One still
 * being extracted too: forgotten, it isn't saved.
 */
const uploadsNamed = (document: DocumentRow) =>
  and(
    eq(uploads.collectionId, document.collectionId),
    eq(uploads.path, document.path)
  );

/** How many uploaded originals `where` names, which a purge deletes. */
const originalsOf = async (
  db: DrizzleD1Database,
  where: SQL | undefined
): Promise<number> => {
  const [found] = await db
    .select({ count: count() })
    .from(uploads)
    .where(where);
  return found?.count ?? 0;
};

/**
 * Purges the terms from `named`, as `person`: rewrites the earlier
 * versions that hold one in place, a page at a time; then, if anything
 * held one, saves the current text, without them, as the next version
 * (`writeVersion`), which makes the sections, links, search rows, title,
 * description, owner and tags again, and gives memory cached by version a
 * new key. In the same batch, the current version is rewritten in place
 * too.
 *
 * The save is from the version the purge started at, so anyone who saved
 * or restored meanwhile, from text the purge hadn't rewritten yet, makes
 * it fail with
 * `knowledge.conflict`; running the purge again rewrites theirs too. A purge cut short leaves the current version as it
 * was, so running it again finishes it; one run again after it finished
 * finds nothing, and writes nothing.
 */
const purgeDocument = async (
  env: Env,
  db: DrizzleD1Database,
  person: Identity,
  named: Named,
  matcher: Matcher
): Promise<Counts> => {
  const { document, collection } = named;
  const at = document.currentVersion;
  const earlier = await rewriteVersions(db, document, at - 1, matcher, true);
  const current = await versionOf(db, document, at);
  const changed = current && rewritten(current, matcher);
  const changedVersions = earlier.changed + (changed === undefined ? 0 : 1);
  const counts: Counts = {
    documents: changedVersions > 0 ? 1 : 0,
    versions: changedVersions,
  };
  if (current === undefined || counts.documents === 0) {
    // Nothing in its text, but maybe in a file uploaded as it (a term in
    // an image in a PDF, which extraction never read): its originals go
    // all the same.
    await db.batch(forgetUploads(db, uploadsNamed(document)));
    return counts;
  }
  const text = changed?.text ?? current.text;
  await writeVersion(env, personWriter(person), {
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
    also: [
      ...(changed === undefined
        ? []
        : [
            db
              .update(versions)
              .set(changed)
              .where(
                and(
                  eq(versions.documentId, document.id),
                  eq(versions.number, at)
                )
              ),
          ]),
      ...forgetUploads(db, uploadsNamed(document)),
    ],
  });
  return counts;
};

/**
 * What a content purge would change, how often it removes a term and how
 * often one is left (when `matcher` counts them), checking every document
 * first.
 */
const contentCounts = async (
  env: Env,
  db: DrizzleD1Database,
  named: Named[],
  matcher: Matcher
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
    const document = await countDocument(env, db, one, matcher);
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
 * What it leaves on purpose (a term inside a longer address, "Tom" in
 * "Toms") isn't a token of its own, except an address or a domain inside
 * a longer one, whose tokens are all there: those count here too, and the
 * plan said so (`inLongerWords`). A term with no token (punctuation only)
 * has nothing to find.
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

/**
 * Purges the terms from the documents named: checked first, every version
 * of every one, a page at a time, so a purge that would leave one that
 * can't be saved or stored changes nothing; then recorded in the audit
 * log; then run, one document at a time. The search index is rebuilt
 * last, also when nothing was left to change, so running a purge again
 * finishes a cleanup that failed.
 */
const purgeContent = async (
  env: Env,
  person: Identity,
  input: ContentPurge
): Promise<PurgeResult> => {
  const db = drizzle(env.KNOWLEDGE);
  const named = await documentsNamed(db, input);
  const matcher = matcherOf(input.terms, { countLeft: false });
  // Read before anything changes: whether a term is part of a longer
  // token anywhere, so the index needs rebuilding, is recorded with the
  // purge, and a run again after its text is rewritten still knows.
  const { tokensKnown } = await contentCounts(env, db, named, matcher);
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
  await auditedBatch(env, db, [
    outboxed(
      db,
      purgeEntry(
        person,
        "knowledge.purged",
        input,
        { documentIds: named.map(({ document }) => document.id) },
        { documents: named.length },
        purgeId
      )
    ),
    rebuildOwed(db, purgeId),
  ]);
  const done: Counts[] = [];
  try {
    for (const one of named) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time, to bound memory
      done.push(await purgeDocument(env, db, person, one, matcher));
    }
  } finally {
    // A rebuild from now on covers this purge's writes, also when one of
    // them failed: it writes no more.
    await owedWritesDone(db, purgeId);
  }
  await cleanUpOriginals(env);
  await cleanSearchIndex(async () => {
    await eraseFromSearchIndex(db, input.terms, {
      secure,
      tokensKnown,
      id: purgeId,
    });
  });
  const stillFound = await stillFoundIn(
    db,
    input.terms,
    named.map(({ document }) => document.id)
  );
  if (stillFound > 0) {
    log.warn("knowledge.purge_still_found", { purgeId, documents: stillFound });
  }
  return { purgeId, ...sum(done), stillFound };
};

/**
 * What the purge `input` would remove, for `person` to confirm with the
 * token returned. Admins only (not Grasp staff), behind `knowledge_purge`.
 * Recorded in the audit log, without the terms.
 */
export const preparePurge = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<PurgePlan> => {
  requirePurger(person);
  const parsed = parseInput(input);
  const db = drizzle(env.KNOWLEDGE);
  let scope: { collectionId?: string; documentIds: string[] };
  let counts: Counts;
  let originals: number;
  // A personal purge deletes whole documents: nothing is left in a word.
  let removed = 0;
  let left = 0;
  if (parsed.type === "personal") {
    ({ counts, ...scope } = await personalScope(db, parsed));
    originals = await originalsOf(
      db,
      eq(uploads.collectionId, scope.collectionId ?? "")
    );
  } else {
    const named = await documentsNamed(db, parsed);
    originals = await originalsOf(
      db,
      or(...named.map(({ document }) => uploadsNamed(document)))
    );
    scope = { documentIds: named.map(({ document }) => document.id) };
    ({ counts, removed, left } = await contentCounts(
      env,
      db,
      named,
      matcherOf(parsed.terms, { countLeft: true })
    ));
  }
  await auditedBatch(env, db, [
    outboxed(
      db,
      purgeEntry(person, "knowledge.purge.prepared", parsed, scope, {
        ...counts,
        ...(parsed.type === "content"
          ? { occurrences: removed, inLongerWords: left }
          : {}),
      })
    ),
  ]);
  return {
    ...counts,
    occurrences: removed,
    inLongerWords: left,
    originals,
    ...(await tokenFor(env, person, parsed)),
  };
};

/**
 * Runs the purge `input`, with the token `preparePurge` returned `person`
 * for it. What it removes is counted as it runs, so it may differ from
 * what was prepared; the counts returned are what it removed.
 */
export const purge = async (
  env: Env,
  person: Identity,
  input: unknown,
  token: unknown
): Promise<PurgeResult> => {
  requirePurger(person);
  const parsed = parseInput(input);
  await requireToken(env, person, parsed, token);
  return parsed.type === "personal"
    ? await purgePersonal(env, person, parsed)
    : await purgeContent(env, person, parsed);
};
