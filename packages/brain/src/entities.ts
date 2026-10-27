import { and, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import type { BrainSourceRef } from "./contract.ts";
import { inList } from "./db/d1.ts";
import {
  brainAssertions,
  brainEntities,
  brainEntityKeys,
  brainLinkJobs,
  brainMemories,
  brainMentions,
  brainPayloads,
  collections,
  documents,
  versions,
} from "./db/schema.ts";
import { collectionIdSchema, documentIdSchema, memoryIdSchema } from "./ids.ts";
import type { IndexStep, StepConfig } from "./indexing.ts";
import { keyed } from "./keyed.ts";
import { knowledgeErrors } from "./knowledge.ts";
import { log } from "./log.ts";
import { readPayload } from "./payloads.ts";

// Entity linking (GRA-305; the Brain design's "internal network of
// neurons" and "Automatic relationship indexing"): every document version
// and memory revision that becomes current is read for the entities it
// mentions, and each mention is linked to a stable entity, with no call of
// anyone's to make it happen.
//
// The Brain holds no rules about what an entity is. The host's
// `extractEntities` port reads a text through its model gateway and names
// what it mentions: a kind (opaque here), a name, and the exact
// identifiers the text gives for it (an email address, say). The Brain
// keeps only what it can check: a name or identifier the text doesn't
// hold is dropped.
//
// Identity is conservative, and stays inside one partition (a collection,
// or one scope's memory records), so nothing about one partition is ever
// learnt from another's links. A mention is linked only on exact evidence:
// - an identifier: the entity that identifier is known by in the
//   partition, or a new one; two such entities, an entity of another kind,
//   or one other sources call by another name (a shared mailbox on two
//   people) make it ambiguous;
// - otherwise its name: the one entity the partition's current mentions
//   give that name, or a new one; two or more make it ambiguous.
// An ambiguous mention is kept with its candidates, inspectable
// (`linkProposals`), and linked to none. So two people of the same name
// with different identifiers stay two, a renamed entity keeps its ID while
// its identifier stays, and matching across collections is left to
// proposals of its own (GRA-1080).
//
// Each source's mentions are one generation, of one version, replaced
// whole (`commit`), fenced as search's sections are (indexing.ts): the
// batch that makes a version current writes its link job's intent
// (`linkIntent`), and from then on reads and resolution count only
// mentions of a source's current version, so a change hides the old ones
// at once, while their entities keep their IDs for the new version's
// commit to reuse. The commit is guarded by the job still wanting that
// version and holding an older one, so a late extractor never restores
// old mentions.
//
// Erasure goes further: a purge's rewrite, a redaction, a retirement and a
// removal delete what was linked of the source in their own batch, and
// with it every entity only that source named, keys and all
// (`forgetEntitiesOf`); a commit deletes the entities its old mentions
// named that nothing names any more, and makes new entities in its own
// guarded batch. A new entity's ID is random, so an
// identifier mentioned again after its erasure never gets its old ID back.
//
// Linking waits for a source to settle (`settleMs`), so a run of quick
// saves is read once: the clock's sweep (`sweepLinking`) starts each run,
// fails runs that ended without linking, runs failed ones again with
// backoff, a bounded number of times; its progress is the job rows
// (`linkCoverage`). New entities are made in the commit's own batch, so a
// commit fenced out leaves none.
// Names live on the mentions only: an entity row is an ID and a kind, and
// its keys are HMACs.

/** What the host's extractor answers for a text (`extractEntities`). */
export const extractedEntitiesSchema = z.object({
  entities: z.array(
    z.object({
      /** What kind of thing it is, in the extractor's own words. */
      kind: z.string(),
      /** The name the text gives it. */
      name: z.string(),
      /** Exact identifiers the text states for it, such as an email address. */
      identifiers: z.array(z.string()).optional(),
    })
  ),
  /**
   * Relations the text states between those entities (relations.ts), each
   * with the passage that states it and when it holds.
   */
  relations: z
    .array(
      z.object({
        /** The subject's name, as `entities` gives it. */
        subject: z.string(),
        /** What the relation is, in the extractor's words (`owns`). */
        predicate: z.string(),
        /** The object's name, as `entities` gives it. */
        object: z.string(),
        /** From when it holds, as an ISO date, if the text says. */
        validFrom: z.string().nullish(),
        /** Until when it holds, as an ISO date, if the text says. */
        validTo: z.string().nullish(),
        /** The passage of the text that states it, word for word. */
        evidence: z.string(),
      })
    )
    .optional(),
});

/** How long a source stays unchanged before it is read. */
export const settleMs = 30_000;

/** The most characters one extraction reads, and how many a source gets. */
const chunkChars = 8000;
const maxChunks = 4;

/** The most mentions one source keeps, and identifiers one mention. */
const mentionsPerSource = 100;
const identifiersPerMention = 5;

/** The longest kind, name and identifier kept. */
const kindMaxLength = 40;
const nameMaxLength = 200;
const identifierMaxLength = 320;

/** Mention rows per insert: each binds 13, and D1 binds at most 100. */
const mentionsPerInsert = 7;

/** Relation rows per insert: each binds 17, and D1 binds at most 100. */
const assertionsPerInsert = 5;

/** Sources the sweep looks at, each minute. */
const sweepBatch = 20;

/** The most mention rows one read considers. */
const readRowsMax = 5000;

/** Runs the sweep starts again for a failed job, at most. */
export const maxLinkReruns = 5;

/** Retries of the linking step: as indexing's, so a moment's outage passes. */
const linkConfig: StepConfig = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: 5 * 60_000,
};

const whitespace = /\s+/gu;
const notWord = /[^\p{L}\p{N}]+/gu;
const edgeUnderscores = /^_+|_+$/gu;
const sourcePattern = /^(?<prefix>doc|mem):(?<id>.+)$/u;

/** A source of mentions: a document or a memory record. */
export type LinkSource =
  | { kind: "document"; id: string }
  | { kind: "memory"; id: string };

/** The link job's key for `source`. */
export const sourceKey = (source: LinkSource): string =>
  `${source.kind === "document" ? "doc" : "mem"}:${source.id}`;

const sourceOf = (key: string): LinkSource => {
  const { prefix, id } = sourcePattern.exec(key)?.groups ?? {};
  if (id === undefined) {
    throw brainErrors.create("brain.invalid");
  }
  return prefix === "doc" ? { kind: "document", id } : { kind: "memory", id };
};

/** A linking run: its job, as the host runs it. */
export const linkRunId = (source: string, version: number, run: number) =>
  `link-${source.replace(":", "-")}-${version}-${run}`;

const wordCharacter = /[\p{L}\p{N}]/u;

/** Where `folded` holds `term` whole first (see `holds`), or -1. */
const wholeAt = (folded: string, term: string): number => {
  for (
    let at = folded.indexOf(term);
    at !== -1;
    at = folded.indexOf(term, at + 1)
  ) {
    const before = folded[at - 1];
    const after = folded[at + term.length];
    if (
      (before === undefined || !wordCharacter.test(before)) &&
      (after === undefined || !wordCharacter.test(after))
    ) {
      return at;
    }
  }
  return -1;
};

/**
 * Whether `folded` holds `term` whole: never as part of a longer word or
 * address ("anna@example.org" in "joanna@example.org", "Ann" in "Anna").
 */
const holds = (folded: string, term: string): boolean =>
  wholeAt(folded, term) !== -1;

const spaceCharacter = /\s/u;

/**
 * `text` folded a character at a time (NFKC, lower case, single spaces),
 * with where in `text` each folded code unit starts and ends: so a match
 * in the folded text is a span of the text itself.
 */
const foldedWithPlaces = (
  text: string
): { folded: string; starts: number[]; ends: number[] } => {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let spaced = false;
  let index = 0;
  for (const character of text) {
    const at = index;
    index += character.length;
    if (spaceCharacter.test(character)) {
      spaced = folded !== "";
      continue;
    }
    if (spaced) {
      folded += " ";
      starts.push(at);
      ends.push(at);
      spaced = false;
    }
    const piece = character.normalize("NFKC").toLowerCase();
    folded += piece;
    const end = index;
    // One place for each code unit of the piece, as the folded string
    // counts them.
    starts.push(...Array.from({ length: piece.length }, () => at));
    ends.push(...Array.from({ length: piece.length }, () => end));
  }
  return { folded, starts, ends };
};

/**
 * Finds the span of `text` that a quote matches, folded alike and whole:
 * the text's own characters, never the quote's, or `undefined` when the
 * text doesn't hold it. The text is folded once, however many quotes are
 * looked for in it.
 */
const spansIn = (text: string): ((quote: string) => string | undefined) => {
  const { folded, starts, ends } = foldedWithPlaces(text);
  return (quote) => {
    const term = foldedWithPlaces(quote).folded;
    const at = term === "" ? -1 : wholeAt(folded, term);
    const start = starts[at];
    const end = ends[at + term.length - 1];
    return at === -1 || start === undefined || end === undefined
      ? undefined
      : text.slice(start, end);
  };
};

/** Text as names are matched: NFKC, lower case, single spaces. */
const fold = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replaceAll(whitespace, " ").trim();

const kindOf = (kind: string): string =>
  fold(kind)
    .replaceAll(notWord, "_")
    .replaceAll(edgeUnderscores, "")
    .slice(0, kindMaxLength);

/**
 * The statement that deletes every entity only `sources` mention (a
 * subquery of link job keys), with its keys (and those mentions, by
 * cascade), if `condition` holds as it runs: before the statement that
 * removes those sources' mentions, in the same batch, so an erased
 * source's identifiers leave no entity behind. A later mention makes a new
 * entity, with a new ID.
 */
export const forgetEntitiesOf = (
  db: DrizzleD1Database,
  sources: SQL,
  condition: SQL = sql`1`
) =>
  db
    .delete(brainEntities)
    .where(
      sql`(${brainEntities.id} IN (SELECT entity_id FROM brain_mentions WHERE source IN ${sources}) OR ${brainEntities.id} IN (SELECT subject_entity_id FROM brain_assertions WHERE source IN ${sources}) OR ${brainEntities.id} IN (SELECT object_entity_id FROM brain_assertions WHERE source IN ${sources})) AND NOT EXISTS (SELECT 1 FROM brain_mentions AS other WHERE other.entity_id = ${brainEntities.id} AND other.source NOT IN ${sources}) AND NOT EXISTS (SELECT 1 FROM brain_assertions AS said WHERE (said.subject_entity_id = ${brainEntities.id} OR said.object_entity_id = ${brainEntities.id}) AND said.source NOT IN ${sources}) AND ${condition}`
    );

/** One link job's key, as the subquery `forgetEntitiesOf` takes. */
const onlySource = (key: string): SQL => sql`(SELECT ${key})`;

/**
 * The statements that erase what is linked of `source` now, if `condition`
 * holds as it runs: the entities only it names (with what of it names
 * them, by cascade), then its mentions and every relation it ever stated,
 * superseded ones too: each quotes it.
 */
const eraseLinked = (
  db: DrizzleD1Database,
  key: string,
  condition: SQL = sql`1`
): BatchItem<"sqlite">[] => [
  forgetEntitiesOf(db, onlySource(key), condition),
  db.delete(brainMentions).where(and(eq(brainMentions.source, key), condition)),
  db
    .delete(brainAssertions)
    .where(and(eq(brainAssertions.source, key), condition)),
];

/**
 * The statement a change's batch runs to make `version` of `source` its
 * link job's intent, after the statement that writes the source's own row.
 * The mentions of the version before stay until the new version's commit
 * replaces them, so an entity's ID outlives a rename; reads and resolution
 * count only mentions of a source's current version, so a change hides
 * them at once.
 */
export const linkIntent = (
  db: DrizzleD1Database,
  source: LinkSource,
  version: number,
  now: Date
): BatchItem<"sqlite"> => {
  const key = sourceKey(source);
  const pending = {
    version,
    state: "queued" as const,
    attempts: 0,
    failure: null,
    run: 0,
    failedAt: null,
    updatedAt: now,
  };
  return db
    .insert(brainLinkJobs)
    .values({
      source: key,
      documentId: source.kind === "document" ? source.id : null,
      memoryId: source.kind === "memory" ? source.id : null,
      ...pending,
    })
    .onConflictDoUpdate({ target: brainLinkJobs.source, set: pending });
};

/**
 * The sources of collections the host alone writes, as copies of what it
 * keeps elsewhere (core's Grasp skills from the release, its Apps'
 * entries from the App registry): never linked, so a release or an App's
 * indexing spends no model calls on text nobody wrote here.
 */
const mirroredSources: ReadonlySet<string> = new Set(["grasp", "apps"]);

/**
 * The statements a save's batch runs for a document's linking: its
 * `linkIntent`, and when the save is a purge's rewrite (`erase`), what is
 * linked of the text it rewrites erased at once; in a mirrored collection,
 * its link job and whatever was linked of it gone.
 */
export const documentLinkIntent = (
  db: DrizzleD1Database,
  collection: { source: string },
  documentId: string,
  version: number,
  now: Date,
  erase: boolean
): BatchItem<"sqlite">[] => {
  const source = { kind: "document" as const, id: documentId };
  const key = sourceKey(source);
  if (mirroredSources.has(collection.source)) {
    return [
      forgetEntitiesOf(db, onlySource(key)),
      db.delete(brainLinkJobs).where(eq(brainLinkJobs.source, key)),
    ];
  }
  return [
    ...(erase ? eraseLinked(db, key) : []),
    linkIntent(db, source, version, now),
  ];
};

/**
 * `linkIntent` for a memory record inserted earlier in the same batch,
 * only if `condition` holds as it runs (the remember's receipt stored).
 */
export const memoryLinkIntentWhere = (
  db: DrizzleD1Database,
  memoryId: string,
  version: number,
  now: Date,
  condition: SQL
) =>
  db
    .insert(brainLinkJobs)
    .select(
      sql`SELECT ${sourceKey({ kind: "memory", id: memoryId })}, NULL, ${memoryId}, ${version}, NULL, 'queued', 0, NULL, 0, NULL, 0, ${now.getTime()} WHERE ${condition}`
    );

/**
 * A memory record's redaction, once made (`condition`): what was linked of
 * the text it replaced erased, and its next revision queued.
 */
export const relinkWhere = (
  db: DrizzleD1Database,
  source: LinkSource,
  version: number,
  now: Date,
  condition: SQL
): BatchItem<"sqlite">[] => {
  const key = sourceKey(source);
  return [
    ...eraseLinked(db, key, condition),
    db
      .update(brainLinkJobs)
      .set({
        version,
        state: "queued",
        attempts: 0,
        failure: null,
        run: 0,
        failedAt: null,
        updatedAt: now,
      })
      .where(and(eq(brainLinkJobs.source, key), condition)),
  ];
};

/**
 * The statements that take a memory record's link job away, with what was
 * linked of it, when `condition` holds as they run: a record being
 * retired or deleted, before the statement that does it.
 */
export const unlinkMemoryWhere = (
  db: DrizzleD1Database,
  memoryId: string,
  condition: SQL
): BatchItem<"sqlite">[] => {
  const key = sourceKey({ kind: "memory", id: memoryId });
  return [
    forgetEntitiesOf(db, onlySource(key), condition),
    db
      .delete(brainLinkJobs)
      .where(and(eq(brainLinkJobs.source, key), condition)),
  ];
};

/**
 * Before a personal purge deletes `ownerId`'s memory records: the
 * entities only they mention.
 */
export const forgetPersonEntities = (db: DrizzleD1Database, ownerId: string) =>
  forgetEntitiesOf(
    db,
    sql`(SELECT ${brainLinkJobs.source} FROM ${brainLinkJobs} WHERE ${brainLinkJobs.memoryId} IN (SELECT ${brainMemories.id} FROM ${brainMemories} WHERE ${brainMemories.ownerId} = ${ownerId}))`
  );

/**
 * Before a purge deletes `collectionId`'s documents: the entities only
 * they mention.
 */
export const forgetCollectionEntities = (
  db: DrizzleD1Database,
  collectionId: string
) =>
  forgetEntitiesOf(
    db,
    sql`(SELECT ${brainLinkJobs.source} FROM ${brainLinkJobs} WHERE ${brainLinkJobs.documentId} IN (SELECT ${documents.id} FROM ${documents} WHERE ${documents.collectionId} = ${collectionId}))`
  );

// Extracting.

/** A mention as the extractor's answer gives it, checked and folded. */
interface Mention {
  kind: string;
  name: string;
  alias: string;
  identifiers: string[];
}

/** A relation as the extractor's answer gives it, checked (relations.ts). */
export interface Relation {
  /** The subject's and object's names, folded as mentions' are. */
  subject: string;
  object: string;
  predicate: string;
  validFrom: string | null;
  validTo: string | null;
  evidence: string;
}

/** A source version as read for linking: its partition, mentions, relations. */
type Extracted = {
  partition: string;
  partial: boolean;
  mentions: Mention[];
  relations: Relation[];
} | null;

/** `text` in pieces the extractor reads, and whether any is left over. */
const chunksOf = (text: string): { chunks: string[]; partial: boolean } => {
  const chunks: string[] = [];
  let rest = text;
  while (rest.trim() !== "" && chunks.length < maxChunks) {
    if (rest.length <= chunkChars) {
      chunks.push(rest);
      rest = "";
      break;
    }
    // At a line break in the second half, if there is one.
    const cut = rest.lastIndexOf("\n", chunkChars);
    const at = cut > chunkChars / 2 ? cut : chunkChars;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return { chunks, partial: rest.trim() !== "" };
};

/**
 * The mentions in `answers` that `text` bears out: a kind and a name the
 * text holds whole, with the identifiers it holds whole too that no other of its
 * entities claims; one per kind and name, their identifiers together, at
 * most `mentionsPerSource`.
 */
export const mentionsOf = (
  text: string,
  answers: readonly z.output<typeof extractedEntitiesSchema>[]
): Mention[] => {
  const folded = fold(text);
  const byName = new Map<string, Mention>();
  for (const { kind, name, identifiers = [] } of answers.flatMap(
    ({ entities }) => entities
  )) {
    const alias = fold(name);
    const sort = kindOf(kind);
    if (
      sort === "" ||
      alias === "" ||
      name.length > nameMaxLength ||
      !holds(folded, alias)
    ) {
      continue;
    }
    const held = identifiers
      .map(fold)
      .filter(
        (identifier) =>
          identifier !== "" &&
          identifier.length <= identifierMaxLength &&
          holds(folded, identifier)
      );
    const key = `${sort}\u0000${alias}`;
    const known = byName.get(key);
    if (known === undefined) {
      if (byName.size >= mentionsPerSource) {
        continue;
      }
      byName.set(key, {
        kind: sort,
        name: name.trim().replaceAll(whitespace, " "),
        alias,
        identifiers: [...new Set(held)].slice(0, identifiersPerMention),
      });
    } else {
      known.identifiers = [...new Set([...known.identifiers, ...held])].slice(
        0,
        identifiersPerMention
      );
    }
  }
  // An identifier two of the source's entities claim identifies neither:
  // a model that pins one person's address on another merges nobody.
  const mentions = [...byName.values()];
  const claims = new Map<string, number>();
  for (const identifier of mentions.flatMap(({ identifiers }) => identifiers)) {
    claims.set(identifier, (claims.get(identifier) ?? 0) + 1);
  }
  return mentions.map((mention) => ({
    ...mention,
    identifiers: mention.identifiers.filter((id) => claims.get(id) === 1),
  }));
};

/** The most relations one source keeps. */
const relationsPerSource = 50;

/** The longest passage a relation keeps as its evidence. */
const evidenceMaxLength = 500;

const isoDate = /^\d{4}-\d{2}-\d{2}$/u;

/** `value` as an ISO date, if it is a real one; `null` for none. */
const dateOf = (value: string | null | undefined): string | null | false => {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  const date = value.trim();
  if (!isoDate.test(date)) {
    return false;
  }
  // A month or day out of range parses to no date at all, or rolls over.
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().startsWith(date)
    ? date
    : false;
};

/**
 * The relations in `answers` that `text` and `mentions` bear out: a
 * passage the text holds whole, a subject and an object each the name of
 * exactly one of the source's mentions, a predicate, and real ISO dates in
 * order, if any; one per subject, predicate, object and dates, at most
 * `relationsPerSource`. The extractor's word is never more than that.
 */
export const relationsOf = (
  text: string,
  answers: readonly z.output<typeof extractedEntitiesSchema>[],
  mentions: readonly Mention[]
): Relation[] => {
  const named = new Map<string, number>();
  for (const { alias } of mentions) {
    named.set(alias, (named.get(alias) ?? 0) + 1);
  }
  const found = new Map<string, Relation>();
  const spanOf = spansIn(text);
  for (const relation of answers.flatMap(({ relations = [] }) => relations)) {
    if (found.size >= relationsPerSource) {
      break;
    }
    const subject = fold(relation.subject);
    const object = fold(relation.object);
    const predicate = kindOf(relation.predicate);
    // The passage as the text itself has it, byte for byte: never the
    // extractor's copy, whose case or spacing may differ.
    const evidence = spanOf(relation.evidence) ?? "";
    const validFrom = dateOf(relation.validFrom);
    const validTo = dateOf(relation.validTo);
    if (
      named.get(subject) !== 1 ||
      named.get(object) !== 1 ||
      subject === object ||
      predicate === "" ||
      evidence === "" ||
      evidence.length > evidenceMaxLength ||
      validFrom === false ||
      validTo === false ||
      (validFrom !== null && validTo !== null && validFrom > validTo)
    ) {
      continue;
    }
    const key = [subject, predicate, object, validFrom, validTo].join("\u0000");
    if (!found.has(key)) {
      found.set(key, {
        subject,
        object,
        predicate,
        validFrom,
        validTo,
        evidence,
      });
    }
  }
  return [...found.values()];
};

/** The job row of `source`, if it has one. */
const jobOf = async (db: DrizzleD1Database, source: string) =>
  await db
    .select()
    .from(brainLinkJobs)
    .where(eq(brainLinkJobs.source, source))
    .get();

/**
 * The text of `version` of `source` and its partition, if that version is
 * still current and not linked yet.
 */
const textToLink = async <C>(
  brain: Brain<C>,
  source: string,
  version: number
): Promise<{ text: string; partition: string } | undefined> => {
  const { db } = brain;
  const job = await jobOf(db, source);
  if (
    job === undefined ||
    job.version !== version ||
    (job.linkedVersion ?? 0) >= version
  ) {
    return undefined;
  }
  const of = sourceOf(source);
  if (of.kind === "memory") {
    const row = await db
      .select({
        statement: brainMemories.statement,
        ownerId: brainMemories.ownerId,
        scope: brainMemories.scope,
        scopeId: brainMemories.scopeId,
      })
      .from(brainMemories)
      .where(
        and(
          eq(brainMemories.id, of.id),
          eq(brainMemories.revision, version),
          ne(brainMemories.state, "retired")
        )
      )
      .get();
    // Its scope's records are one partition: a person's own, or a team's
    // or the company's published ones.
    return (
      row && {
        text: row.statement,
        partition: `memory:${row.scope}:${row.scopeId ?? row.ownerId}`,
      }
    );
  }
  const row = await db
    .select({
      collectionId: documents.collectionId,
      key: brainPayloads.key,
      sha256: brainPayloads.sha256,
    })
    .from(documents)
    .innerJoin(
      versions,
      and(eq(versions.documentId, documents.id), eq(versions.number, version))
    )
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(and(eq(documents.id, of.id), eq(documents.currentVersion, version)))
    .get();
  return (
    row && {
      text: await readPayload(brain, row),
      partition: `collection:${row.collectionId}`,
    }
  );
};

/**
 * Reads `version` of `source` through the host's extractor: its checked
 * mentions, or `null` once it is superseded or linked.
 */
const extract = async <C>(
  brain: Brain<C>,
  source: string,
  version: number
): Promise<Extracted> => {
  const found = await textToLink(brain, source, version);
  if (found === undefined) {
    return null;
  }
  const { chunks, partial } = chunksOf(found.text);
  const answers: z.output<typeof extractedEntitiesSchema>[] = [];
  for (const chunk of chunks) {
    // One at a time: each is a model call against the host's budgets.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const answer = await brain.ports.extractEntities(chunk);
    const parsed = extractedEntitiesSchema.safeParse(answer);
    if (!parsed.success) {
      throw brainErrors.create("brain.unavailable");
    }
    answers.push(parsed.data);
  }
  const mentions = mentionsOf(found.text, answers);
  return {
    partition: found.partition,
    partial,
    mentions,
    relations: relationsOf(found.text, answers, mentions),
  };
};

// Resolving.

/** A mention with what it was resolved to. */
interface Resolved extends Mention {
  entityId: string | null;
  state: "linked" | "ambiguous";
  resolution: "identifier" | "alias" | "new" | "none";
  candidates: string[];
}

/** How a mention's kind and name are matched together. */
const nameOf = (mention: Mention): string =>
  `${mention.kind}\u0000${mention.alias}`;

/** The deployment's key of one piece of identity evidence. */
const keyOf = async <C>(brain: Brain<C>, parts: string[]): Promise<string> =>
  await keyed(brain, "grasp-os brain entity key", parts);

/**
 * Whether `alias` names the entity `names` name: no other name yet (its
 * own source's rename, say), or exactly one of them. Anything else is
 * proposed, never linked: a shared mailbox on "Jan de Vries" and "Piet de
 * Boer" stays two people however much the identifier says otherwise.
 */
const namesAgree = (alias: string, names: ReadonlySet<string>): boolean =>
  names.size === 0 || names.has(alias);

/** Mentions of their source's current version: what still says anything. */
const current = sql`EXISTS (SELECT 1 FROM ${brainLinkJobs} WHERE ${brainLinkJobs.source} = ${brainMentions.source} AND ${brainLinkJobs.version} = ${brainMentions.version})`;

/**
 * Each of `entityIds`' kind, and the names other sources' current
 * mentions give it.
 */
const profilesOf = async (
  db: DrizzleD1Database,
  source: string,
  entityIds: readonly string[]
): Promise<Map<string, { kind: string; names: Set<string> }>> => {
  const profiles = new Map<string, { kind: string; names: Set<string> }>();
  if (entityIds.length === 0) {
    return profiles;
  }
  const [kinds, names] = await Promise.all([
    db
      .select({ id: brainEntities.id, kind: brainEntities.kind })
      .from(brainEntities)
      .where(inList(brainEntities.id, entityIds)),
    db
      .selectDistinct({
        entityId: brainMentions.entityId,
        alias: brainMentions.alias,
      })
      .from(brainMentions)
      .where(
        and(
          inList(brainMentions.entityId, entityIds),
          ne(brainMentions.source, source),
          current
        )
      ),
  ]);
  for (const { id, kind } of kinds) {
    profiles.set(id, { kind, names: new Set() });
  }
  for (const { entityId, alias } of names) {
    if (entityId !== null) {
      profiles.get(entityId)?.names.add(alias);
    }
  }
  return profiles;
};

/** The entity each of `hashes` is known by. */
const entitiesByKey = async (
  db: DrizzleD1Database,
  hashes: readonly string[]
): Promise<Map<string, string>> => {
  if (hashes.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      keyHash: brainEntityKeys.keyHash,
      entityId: brainEntityKeys.entityId,
    })
    .from(brainEntityKeys)
    .where(inList(brainEntityKeys.keyHash, hashes));
  return new Map(rows.map(({ keyHash, entityId }) => [keyHash, entityId]));
};

/**
 * The entities other sources of `partition` mention by each name in
 * `aliases`, by kind and name.
 */
const entitiesByName = async (
  db: DrizzleD1Database,
  source: string,
  partition: string,
  aliases: readonly string[]
): Promise<Map<string, Set<string>>> => {
  const named = new Map<string, Set<string>>();
  if (aliases.length === 0) {
    return named;
  }
  const rows = await db
    .selectDistinct({
      kind: brainMentions.kind,
      alias: brainMentions.alias,
      entityId: brainMentions.entityId,
    })
    .from(brainMentions)
    .where(
      and(
        eq(brainMentions.partition, partition),
        inList(brainMentions.alias, aliases),
        ne(brainMentions.source, source),
        sql`${brainMentions.entityId} IS NOT NULL`,
        current
      )
    );
  for (const { kind, alias, entityId } of rows) {
    if (entityId !== null) {
      const key = `${kind}\u0000${alias}`;
      named.set(key, (named.get(key) ?? new Set()).add(entityId));
    }
  }
  return named;
};

/** An entity a commit makes, with the keys it is known by. */
interface Creation {
  entityId: string;
  kind: string;
  keys: string[];
}

/**
 * Links each of `mentions` of `source`, in `partition`, to an entity on
 * exact evidence, creating the entities it needs, or leaves it ambiguous
 * with its candidates (see the top of this file).
 */
const resolve = async <C>(
  brain: Brain<C>,
  source: string,
  partition: string,
  mentions: readonly Mention[]
): Promise<{ resolved: Resolved[]; creating: Creation[] }> => {
  const { db } = brain;
  const evidence = await Promise.all(
    mentions.map(async (mention) => ({
      mention,
      idKeys: await Promise.all(
        mention.identifiers.map(
          // Within its partition, as names are: an identifier never tells
          // anyone what another partition holds.
          async (identifier) =>
            await keyOf(brain, ["id", partition, identifier])
        )
      ),
      nameKey: await keyOf(brain, [
        "name",
        partition,
        mention.kind,
        mention.alias,
      ]),
    }))
  );
  const known = await entitiesByKey(
    db,
    evidence.flatMap(({ idKeys, nameKey }) => [...idKeys, nameKey])
  );
  const named = await entitiesByName(
    db,
    source,
    partition,
    mentions.map(({ alias }) => alias)
  );
  const profiles = await profilesOf(db, source, [...new Set(known.values())]);
  const creating: Creation[] = [];
  const seen = (mention: Mention, entityId: string) => {
    named.set(
      nameOf(mention),
      (named.get(nameOf(mention)) ?? new Set()).add(entityId)
    );
  };
  const decide = (
    mention: Mention,
    candidates: ReadonlySet<string>,
    via: "identifier" | "alias",
    keys: string[]
  ): Resolved => {
    const [only, ...more] = candidates;
    if (only !== undefined && more.length === 0) {
      seen(mention, only);
      return {
        ...mention,
        entityId: only,
        state: "linked",
        resolution: via,
        candidates: [],
      };
    }
    if (only !== undefined) {
      return {
        ...mention,
        entityId: null,
        state: "ambiguous",
        resolution: "none",
        candidates: [...candidates].toSorted(),
      };
    }
    // A new ID, never one derived from its evidence: an entity erased with
    // its sources never comes back as itself.
    const entityId = `ent_${crypto.randomUUID()}`;
    creating.push({ entityId, kind: mention.kind, keys });
    seen(mention, entityId);
    return {
      ...mention,
      entityId,
      state: "linked",
      resolution: "new",
      candidates: [],
    };
  };
  const resolved = new Map<Mention, Resolved>();
  // Mentions with identifiers first: what they decide, the names that
  // follow in the same source see.
  for (const { mention, idKeys } of evidence) {
    if (idKeys.length > 0) {
      const found = new Set(
        idKeys.flatMap((key) => {
          const entityId = known.get(key);
          return entityId === undefined ? [] : [entityId];
        })
      );
      // A shared mailbox or customer number on two people: an entity of
      // another kind, or that other sources call by another name, is
      // proposed rather than guessed at.
      const refused = [...found].some((entityId) => {
        const profile = profiles.get(entityId);
        return (
          profile === undefined ||
          profile.kind !== mention.kind ||
          !namesAgree(mention.alias, profile.names)
        );
      });
      resolved.set(
        mention,
        refused
          ? {
              ...mention,
              entityId: null,
              state: "ambiguous",
              resolution: "none",
              candidates: [...found].toSorted(),
            }
          : decide(mention, found, "identifier", idKeys)
      );
    }
  }
  for (const { mention, idKeys, nameKey } of evidence) {
    if (idKeys.length === 0) {
      const found = new Set(named.get(nameOf(mention)));
      const byKey = known.get(nameKey);
      if (byKey !== undefined) {
        found.add(byKey);
      }
      resolved.set(mention, decide(mention, found, "alias", [nameKey]));
    }
  }
  return {
    resolved: mentions.flatMap((mention) => {
      const result = resolved.get(mention);
      return result === undefined ? [] : [result];
    }),
    creating,
  };
};

// Committing.

/**
 * Whether `version` of `source` may be committed now: its job still wants
 * it, and holds an older one.
 */
const guard = (source: string, version: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${brainLinkJobs} WHERE ${brainLinkJobs.source} = ${source} AND ${brainLinkJobs.version} = ${version} AND coalesce(${brainLinkJobs.linkedVersion}, 0) < ${version})`;

/**
 * Resolves `extracted` and commits it as `version` of `source`'s
 * mentions, in one guarded batch: the old ones deleted, the new ones
 * inserted (each taking its version from the guard, NULL when it fails,
 * which the column refuses, so the whole batch goes), the job marked
 * linked last. Resolves quietly when fenced out by a newer version.
 */
const commit = async <C>(
  brain: Brain<C>,
  source: string,
  version: number,
  { partition, partial, mentions, relations }: NonNullable<Extracted>
): Promise<void> => {
  const { db } = brain;
  const job = await jobOf(db, source);
  if (
    job === undefined ||
    job.version !== version ||
    (job.linkedVersion ?? 0) >= version
  ) {
    return;
  }
  // The entities its old mentions named: those no mention names after the
  // commit go with it.
  const before = await db
    .selectDistinct({ entityId: brainMentions.entityId })
    .from(brainMentions)
    .where(eq(brainMentions.source, source));
  const { resolved, creating } = await resolve(
    brain,
    source,
    partition,
    mentions
  );
  const named = [
    ...new Set([
      ...before.flatMap(({ entityId }) => entityId ?? []),
      ...resolved.flatMap(({ entityId }) => entityId ?? []),
    ]),
  ];
  const of = sourceOf(source);
  const rows = resolved.map((mention, position) => ({
    source,
    position,
    documentId: of.kind === "document" ? of.id : null,
    memoryId: of.kind === "memory" ? of.id : null,
    version: sql<number>`(SELECT ${version} WHERE ${guard(source, version)})`,
    partition,
    kind: mention.kind,
    name: mention.name,
    alias: mention.alias,
    entityId: mention.entityId,
    state: mention.state,
    resolution: mention.resolution,
    candidates: JSON.stringify(mention.candidates),
  }));
  const inserts: BatchItem<"sqlite">[] = [];
  for (let at = 0; at < rows.length; at += mentionsPerInsert) {
    inserts.push(
      db.insert(brainMentions).values(rows.slice(at, at + mentionsPerInsert))
    );
  }
  // Its relations, between entities it linked: superseding the version
  // before's, which stay as what was known until now (relations.ts).
  const recordedAt = brain.ports.clock();
  const linked = new Map(
    resolved.flatMap(({ alias, entityId, name }) =>
      entityId === null ? [] : [[alias, { entityId, name }] as const]
    )
  );
  const assertions = relations.flatMap((relation) => {
    const subject = linked.get(relation.subject);
    const object = linked.get(relation.object);
    return subject === undefined || object === undefined
      ? []
      : [
          {
            id: crypto.randomUUID(),
            source,
            documentId: of.kind === "document" ? of.id : null,
            memoryId: of.kind === "memory" ? of.id : null,
            version: sql<number>`(SELECT ${version} WHERE ${guard(source, version)})`,
            partition,
            subjectEntityId: subject.entityId,
            subjectName: subject.name,
            predicate: relation.predicate,
            objectEntityId: object.entityId,
            objectName: object.name,
            validFrom: relation.validFrom,
            validTo: relation.validTo,
            evidence: relation.evidence,
            state: "observed" as const,
            recordedAt,
            supersededAt: null,
          },
        ];
  });
  const assertionInserts: BatchItem<"sqlite">[] = [];
  for (let at = 0; at < assertions.length; at += assertionsPerInsert) {
    assertionInserts.push(
      db
        .insert(brainAssertions)
        .values(assertions.slice(at, at + assertionsPerInsert))
    );
  }
  // The new entities and their keys in the commit's own batch, so a
  // commit fenced out (a purge landed meanwhile) leaves none behind. A key
  // another run took first refuses the batch, and the retry links to its
  // entity.
  const createdAt = brain.ports.clock();
  const made = creating.flatMap(({ entityId, kind, keys }) => [
    db.insert(brainEntities).values({ id: entityId, kind, createdAt }),
    ...keys.map((keyHash) =>
      db.insert(brainEntityKeys).values({ keyHash, entityId })
    ),
  ]);
  let failure: Error | undefined;
  try {
    await db.batch([
      db
        .delete(brainMentions)
        .where(and(eq(brainMentions.source, source), guard(source, version))),
      ...made,
      ...inserts,
      db
        .update(brainAssertions)
        .set({ supersededAt: recordedAt })
        .where(
          and(
            eq(brainAssertions.source, source),
            sql`${brainAssertions.supersededAt} IS NULL`,
            guard(source, version)
          )
        ),
      ...assertionInserts,
      // Entities nothing names any more (another run's entity won a key
      // this one also made, say), with their keys.
      db
        .delete(brainEntities)
        .where(
          and(
            inList(brainEntities.id, named),
            sql`NOT EXISTS (SELECT 1 FROM ${brainMentions} WHERE ${brainMentions.entityId} = ${brainEntities.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${brainAssertions} WHERE ${brainAssertions.subjectEntityId} = ${brainEntities.id} OR ${brainAssertions.objectEntityId} = ${brainEntities.id})`,
            guard(source, version)
          )
        ),
      // Last: the guard above reads the version linked before it.
      db
        .update(brainLinkJobs)
        .set({
          linkedVersion: version,
          state: "linked",
          attempts: 0,
          failure: null,
          failedAt: null,
          partial,
        })
        .where(and(eq(brainLinkJobs.source, source), guard(source, version))),
    ]);
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("The commit batch failed", { cause: error });
  }
  if (failure === undefined) {
    return;
  }
  // A stale generation's batch fails on its guard: read why.
  const now = await jobOf(db, source);
  if (now?.version === version && (now.linkedVersion ?? 0) < version) {
    throw failure;
  }
};

// Running.

const linkInputSchema = z.object({
  source: z.string().regex(sourcePattern),
  version: z.int().min(1),
});

/** The code an error ends a step with: the Brain's own, or unexpected. */
const codeOfError = (error: unknown): string =>
  knowledgeErrors.codeOf(error) ??
  brainErrors.codeOf(error) ??
  "internal.unexpected";

/** The code an ended step carries, as the engine keeps its message. */
const codeOfMessage = (error: unknown): string => {
  const code =
    error instanceof Error ? error.message.split(": ").at(-1) : undefined;
  return code !== undefined &&
    (knowledgeErrors.codeOf({ code }) !== undefined ||
      brainErrors.codeOf({ code }) !== undefined)
    ? code
    : "internal.unexpected";
};

/** What linking a version that is still current sets, by `where`. */
const whileCurrent = (source: string, version: number): SQL | undefined =>
  and(
    eq(brainLinkJobs.source, source),
    eq(brainLinkJobs.version, version),
    ne(brainLinkJobs.state, "linked")
  );

/**
 * Runs (or resumes) the linking of one source version, in one step:
 * extract its mentions through the host, then resolve and commit them.
 * One step, so the names it read are never kept in the engine's journal,
 * out of a purge's reach; a retry asks the extractor again. Each failed
 * attempt marks the job `retrying`; once the retries are spent it is
 * `failed`, with the code of why, for the sweep to run again.
 */
export const runLinking = async <C>(
  brain: Brain<C>,
  payload: unknown,
  step: IndexStep
): Promise<void> => {
  const job = linkInputSchema.parse(payload);
  try {
    await step.do("link", linkConfig, async () => {
      try {
        const extracted = await extract(brain, job.source, job.version);
        if (extracted !== null) {
          await commit(brain, job.source, job.version, extracted);
        }
      } catch (error) {
        const code = codeOfError(error);
        await brain.db
          .update(brainLinkJobs)
          .set({
            state: "retrying",
            attempts: sql`${brainLinkJobs.attempts} + 1`,
            failure: code,
          })
          .where(whileCurrent(job.source, job.version));
        // Only its code reaches the engine, never its message.
        throw new Error(code, { cause: error });
      }
      return null;
    });
  } catch (error) {
    const code = codeOfMessage(error);
    await step.do("fail", {}, async () => {
      await brain.db
        .update(brainLinkJobs)
        .set({
          state: "failed",
          failure: code,
          failedAt: brain.ports.clock(),
        })
        .where(whileCurrent(job.source, job.version));
      return null;
    });
  }
};

/** How long a job stays failed before run `run` is started. */
const rerunAfterMs = (run: number): number =>
  Math.min(15 * 60_000 * 2 ** run, 24 * 60 * 60_000);

/**
 * What a failure is logged with: its name only, never a message that may
 * repeat a text.
 */
const failureFields = (error: unknown) => ({
  errorName: error instanceof Error ? error.name : typeof error,
});

/**
 * Gives up on `source`, failed for good at run {@link maxLinkReruns}:
 * once, audited as `knowledge.links_exhausted`. Its next change queues it
 * again.
 */
const exhaust = async <C>(
  brain: Brain<C>,
  source: string,
  version: number
): Promise<void> => {
  const { db } = brain;
  const of = sourceOf(source);
  await auditedBatch(brain.ports, db, [
    db
      .update(brainLinkJobs)
      .set({ run: maxLinkReruns + 1 })
      .where(
        and(
          eq(brainLinkJobs.source, source),
          eq(brainLinkJobs.version, version),
          eq(brainLinkJobs.state, "failed"),
          eq(brainLinkJobs.run, maxLinkReruns)
        )
      ),
    outboxedIfChanged(brain, {
      actor: { type: "system" },
      action: "knowledge.links_exhausted",
      target: { type: of.kind, id: of.id },
      detail: { version, runs: maxLinkReruns + 1 },
    }),
  ]);
};

/** Starts the next run of failed jobs whose backoff has passed. */
const rerunFailed = async <C>(brain: Brain<C>, now: Date): Promise<void> => {
  const { db } = brain;
  const failed = await db
    .select({
      source: brainLinkJobs.source,
      version: brainLinkJobs.version,
      run: brainLinkJobs.run,
      failedAt: brainLinkJobs.failedAt,
    })
    .from(brainLinkJobs)
    .where(
      and(
        eq(brainLinkJobs.state, "failed"),
        lte(brainLinkJobs.run, maxLinkReruns)
      )
    )
    .orderBy(sql`random()`)
    .limit(sweepBatch);
  for (const { source, version, run, failedAt } of failed) {
    try {
      if (run >= maxLinkReruns) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await exhaust(brain, source, version);
        continue;
      }
      if (
        failedAt !== null &&
        now.getTime() - failedAt.getTime() < rerunAfterMs(run)
      ) {
        continue;
      }
      // The row first, under the run it was failed by: one sweep starts it.
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const [taken] = await db
        .update(brainLinkJobs)
        .set({ state: "retrying", run: run + 1 })
        .where(
          and(
            eq(brainLinkJobs.source, source),
            eq(brainLinkJobs.version, version),
            eq(brainLinkJobs.state, "failed"),
            eq(brainLinkJobs.run, run)
          )
        )
        .returning({ source: brainLinkJobs.source });
      if (taken !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await brain.ports.jobs.start(linkRunId(source, version, run + 1), {
          source,
          version,
        });
      }
    } catch (error) {
      log.warn("knowledge.link_sweep_failed", failureFields(error));
    }
  }
};

/**
 * Every minute (the host's clock): starts the run of each source settled
 * for {@link settleMs} whose run hasn't started, fails each whose run
 * ended without linking it, and runs failed ones again (`rerunFailed`).
 */
export const sweepLinking = async <C>(
  brain: Brain<C>,
  now: Date
): Promise<void> => {
  const { db } = brain;
  const settled = await db
    .select({
      source: brainLinkJobs.source,
      version: brainLinkJobs.version,
      run: brainLinkJobs.run,
    })
    .from(brainLinkJobs)
    .where(
      and(
        inArray(brainLinkJobs.state, ["queued", "retrying"]),
        lt(brainLinkJobs.updatedAt, new Date(now.getTime() - settleMs))
      )
    )
    .orderBy(sql`random()`)
    .limit(sweepBatch);
  const { jobs } = brain.ports;
  for (const { source, version, run } of settled) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const status = await jobs.status(linkRunId(source, version, run));
      if (status === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await jobs.start(linkRunId(source, version, run), { source, version });
      } else if (status === "ended") {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await db
          .update(brainLinkJobs)
          .set({
            state: "failed",
            failure: "internal.unexpected",
            failedAt: now,
          })
          .where(
            and(whileCurrent(source, version), eq(brainLinkJobs.run, run))
          );
      }
    } catch (error) {
      log.warn("knowledge.link_sweep_failed", failureFields(error));
    }
  }
  await rerunFailed(brain, now);
};

// Reading.

/** A mention a reader may read, with where it is from. */
interface ReadableMention {
  source: string;
  documentId: string | null;
  collectionId: string | null;
  memoryId: string | null;
  version: number;
  kind: string;
  name: string;
  entityId: string | null;
  state: "linked" | "ambiguous";
  candidates: string;
}

/**
 * The mentions `reader` may read, `where` holds of, newest sources first,
 * at most `readRowsMax`: of documents they may read in collections that
 * aren't sensitive (as search's counts, a sensitive collection is never
 * among what an unscoped read sums up), and of their own memories. What
 * they may not read never reaches the query's result, so it shapes no
 * count, label or suggestion.
 */
const readableMentions = async <C>(
  brain: Brain<C>,
  reader: C,
  where?: SQL
): Promise<ReadableMention[]> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  let owner: string | undefined;
  try {
    owner = brain.ports.ownerOf(reader);
  } catch (error) {
    if (brainErrors.codeOf(error) !== "brain.denied") {
      throw error;
    }
  }
  const columns = {
    source: brainMentions.source,
    documentId: brainMentions.documentId,
    memoryId: brainMentions.memoryId,
    version: brainMentions.version,
    kind: brainMentions.kind,
    name: brainMentions.name,
    entityId: brainMentions.entityId,
    state: brainMentions.state,
    candidates: brainMentions.candidates,
  };
  const [fromDocuments, fromMemories] = await Promise.all([
    db
      .select({ ...columns, collectionId: collections.id })
      .from(brainMentions)
      .innerJoin(documents, eq(documents.id, brainMentions.documentId))
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(
        and(
          allowed.documents(),
          eq(collections.sensitive, false),
          current,
          where
        )
      )
      .orderBy(sql`${brainMentions}.rowid DESC`)
      .limit(readRowsMax),
    owner === undefined
      ? []
      : db
          .select(columns)
          .from(brainMentions)
          .innerJoin(
            brainMemories,
            eq(brainMemories.id, brainMentions.memoryId)
          )
          .where(and(eq(brainMemories.ownerId, owner), current, where))
          .orderBy(sql`${brainMentions}.rowid DESC`)
          .limit(readRowsMax),
  ]);
  return [
    ...fromDocuments,
    ...fromMemories.map((row) => ({ ...row, collectionId: null })),
  ].slice(0, readRowsMax);
};

/** Tells the host what a read of mentions returned (its `onRead` port). */
const noteRead = async <C>(
  brain: Brain<C>,
  reader: C,
  read: string,
  rows: readonly ReadableMention[]
): Promise<void> => {
  const collectionIds = [
    ...new Set(rows.flatMap(({ collectionId }) => collectionId ?? [])),
  ];
  await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: [
        ...new Set(rows.flatMap(({ documentId }) => documentId ?? [])),
      ].slice(0, 20),
      detail: { read, mentions: rows.length },
    },
    ...collectionIds.map((id) => ({ id, sensitive: false }))
  );
};

/** An entity as a reader sees it, from what they may read only. */
export interface EntitySummary {
  id: string;
  kind: string;
  /** The name its readable mentions give it most. */
  label: string;
  /** Every name its readable mentions give it. */
  names: string[];
  /** How many readable sources mention it. */
  sources: number;
}

const entitiesInputSchema = z.strictObject({
  /** The start of a name: suggestions as someone types. */
  query: z.string().min(1).max(nameMaxLength).optional(),
  limit: z.int().min(1).max(100).optional(),
});

/**
 * The entities `reader`'s readable sources mention, most mentioned first,
 * or those with a name starting with `query`: their counts, labels and
 * names from those sources only.
 */
export const entitiesFor = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown = {}
): Promise<EntitySummary[]> => {
  const { query, limit = 20 } = brainErrors.parse(
    "brain.invalid",
    entitiesInputSchema,
    input
  );
  const folded = query === undefined ? undefined : fold(query);
  const rows = await readableMentions(
    brain,
    reader,
    and(
      eq(brainMentions.state, "linked"),
      folded === undefined
        ? undefined
        : sql`substr(${brainMentions.alias}, 1, ${folded.length}) = ${folded}`
    )
  );
  const byEntity = new Map<
    string,
    { kind: string; names: Map<string, number>; sources: Set<string> }
  >();
  for (const { entityId, kind, name, source } of rows) {
    if (entityId !== null) {
      const entry = byEntity.get(entityId) ?? {
        kind,
        names: new Map(),
        sources: new Set(),
      };
      entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
      entry.sources.add(source);
      byEntity.set(entityId, entry);
    }
  }
  const found = [...byEntity].map(([id, { kind, names, sources }]) => {
    const ranked = [...names].toSorted(
      ([a, an], [b, bn]) => bn - an || a.localeCompare(b)
    );
    return {
      id,
      kind,
      label: ranked[0]?.[0] ?? "",
      names: ranked.map(([name]) => name),
      sources: sources.size,
    };
  });
  const page = found
    .toSorted((a, b) => b.sources - a.sources || a.label.localeCompare(b.label))
    .slice(0, limit);
  await noteRead(
    brain,
    reader,
    "entities",
    rows.filter(({ entityId }) => page.some(({ id }) => id === entityId))
  );
  return page;
};

/** A row as the source reference the contract has. */
const refOf = (row: ReadableMention): BrainSourceRef =>
  row.memoryId === null
    ? {
        kind: "document",
        documentId: documentIdSchema.parse(row.documentId),
        collectionId: collectionIdSchema.parse(row.collectionId),
        version: row.version,
      }
    : {
        kind: "memory",
        memoryId: memoryIdSchema.parse(row.memoryId),
        revision: row.version,
      };

/** The sources `reader` may read that mention `entityId`. */
export const entitySources = async <C>(
  brain: Brain<C>,
  reader: C,
  entityId: string
): Promise<BrainSourceRef[]> => {
  const rows = await readableMentions(
    brain,
    reader,
    eq(brainMentions.entityId, entityId)
  );
  const unique = [...new Map(rows.map((row) => [row.source, row])).values()];
  await noteRead(brain, reader, "entity_sources", unique);
  return unique.map(refOf);
};

/** An ambiguous mention: who it may be, never linked until decided. */
export interface LinkProposal {
  sourceRef: BrainSourceRef;
  kind: string;
  name: string;
  /** The entities it may be, of those `reader` sees. */
  candidates: string[];
}

/**
 * The ambiguous mentions in `reader`'s readable sources, with the
 * candidates they may see: an entity only hidden sources mention is never
 * named.
 */
export const linkProposals = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<LinkProposal[]> => {
  const rows = await readableMentions(brain, reader);
  const visible = new Set(rows.flatMap(({ entityId }) => entityId ?? []));
  const ambiguous = rows.filter(({ state }) => state === "ambiguous");
  await noteRead(brain, reader, "link_proposals", ambiguous);
  return ambiguous.map((row) => ({
    sourceRef: refOf(row),
    kind: row.kind,
    name: row.name,
    candidates: z
      .array(z.string())
      .parse(JSON.parse(row.candidates))
      .filter((id) => visible.has(id)),
  }));
};

/** One entity of a match proposal, as the reader sees it. */
export interface MatchedEntity {
  id: string;
  /** The readable collections whose current sources mention it. */
  collectionIds: string[];
  /** How many of the reader's readable sources mention it. */
  sources: number;
}

/**
 * Entities of different collections that may be one (GRA-1080): of one
 * kind, known by one name. A proposal only, never a link: on a name alone
 * (`basis`), nothing says they are, least of all of two people.
 */
export interface EntityMatchProposal {
  kind: string;
  name: string;
  basis: "name";
  entities: MatchedEntity[];
}

const matchProposalsInputSchema = z.strictObject({
  limit: z.int().min(1).max(100).optional(),
});

/**
 * Entities that may be the same across the collections `reader` may read
 * (GRA-1080): each of one kind and one name, in sources of more than one
 * collection, which linking keeps apart (identity stays inside a
 * collection). Worked out from what the reader may read now, and nothing
 * else: a proposal is never kept, so it exists only for a reader of every
 * side of it, and an entity of a collection they can't read is never one
 * of its sides, nor shapes how many there are (the probe #1203 closed).
 * Exact names only, never similar ones.
 */
export const entityMatchProposals = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown = {}
): Promise<EntityMatchProposal[]> => {
  const { limit = 20 } = brainErrors.parse(
    "brain.invalid",
    matchProposalsInputSchema,
    input
  );
  // As a recall: an App, run or agent only under its Brain grant.
  await brain.ports.recall.require(reader);
  const linked = await readableMentions(
    brain,
    reader,
    eq(brainMentions.state, "linked")
  );
  const rows = linked.filter(({ collectionId }) => collectionId !== null);
  const byEntity = new Map<
    string,
    {
      kind: string;
      names: Map<string, string>;
      collections: Set<string>;
      sources: Set<string>;
    }
  >();
  for (const { entityId, kind, name, collectionId, source } of rows) {
    if (entityId !== null && collectionId !== null) {
      const entry = byEntity.get(entityId) ?? {
        kind,
        names: new Map(),
        collections: new Set(),
        sources: new Set(),
      };
      entry.names.set(fold(name), entry.names.get(fold(name)) ?? name);
      entry.collections.add(collectionId);
      entry.sources.add(source);
      byEntity.set(entityId, entry);
    }
  }
  // Each kind and name, with the entities known by it.
  const byName = new Map<
    string,
    { kind: string; name: string; ids: Set<string> }
  >();
  for (const [id, { kind, names }] of byEntity) {
    for (const [folded, name] of names) {
      const key = `${kind}\u0000${folded}`;
      const entry = byName.get(key) ?? { kind, name, ids: new Set() };
      entry.ids.add(id);
      byName.set(key, entry);
    }
  }
  const proposals = new Map<string, EntityMatchProposal>();
  for (const { kind, name, ids } of byName.values()) {
    const entities = [...ids].toSorted().map((id) => {
      const entry = byEntity.get(id);
      return {
        id,
        collectionIds: [...(entry?.collections ?? [])].toSorted(),
        sources: entry?.sources.size ?? 0,
      };
    });
    const collectionCount = new Set(
      entities.flatMap(({ collectionIds }) => collectionIds)
    ).size;
    const key = entities.map(({ id }) => id).join(",");
    if (entities.length > 1 && collectionCount > 1 && !proposals.has(key)) {
      proposals.set(key, { kind, name, basis: "name", entities });
    }
  }
  const page = [...proposals.values()]
    .toSorted(
      (a, b) =>
        b.entities.length - a.entities.length ||
        a.name.localeCompare(b.name) ||
        a.kind.localeCompare(b.kind)
    )
    .slice(0, limit);
  const shown = new Set(
    page.flatMap(({ entities }) => entities.map(({ id }) => id))
  );
  await noteRead(
    brain,
    reader,
    "entity_match_proposals",
    rows.filter(({ entityId }) => entityId !== null && shown.has(entityId))
  );
  return page;
};

/** How far linking is over what a reader may read. */
export interface LinkCoverage {
  sources: number;
  /** Whose current version is linked. */
  linked: number;
  /** Waiting for their run, or retrying. */
  pending: number;
  /** Failed, waiting for the sweep's next run or given up on. */
  failed: number;
  /** Linked from part of their text only. */
  partial: number;
}

/**
 * Linking's progress over `reader`'s readable sources, as search's
 * coverage is over theirs: what the backfill of a change and the repair
 * of failed jobs have left to do.
 */
export const linkCoverage = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<LinkCoverage> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  let owner: string | undefined;
  try {
    owner = brain.ports.ownerOf(reader);
  } catch (error) {
    if (brainErrors.codeOf(error) !== "brain.denied") {
      throw error;
    }
  }
  const columns = {
    state: brainLinkJobs.state,
    partial: sql<number>`sum(${brainLinkJobs.partial})`,
    count: sql<number>`count(*)`,
  };
  const [fromDocuments, fromMemories] = await Promise.all([
    db
      .select(columns)
      .from(brainLinkJobs)
      .innerJoin(documents, eq(documents.id, brainLinkJobs.documentId))
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(and(allowed.documents(), eq(collections.sensitive, false)))
      .groupBy(brainLinkJobs.state),
    owner === undefined
      ? []
      : db
          .select(columns)
          .from(brainLinkJobs)
          .innerJoin(
            brainMemories,
            eq(brainMemories.id, brainLinkJobs.memoryId)
          )
          .where(eq(brainMemories.ownerId, owner))
          .groupBy(brainLinkJobs.state),
  ]);
  const coverage = { sources: 0, linked: 0, pending: 0, failed: 0, partial: 0 };
  for (const { state, count, partial } of [...fromDocuments, ...fromMemories]) {
    coverage.sources += count;
    coverage.partial += partial;
    if (state === "linked") {
      coverage.linked += count;
    } else if (state === "failed") {
      coverage.failed += count;
    } else {
      coverage.pending += count;
    }
  }
  return coverage;
};
