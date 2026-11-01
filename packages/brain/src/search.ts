import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import type { ReadRecord, Allowed } from "./authorize.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { readableCollection } from "./collections.ts";
import { toHex } from "./encoding.ts";
import { collectionIdSchema, documentIdSchema } from "./ids.ts";
import {
  collectionSearchOptionsSchema,
  documentTypeOf,
  knowledgeErrors,
  searchCoverageCap,
  searchOptionsSchema,
  searchQuerySchema,
} from "./knowledge.ts";
import type {
  Provenance,
  SearchCoverage,
  SearchHit,
  SearchResults,
} from "./knowledge.ts";
import { nearestCollectionsMax, nearestDetail } from "./search-detail.ts";

// Full-text search over sections, in two FTS5 indexes kept by triggers on
// the sections table (see the migrations `0001_search.sql` and
// `0017_search_one_content.sql`, one copy of the text for both): whole words,
// with diacritics removed and prefixes indexed ("vakan" finds
// "vakantiedagen", "financiele" finds "financiële"), and trigrams, which
// find a word inside a compound ("verlof" in "zwangerschapsverlof").
//
// One statement asks up to three passes, and a section counts in the first
// that finds it: whole words first, then trigrams; and only when neither
// finds anything, trigrams with room for one typo. Within a pass sections
// rank by which of the query's words each holds, weighed by where (title,
// then description, headings and text; `matchesSql`); among sections that
// hold them alike, shorter and fresher first. Every word of a search must
// match (AND): a search narrows as it gets longer. A recall asks a
// question in its person's words, which no section holds all of, so any
// of its words matches (OR), and the sections that hold more of them come
// first, however long.
//
// Never BM25 (GRA-1083): its weights count a word over every row of the
// index, sections of collections the reader can't read too, so the order
// of a reader's own results would tell them how often a word is in those.
// A section's rank rests on its own words and length alone, and constants:
// measured on the Brain baseline, it keeps BM25's evidence recall at
// scale, and within a point of it on the dev split.
//
// Access is part of the same statement (R11): a section of a collection
// the reader can't read, or of an App's entry they may not find
// (app-entries.ts), is never ranked, counted or returned. What comes
// back is noted as a read (`noteProvenance`), so a search that finds
// restricted data puts the App or agent's chat or App in restricted mode
// before the results are handed over, as any read does.

/** Most words of a query that count; the rest are left out. */
const maxTerms = 16;

/** Shortest word the trigram index can find: one trigram. */
const trigramLength = 3;

/**
 * The typo pass cuts a word in three pieces and asks for any two of them:
 * one typo changes one piece at most, so the other two are in the word as
 * it's spelled right. Two halves would be too loose for Dutch, where half a
 * compound is often a word of its own ("regeling" of "pensioenregeling").
 * Each piece is a trigram at least, so only long words get the pass: the
 * compounds a typo most often lands in.
 */
const typoPieces = 3;
const typoLength = typoPieces * trigramLength;

/** Most sections of one document in one search's results. */
const maxHitsPerDocument = 3;

/** Tokens of text around a whole-word match; trigrams are characters. */
const snippetWords = 24;
const snippetCharacters = 64;

const yearMs = 365 * 24 * 60 * 60 * 1000;

/** Whatever isn't a letter or a digit separates words. */
const wordPattern = /[\p{L}\p{N}]+/gu;

/** A query's distinct words: lowercased, at most {@link maxTerms}. */
export const termsOf = (query: string): string[] =>
  [...new Set(query.normalize("NFKC").toLowerCase().match(wordPattern))].slice(
    0,
    maxTerms
  );

/** An FTS5 string: words only, so quoting is all it needs. */
const quoted = (term: string) => `"${term}"`;

/**
 * A term as the words pass asks for it: as a prefix ("vakan" finds
 * "vakantiedagen"), but a single character exactly. The prefix indexes
 * (`prefix = '2 3'`) don't cover one character, so `"7"*` would merge
 * every term that starts with a 7: seconds at 100k sections, for `INC-7`.
 */
export const asWord = (term: string): string =>
  // Code points, as in `passesOf`.
  // oxlint-disable-next-line typescript/no-misused-spread -- see passesOf
  [...term].length === 1 ? quoted(term) : `${quoted(term)}*`;

const digitsPattern = /^\p{N}+$/u;

/**
 * Whether the trigram passes ask for a term (its code points given): long
 * enough for a trigram, and not only digits. Trigrams find words inside
 * compounds and words with a typo; a group of digits ("2024" in
 * "CR-2024-118") is neither, the words pass already matches it, and it is
 * in so many codes that its trigrams cost seconds at 100k sections.
 */
const trigramReady = (term: string, chars: string[]): boolean =>
  chars.length >= trigramLength && !digitsPattern.test(term);

/**
 * A long word as the typo pass asks for it: two of its three pieces, close
 * together, as they are in the word spelled right. Pieces far apart in a
 * section ("zwang…" and "…zonder" in "bijzonder verlof of zwangerschap")
 * aren't a typo. FTS5 counts the distance in trigrams: between two pieces
 * of the word lie at most the middle piece, a typo and two trigrams.
 */
const allowingTypo = (letters: string[]): string => {
  const bounds = Array.from({ length: typoPieces + 1 }, (_, index) =>
    Math.floor((index * letters.length) / typoPieces)
  );
  const pieces = bounds
    .slice(0, -1)
    .map((start, index) =>
      quoted(letters.slice(start, bounds[index + 1]).join(""))
    );
  const near = Math.ceil(letters.length / typoPieces) + trigramLength;
  const [first, second, third] = pieces;
  return [
    [first, second],
    [first, third],
    [second, third],
  ]
    .map(([one, other]) => `NEAR(${one} ${other}, ${near})`)
    .join(" OR ");
};

/** The typo pass: only asked for when the others find nothing. */
const typoPass = 2;

interface Pass {
  table: string;
  pass: number;
  match: string;
  /** Each of the query's words, as this pass asks for it: what a row is scored by. */
  terms: string[];
  /**
   * Words the trigrams don't ask for (too short, or only digits), which the
   * section must then have as words, so that every word of the query still
   * counts.
   */
  short?: string;
}

/** The FTS5 queries of each pass that has one, in order. */
/** How a pass joins a query's words: all of them, or any (a recall). */
type Joiner = " AND " | " OR ";

const passesOf = (terms: string[], joiner: Joiner): Pass[] => {
  const words = (list: string[]) => list.map(asWord).join(joiner);
  const letters = terms.map((term) => ({
    term,
    // Code points, as the trigram tokenizer counts them. Terms are letters
    // and digits only (`wordPattern`): no emoji or joiners to split.
    // oxlint-disable-next-line typescript/no-misused-spread -- see above
    chars: [...term],
  }));
  const long = letters.filter(({ term, chars }) => trigramReady(term, chars));
  const short = letters
    .filter(({ term, chars }) => !trigramReady(term, chars))
    .map(({ term }) => term);
  const trigrams = (asked: string[]): Pass | undefined =>
    long.length === 0
      ? undefined
      : {
          table: "search_trigrams",
          pass: 0,
          match: asked.join(joiner),
          terms: asked,
          // Each word counts only when every one must match.
          ...(short.length === 0 || joiner === " OR "
            ? {}
            : { short: words(short) }),
        };
  const typo = long.map(({ term, chars }) =>
    chars.length < typoLength ? quoted(term) : `(${allowingTypo(chars)})`
  );
  return [
    {
      table: "search_words",
      pass: 0,
      match: words(terms),
      terms: terms.map(asWord),
    },
    trigrams(long.map(({ term }) => quoted(term))),
    long.some(({ chars }) => chars.length >= typoLength)
      ? trigrams(typo)
      : undefined,
  ].flatMap((pass, index) =>
    pass === undefined ? [] : [{ ...pass, pass: index }]
  );
};

/**
 * The exact lane's one pass (exact.ts): any of `phrases`, each its words
 * in a row, whole, in the words index. Never a prefix, a trigram or a
 * typo: an identifier found almost is another identifier.
 */
const exactPassesOf = (phrases: readonly (readonly string[])[]): Pass[] => {
  const asked = phrases.map((words) => quoted(words.join(" ")));
  return asked.length === 0
    ? []
    : [
        {
          table: "search_words",
          pass: 0,
          match: asked.join(" OR "),
          terms: asked,
        },
      ];
};

/** Each FTS table's columns: title, description, headings, text. */
const columnsOf: Readonly<Record<string, readonly string[]>> = {
  search_words: ["title", "description", "headings", "text"],
  search_trigrams: ["c0", "c1", "c2", "c3"],
};

/** How much a section's length weighs against its words, as BM25's `b`. */
const lengthWeight = 0.75;

/** The length, in characters, a section's words count for as they are. */
const referenceLength = 600;

/** How much a word in each column counts: title, description, headings, text. */
const columnWeights = [10, 5, 3, 1] as const;

/**
 * What a row is scored by, as one JSON array bound once: for each of the
 * query's words in each column, the FTS5 query that finds it there, what
 * it counts towards the score, and towards the section's own score
 * (headings and text alone).
 */
const askedOf = (table: string, terms: readonly string[]): string =>
  JSON.stringify(
    terms.flatMap((term) =>
      (columnsOf[table] ?? []).map((column, index) => [
        `${column} : (${term})`,
        columnWeights[index] ?? 0,
        index >= 2 ? (columnWeights[index] ?? 0) : 0,
      ])
    )
  );

/**
 * One pass's matches: the rows holding the query's words as the pass asks
 * for them, unscored. Only the matches a reader may read are scored
 * (`scoreSql`), so a narrow search never scores sections of collections it
 * doesn't search, nor sections that don't hold the whole query.
 */
const matchesSql = ({ table, pass, match, short }: Pass): SQL => {
  const name = sql.identifier(table);
  return sql`SELECT matched.rowid AS row_id, ${pass} AS pass
    FROM ${name} AS matched
    WHERE matched.${name} MATCH ${match}
    ${
      short === undefined
        ? sql``
        : sql`AND matched.rowid IN (
            SELECT rowid FROM search_words WHERE search_words MATCH ${short}
          )`
    }`;
};

/** Which of `askedOf`'s weights a score sums: the row's, or its own headings and text alone. */
const weightAt = { score: 1, own: 2 } as const;

/**
 * The score of the row `found.row_id` in the pass `found.pass` found it
 * in, lower first: minus the weight of every column each of the query's
 * words is in (`weight`: the whole row's, or its own headings and text
 * alone). Never BM25: its weights count a word over every row of the
 * index, sections of collections the reader can't read too, so the order
 * of a reader's own results would tell them how often a word is in those
 * (GRA-1083). A row's score is its own words alone: each lookup asks
 * whether this one row holds a word in a column, and no count over other
 * rows reaches it.
 */
const scoreSql = (
  passes: readonly Pass[],
  weight: keyof typeof weightAt
): SQL => {
  const at = sql.raw(`'$[${weightAt[weight]}]'`);
  const cases = passes.map(({ table, pass, terms }) => {
    const name = sql.identifier(table);
    return sql`WHEN ${pass} THEN (
      SELECT coalesce(sum(json_extract(asked.value, ${at})), 0)
      FROM json_each(${askedOf(table, terms)}) AS asked, ${name}
      WHERE ${name}.rowid = found.row_id
        AND ${name} MATCH json_extract(asked.value, '$[0]')
    )`;
  });
  return sql`-(CASE found.pass ${sql.join(cases, sql` `)} ELSE 0 END)`;
};

/**
 * The snippet of the section `row_id` of the results, from the pass that
 * found it: made only for the sections returned, not for every match.
 */
const snippetSql = (passes: Pass[]): SQL => {
  const cases = passes.map(({ table, pass, match }) => {
    const name = sql.identifier(table);
    const size = table === "search_words" ? snippetWords : snippetCharacters;
    return sql`WHEN ${pass} THEN (
      SELECT snippet(${name}, 3, '', '', '…', ${sql.raw(String(size))})
      FROM ${name} WHERE ${name} MATCH ${match} AND rowid = ranked.row_id
    )`;
  });
  return sql`CASE ranked.pass ${sql.join(cases, sql` `)} END`;
};

const hitRowSchema = z.object({
  documentId: z.string(),
  collectionId: z.string(),
  sensitive: z.number(),
  path: z.string(),
  title: z.string(),
  type: z.string(),
  description: z.string(),
  section: z.number(),
  headings: z.string(),
  snippet: z.string(),
  version: z.number(),
  updatedAt: z.number(),
  text: z.string(),
});

/**
 * The most of a section's text a search reads: a recall quotes no more
 * (recall.ts), and a section can be as large as a document.
 */
export const sectionTextMax = 4000;

/**
 * Up to `sectionTextMax` characters of a section, around where it first
 * holds one of `terms` (the first that it holds, in the query's order), so
 * a match deep in a long section still comes with its words; from the
 * start when none is found as typed (a typo or prefix match).
 */
const excerptSql = (terms: readonly string[]): SQL => {
  const found = terms.map(
    (term) => sql`nullif(instr(lower(sections.text), ${term}), 0)`
  );
  const at = sql`coalesce(${sql.join([...found, sql`1`], sql`, `)})`;
  return sql`substr(sections.text, max(1, ${at} - ${sectionTextMax / 2}), ${sectionTextMax})`;
};

/** A section a search found, as Knowledge holds it: its hit, and more. */
export interface FoundSection {
  hit: SearchHit;
  /** The document's version the section is of. */
  version: number;
  /** When the document last changed, in milliseconds. */
  updatedAt: number;
  /** The section's Markdown around its match, at most `sectionTextMax` characters. */
  text: string;
}

const headingsSchema = z.array(z.string());

const toHit = (row: z.infer<typeof hitRowSchema>): SearchHit => ({
  documentId: documentIdSchema.parse(row.documentId),
  collectionId: collectionIdSchema.parse(row.collectionId),
  path: row.path,
  title: row.title,
  type: documentTypeOf(row.type),
  description: row.description,
  section: row.section,
  version: row.version,
  headings: headingsSchema.parse(JSON.parse(row.headings)),
  snippet: row.snippet,
});

/**
 * A key for grouping searches that found nothing, without their words:
 * an HMAC of the query's sorted words, keyed from the deployment's auth
 * secret. A plain hash of a short query can be reversed by guessing it
 * ("ziekmelding jan de vries"), and the audit log can't be purged.
 */
const queryKey = async <C>(
  brain: Brain<C>,
  terms: string[]
): Promise<string> => {
  const key = await brain.ports.keys.hmac(
    "grasp-os knowledge search query key",
    ["sign"]
  );
  const normalized = terms
    .map((term) => term.normalize("NFKD").replaceAll(/\p{M}/gu, ""))
    .toSorted()
    .join(" ");
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalized)
  );
  return toHex(new Uint8Array(mac));
};

/**
 * The collections a search of every collection that found nothing came
 * closest in, best first, at most `nearestCollectionsMax`: a pass looser
 * than the search's own, with any of its words (OR) rather than all, and a
 * long word allowing a typo, over only the documents the reader may read.
 * Just their IDs go on, into the search's audit event, for the usage
 * signals to tell those collections' owners; the reader gets nothing of
 * it.
 */
const nearestCollections = async (
  db: DrizzleD1Database,
  allowed: Allowed,
  terms: string[]
): Promise<string[]> => {
  const long = terms.flatMap((term) => {
    // Code points, as in `passesOf`.
    // oxlint-disable-next-line typescript/no-misused-spread -- see above
    const chars = [...term];
    if (!trigramReady(term, chars)) {
      return [];
    }
    return [
      chars.length < typoLength ? quoted(term) : `(${allowingTypo(chars)})`,
    ];
  });
  const passes: Pass[] = [
    {
      table: "search_words",
      pass: 0,
      match: terms.map(asWord).join(" OR "),
      terms: terms.map(asWord),
    },
    ...(long.length === 0
      ? []
      : [
          {
            table: "search_trigrams",
            pass: 1,
            match: long.join(" OR "),
            terms: long,
          },
        ]),
  ];
  // MATERIALIZED: with one pass the CTE is a lone SELECT, which SQLite
  // would flatten into the query below, putting FTS5's own lookups inside
  // min(), where it can't evaluate them. A query of only short or digit
  // words has one pass.
  const rows = await db.all(sql`
    WITH matches AS MATERIALIZED (
      ${sql.join(passes.map(matchesSql), sql` UNION ALL `)}
    ),
    found AS MATERIALIZED (
      SELECT matches.row_id, min(matches.pass) AS pass,
        collections.id AS collection_id
      FROM matches
      JOIN search_rows ON search_rows.id = matches.row_id
      JOIN documents ON documents.id = search_rows.document_id
      JOIN collections ON collections.id = documents.collection_id
      WHERE ${allowed.documents()}
      GROUP BY matches.row_id
    )
    SELECT found.collection_id AS collectionId,
      min(${scoreSql(passes, "score")}) AS score
    FROM found
    GROUP BY found.collection_id
    ORDER BY score, found.collection_id
    LIMIT ${nearestCollectionsMax}
  `);
  return z
    .array(z.object({ collectionId: z.string() }))
    .parse(rows)
    .map(({ collectionId }) => collectionId);
};

/**
 * A search, as the audit log records it (`noteProvenance`): who searched,
 * where, and the documents it returned. One that found nothing the reader
 * may read feeds the usage signals that tell owners what's missing, so it
 * has how many words and a key to group the same question by, and, when
 * it searched every collection, the few collections it came closest in
 * (`nearestCollections`). Never the words themselves, nor the documents it
 * came close to: people search for people, and the audit log keeps
 * everything for good.
 */
const searchRecord = async <C>(
  brain: Brain<C>,
  terms: string[],
  collectionId: string | undefined,
  hits: { documentId: string }[],
  nearest: readonly string[] = [],
  recall = false
): Promise<ReadRecord> => {
  const target =
    collectionId === undefined
      ? undefined
      : { type: "collection" as const, id: collectionId };
  // A recall is recorded as a read of what it returned, marked as one:
  // never as an empty search, which feeds owners' signals of what people
  // couldn't find, and automated recalls would skew those.
  if (recall) {
    return {
      action: "knowledge.search",
      target,
      documentIds: hits.map(({ documentId }) => documentId),
      detail: { terms: terms.length, hits: hits.length, via: "recall" },
    };
  }
  if (hits.length === 0) {
    return {
      action: "knowledge.search.empty",
      target,
      detail: {
        terms: terms.length,
        queryKey: await queryKey(brain, terms),
        ...(nearest.length === 0 ? {} : { nearest: nearestDetail(nearest) }),
      },
    };
  }
  return {
    action: "knowledge.search",
    target,
    documentIds: hits.map(({ documentId }) => documentId),
    detail: { terms: terms.length, hits: hits.length },
  };
};

/**
 * How many readable documents in the search's scope (`scope`, `type`)
 * search can't see at their current version: queued or retrying, and
 * failed, each counted up to `searchCoverageCap`. Unscoped, only
 * collections that aren't sensitive are counted: a count says something of
 * what it counts, and a sensitive collection isn't among an unscoped
 * read's sources unless a hit is from it. A scoped search's collection is
 * among them, whatever it is.
 */
const coverageOf = async (
  db: DrizzleD1Database,
  allowed: Allowed,
  scope: string | undefined,
  type: string | undefined
): Promise<SearchCoverage> => {
  const counted = (states: SQL) => sql`(
    SELECT count(*) FROM (
      SELECT 1 FROM documents
      JOIN collections ON collections.id = documents.collection_id
      WHERE documents.index_state IN ${states}
        AND ${allowed.documents()}
        ${scope === undefined ? sql`AND collections.sensitive = 0` : sql`AND collections.id = ${scope}`}
        ${type === undefined ? sql`` : sql`AND documents.type = ${type}`}
      LIMIT ${searchCoverageCap}
    )
  )`;
  const [row] = await db.all<{ pending: number; failed: number }>(sql`
    SELECT ${counted(sql`('queued', 'retrying')`)} AS pending,
      ${counted(sql`('failed')`)} AS failed
  `);
  return { pending: row?.pending ?? 0, failed: row?.failed ?? 0 };
};

/**
 * `search`, with each section's version, last change and whole text: what
 * a recall (recall.ts) cites and quotes. The same reads, checks and audit.
 */
export const searchSections = async <C>(
  brain: Brain<C>,
  reader: C,
  query: unknown,
  options?: unknown,
  only?: string,
  /**
   * For a recall: only these collections, each refused as not found
   * unless the reader may read it, read in one search; matching any of
   * the query's words, ranked by the words each holds (`matchesSql`); and recorded as a
   * recall (`searchRecord`).
   */
  recall?: {
    among?: readonly string[];
    /**
     * For a recall's exact lane (exact.ts): the sections that hold any of
     * these, each its words in a row, in place of the query's words.
     */
    exact?: readonly (readonly string[])[];
  }
): Promise<{
  sections: FoundSection[];
  coverage: SearchCoverage;
  provenance: Provenance;
}> => {
  const asked = termsOf(
    knowledgeErrors.parse("knowledge.invalid", searchQuerySchema, query)
  );
  const exact = recall?.exact?.filter((phrase) => phrase.length > 0);
  // An exact read counts the words of its phrases, as it asks for them.
  const terms =
    exact === undefined ? asked : [...new Set(exact.flat())].slice(0, maxTerms);
  const {
    collectionId: scope,
    type,
    limit,
  } = only === undefined
    ? knowledgeErrors.parse("knowledge.invalid", searchOptionsSchema, options)
    : {
        ...knowledgeErrors.parse(
          "knowledge.invalid",
          collectionSearchOptionsSchema,
          options
        ),
        collectionId: only,
      };
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  // Refused like any read of a collection the reader can't read. A search
  // in one collection reads from it whatever it finds: that nothing
  // matches says something of what it holds too. So the collection is
  // among the read's sources, and a sensitive one restricts the reader
  // even when nothing is found, or a delegate could probe it word by word
  // and send out what it learned.
  const among = recall?.among ?? [];
  const scoped = await Promise.all(
    [...(scope === undefined ? [] : [scope]), ...among].map(
      async (id) => await readableCollection(db, allowed.collections, id)
    )
  );
  // What search can't see yet, declared to a search; a recall cites only
  // what it found, each section with its version.
  const coverage =
    recall === undefined
      ? await coverageOf(db, allowed, scope, type)
      : { pending: 0, failed: 0 };
  if (terms.length === 0) {
    return {
      sections: [],
      coverage,
      provenance: await brain.ports.onRead(
        reader,
        await searchRecord(brain, terms, scope, [], [], recall !== undefined),
        ...scoped
      ),
    };
  }
  const now = brain.ports.clock().getTime();
  const today = new Date(now).toISOString().slice(0, 10);
  // Freshness scales a score by 0.5 to 1: a quarter off for a year without
  // changes, and a quarter off past the review date. It orders sections that
  // hold the query's words alike; it never lifts a poor match over a good one.
  const freshness = sql`(1.0
    - 0.25 * min(1.0, max(0.0, (${now} - documents.updated_at) / (${yearMs} * 1.0)))
    - (CASE WHEN documents.review_date < ${today} THEN 0.25 ELSE 0.0 END))`;
  // A section's words count for less the longer it is past a fixed length,
  // as BM25 normalizes for length, but by a constant (`referenceLength`),
  // never the index's average: that would count the length of sections
  // the reader can't read. Unlike BM25, length only orders sections that
  // hold the query's words alike (`coverage` comes first): a short section
  // with fewer of them never passes a long one with more.
  const lengthNorm = sql`(${sql.raw(String(1 - lengthWeight))} + ${sql.raw(String(lengthWeight))} * (
    SELECT length(sections.text) FROM sections
    WHERE sections.document_id = search_rows.document_id
      AND sections.position = search_rows.position
  ) / ${sql.raw(referenceLength.toFixed(1))})`;
  // Every section of a document repeats its title and description, so a
  // document ranks by its best section, and its sections follow one another
  // in the order their own headings and text match.
  const passes =
    exact === undefined
      ? passesOf(terms, recall === undefined ? " AND " : " OR ")
      : exactPassesOf(exact);
  const rows = await db.all(sql`
    WITH matches AS (${sql.join(passes.map(matchesSql), sql` UNION ALL `)}),
    readable AS (
      SELECT matches.row_id, matches.pass,
        ${freshness} AS freshness, ${lengthNorm} AS length_norm,
        search_rows.document_id, search_rows.position,
        collections.id AS collection_id, collections.sensitive,
        row_number() OVER (PARTITION BY matches.row_id ORDER BY matches.pass) AS nth
      FROM matches
      JOIN search_rows ON search_rows.id = matches.row_id
      JOIN documents ON documents.id = search_rows.document_id
      JOIN collections ON collections.id = documents.collection_id
      WHERE ${allowed.documents()}
        ${scope === undefined ? sql`` : sql`AND collections.id = ${scope}`}
        ${
          among.length === 0
            ? sql``
            : sql`AND collections.id IN (${sql.join(
                among.map((id) => sql`${id}`),
                sql`, `
              )})`
        }
        ${type === undefined ? sql`` : sql`AND documents.type = ${type}`}
    ),
    found AS (
      SELECT * FROM readable
      WHERE nth = 1 AND (pass < ${typoPass}
        OR NOT EXISTS (SELECT 1 FROM readable WHERE pass < ${typoPass}))
    ),
    -- Only now scored: the matches of the whole query the reader may read,
    -- in what they searched.
    scored AS (
      SELECT found.*, ${scoreSql(passes, "score")} AS coverage,
        ${scoreSql(passes, "own")} AS own
      FROM found
    ),
    weighed AS (
      SELECT *, coverage * freshness / length_norm AS rank FROM scored
    ),
    ranked AS (
      SELECT *,
        row_number() OVER (
          PARTITION BY document_id ORDER BY pass, own, coverage, rank
        ) AS in_document,
        first_value(pass) OVER document AS document_pass,
        first_value(rank) OVER document AS document_rank,
        first_value(coverage) OVER document AS document_coverage
      FROM weighed
      WINDOW document AS (PARTITION BY document_id ORDER BY pass, coverage, rank)
    ),
    top AS (
      SELECT * FROM ranked
      WHERE in_document <= ${maxHitsPerDocument}
      ORDER BY document_pass, document_coverage, document_rank, document_id, in_document
      LIMIT ${limit}
    )
    -- The title, description and path are the document's as it is now;
    -- the headings and snippet are of the version search holds, which can
    -- be older while indexing catches up (the hit's version says which).
    SELECT ranked.document_id AS documentId,
      ranked.collection_id AS collectionId, ranked.sensitive,
      documents.path, documents.title, documents.type, documents.description,
      ranked.position AS section, sections.headings,
      ${snippetSql(passes)} AS snippet,
      -- The version search holds, which a citation pins: older than the
      -- document's current one while indexing catches up.
      sections.version AS version, documents.updated_at AS updatedAt,
      ${recall === undefined ? sql`''` : excerptSql(terms)} AS text
    FROM top AS ranked
    JOIN documents ON documents.id = ranked.document_id
    JOIN sections ON sections.document_id = ranked.document_id
      AND sections.position = ranked.position
    ORDER BY ranked.document_pass, ranked.document_coverage, ranked.document_rank, ranked.document_id,
      ranked.in_document
  `);
  const found = z.array(hitRowSchema).parse(rows);
  // A search of every collection that found nothing notes where it came
  // closest, for the usage signals. Nothing of it reaches the reader.
  const nearest =
    scope === undefined &&
    among.length === 0 &&
    recall === undefined &&
    found.length === 0
      ? await nearestCollections(db, allowed, terms)
      : [];
  const provenance = await brain.ports.onRead(
    reader,
    await searchRecord(
      brain,
      terms,
      scope,
      found,
      nearest,
      recall !== undefined
    ),
    ...scoped,
    ...found.map((row) => ({
      id: row.collectionId,
      sensitive: row.sensitive !== 0,
    }))
  );
  return {
    sections: found.map((row) => ({
      hit: toHit(row),
      version: row.version,
      updatedAt: row.updatedAt,
      text: row.text,
    })),
    coverage,
    provenance,
  };
};

/**
 * The sections that match `query`, best first, in the collections `reader`
 * may read, or in the one `options` names, and of the document type it
 * names, if any. A collection's stub passes its
 * own as `only`, and its options can't name another.
 */
export const search = async <C>(
  brain: Brain<C>,
  reader: C,
  query: unknown,
  options?: unknown,
  only?: string
): Promise<SearchResults> => {
  const { sections, coverage, provenance } = await searchSections(
    brain,
    reader,
    query,
    options,
    only
  );
  return { hits: sections.map(({ hit }) => hit), coverage, provenance };
};
