import { log } from "@grasp-os/shared/log";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { markJudged } from "./catch-up.ts";
import { attributeRuleOf, changeReused, restoringNow } from "./contract.ts";
import type {
  AddedMemories,
  AttributeRule,
  NewMemory,
  newMemoriesSchema,
  Speaker,
} from "./contract.ts";
import {
  foldIdentifier,
  foldName,
  keepNames,
  linkedBy,
  mayName,
} from "./entities.ts";
import { subjectOf, writerSubjectOf } from "./erasure.ts";
import { fileKeyOf, hashOf } from "./files.ts";
import { linkedByName } from "./linking.ts";
import {
  entityRowOf,
  lineageOfSource,
  lineageOfWriter,
  stampWrite,
} from "./memories.ts";
import { isOwnEntityRow, ownEntityRow } from "./own-entity.ts";
import {
  isErasedPerson,
  leavingOutCards,
  namingOf,
  strippedOf,
} from "./people.ts";
import type { Naming } from "./people.ts";
import { CurrentTextsNeededError, heldIn, judgeLate } from "./quotes.ts";
import type { CurrentText, CurrentTexts, Written } from "./quotes.ts";
import { accessOfKey, readerSetKeyOf, readerSetOf } from "./reader-sets.ts";
import { isRestoring } from "./restoring.ts";
import { foldForSearch, indexMemoryWords } from "./words.ts";
import type { WordMemo } from "./words.ts";

// Adding memories (contract.ts `addMemories`): checked whole first, then
// written in one transaction with the entities they name, so an add is
// all or nothing, and two adds racing each other are one after the
// other: within a lineage the order of its memories decides which is
// current (memories.ts), never which add came first, so two writers never
// both win or both lose. The same change again answers what it added,
// whatever was added since; with other memories, it is refused. A memory
// resting on a version before its source's current one is judged against
// the current version's text in the add's transaction (quotes.ts).

/** An add as its schema reads it. */
export type Adding = z.output<typeof newMemoriesSchema>;

/** A memory of an add, with where its entities are in the add and its attribute's rule. */
interface Planned {
  about: number;
  object: number | undefined;
  rule: AttributeRule | undefined;
}

/** What an add answered, as kept with its change. */
export const answerSchema = z.strictObject({
  memories: z.array(z.string()),
  entities: z.record(z.string(), z.string()),
});

/** A refusal of an add: what rule it broke, never a value. */
const refused = (why: string): Error =>
  new Error(`The Brain refused it: ${why}`);

/**
 * Each memory of `adding` with its entities and its attribute's rule, or
 * a refusal: every entity key once, every one a memory names given and
 * every one given named; an attribute its entity's kind lists; a relation
 * with an entity of a kind it relates to and no value; any other
 * attribute with a value and no entity it relates to.
 */
export const planOf = ({ entities, memories }: Adding): Planned[] => {
  const byKey = new Map(entities.map(({ key }, index) => [key, index]));
  if (byKey.size !== entities.length) {
    throw refused("two entities have the same key");
  }
  const mentioned = new Set<number>();
  const planned = memories.map((memory, index) => {
    const about = byKey.get(memory.about);
    const object =
      memory.object === undefined ? undefined : byKey.get(memory.object);
    if (
      about === undefined ||
      (memory.object !== undefined && object === undefined)
    ) {
      throw refused(`memory ${index} names an entity the add doesn't give`);
    }
    mentioned.add(about);
    if (object !== undefined) {
      mentioned.add(object);
    }
    if (memory.attribute === undefined) {
      return { about, object, rule: undefined };
    }
    const kind = entities[about]?.kind;
    const rule =
      kind === undefined ? undefined : attributeRuleOf(kind, memory.attribute);
    if (rule === undefined) {
      throw refused(
        `memory ${index} has an attribute its entity's kind hasn't`
      );
    }
    if (rule.relation === undefined) {
      if (memory.value === undefined || object !== undefined) {
        throw refused(
          `memory ${index} needs a value and no related entity for its attribute`
        );
      }
    } else {
      const related = object === undefined ? undefined : entities[object];
      if (
        related === undefined ||
        memory.value !== undefined ||
        !rule.relation.includes(related.kind)
      ) {
        throw refused(
          `memory ${index} needs a related entity of a kind its attribute relates to, and no value`
        );
      }
    }
    return { about, object, rule };
  });
  if (mentioned.size !== entities.length) {
    throw refused("an entity no memory mentions");
  }
  return planned;
};

/** The store's parts an add needs. */
export interface RememberStore {
  storage: DurableObjectStorage;
  db: DrizzleSqliteDODatabase;
  /** Where versions' files are: the current text a late memory is judged against. */
  bucket: BrainBucket;
  /** Whether it is the shared store, which keeps nothing one person alone may read. */
  shared: boolean;
}

const encoder = new TextEncoder();

/**
 * The entities of an add as rows: the store's own entity for one named
 * `own` (own-entity.ts, made by the first; refused in the shared store),
 * each known `id` (of its kind), else
 * the first holding one of its identifiers, or another entity of the add
 * with one of them, else, given no identifier, the one entity of its kind
 * holding one of its names by memories of exactly the add's readers
 * (linking.ts `linkedByName`), else a new one.
 */
const entityRowsOf = (
  sql: SqlStorage,
  { entities, reader }: Adding,
  readers: string,
  shared: boolean,
  /** Which entities the add gave identifiers, before any was left out (`writeAdd`): only the others link by name. */
  identified: readonly boolean[]
): number[] => {
  const linked = new Map<string, number>();
  return entities.map((entity, index) => {
    const keys = entity.identifiers.map((id) =>
      JSON.stringify([entity.kind, id.type, foldIdentifier(id)])
    );
    let row: number | undefined;
    if (entity.own === true) {
      // Its person, in their own store alone: never one a name or an
      // identifier finds, and never in the shared store.
      if (shared) {
        throw refused(
          `entity ${index} names a person's own, which only their own store holds`
        );
      }
      row = ownEntityRow(sql);
    } else if (entity.id === undefined) {
      row =
        keys
          .map((key) => linked.get(key))
          .find((found) => found !== undefined) ??
        linkedBy(sql, entity.kind, entity.identifiers, readers) ??
        (identified[index] === true
          ? undefined
          : linkedByName(sql, entity.kind, entity.names, readers));
    } else {
      const known = entityRowOf(sql, entity.id);
      // An id the add may not name is refused in the words of an unknown
      // one: whether it exists is no answer of the store's.
      if (
        known === undefined ||
        known.kind !== entity.kind ||
        !mayName(sql, known.row, readers, reader)
      ) {
        throw refused(`entity ${index} names no entity of its kind`);
      }
      // The store's own entity, named by its id, takes no name or
      // identifier either: no evidence may ever find it (own-entity.ts).
      if (
        isOwnEntityRow(sql, known.row) &&
        (entity.names.length > 0 || entity.identifiers.length > 0)
      ) {
        throw refused(
          `entity ${index}: the own entity is a person named by nothing else`
        );
      }
      ({ row } = known);
    }
    row ??= sql
      .exec<{ row: number }>(
        "INSERT INTO entities (id, kind) VALUES (?, ?) RETURNING row",
        crypto.randomUUID(),
        entity.kind
      )
      .one().row;
    for (const key of keys) {
      if (!linked.has(key)) {
        linked.set(key, row);
      }
    }
    return row;
  });
};

/**
 * Whether this store holds the version, no erasure hides it and its source
 * wasn't removed (removal.ts: nothing new is drawn from it), a refusal
 * (`why`) if not, alike; in the shared store, a refusal too when one
 * person alone may read it: what is drawn from it is theirs alone, and
 * lies only in their own store.
 */
const holdVersion = (
  { sql, shared }: { sql: SqlStorage; shared: boolean },
  source: string,
  version: number,
  why: string
): void => {
  const [found] = sql
    .exec<{ readers: string }>(
      `SELECT reader_sets.key AS readers
      FROM source_versions
      JOIN reader_sets ON reader_sets.id = source_versions.reader_set
      WHERE source = ?1 AND version = ?2
        AND row NOT IN (SELECT version_row FROM erasing_versions)
        AND NOT EXISTS (SELECT 1 FROM removed_sources WHERE source = ?1)`,
      source,
      version
    )
    .toArray();
  if (found === undefined) {
    throw refused(why);
  }
  if (!shared) {
    return;
  }
  // Closed for a key the store can't read: it may be one person's.
  const access = accessOfKey(found.readers);
  if (access === undefined) {
    throw refused("who may read what it is drawn from can't be read");
  }
  if (access.kind === "owner") {
    throw refused(
      "what one person alone may read is kept in that person's own store"
    );
  }
};

/** Where an add writes its memories: its entities' rows and ids, and what every memory shares. */
interface Into {
  sql: SqlStorage;
  entities: Adding["entities"];
  rows: readonly number[];
  ids: readonly string[];
  /** The add's readers, by their set's key (`reader_sets.key`). */
  readers: string;
  /** Whether the add is to the shared store. */
  shared: boolean;
  /** Each source the add names, by its SHA-256 as the erasure ledger names it. */
  subjects: ReadonlyMap<string, string>;
  /** Each writer the add names, by the SHA-256 of its lineage, as the ledger names it. */
  writers: ReadonlyMap<string, string>;
  /** Each memory's restatement key, by its place in the add (`restatementOf`). */
  restatements: readonly string[];
  learnedAt: number;
  memo: WordMemo;
}

/** Spacing, as a statement is compared: any run of it is one space. */
const spacing = /\s+/gu;

/** A statement's end as a sentence ends it, which saying it again may drop or add. */
const sentenceEnd = /[.!]+$/u;

/**
 * A statement as a restatement compares it: folded as search folds text
 * (words.ts `foldForSearch`: case, accents and Unicode's forms), its
 * spacing one space, and a final `.` or `!` taken off. Every other sign
 * stays, so "-5%" and "5%", "$5M" and "€5M", "> 100" and "< 100",
 * "1,500" and "1.500", "C++" and "C#" are never the same fact.
 */
const statementKeyOf = (statement: string): string =>
  foldForSearch(statement)
    .replaceAll(spacing, " ")
    .trim()
    .replace(sentenceEnd, "");

/** Whose word a memory is, as a restatement compares it: its kind, and the person or agent. */
const speakerKeyOf = (speaker: Speaker): [string, string | null] => {
  if (speaker.kind === "internal") {
    return [speaker.kind, speaker.person];
  }
  if (speaker.kind === "agent") {
    return [speaker.kind, speaker.agent];
  }
  return [speaker.kind, null];
};

/**
 * What a memory filed under no attribute is a restatement of another by:
 * the SHA-256 of its type, whose word it is, its value folded and its
 * statement as a restatement compares it (`statementKeyOf`), so the index
 * holds a fixed length whatever the statement's. Hashed before a
 * transaction.
 */
export const restatementOf = async ({
  type,
  speaker,
  value,
  statement,
}: {
  type: string;
  speaker: Speaker;
  value: string | null;
  statement: string;
}): Promise<string> =>
  await hashOf(
    encoder.encode(
      JSON.stringify([
        type,
        speakerKeyOf(speaker),
        foldName(value ?? ""),
        statementKeyOf(statement),
      ])
    )
  );

/**
 * What a newer memory of its lineage must match to end it (memories.ts
 * `newerSql`), under its attribute's `rule`. One-value attributes, and
 * many-value ones per value, compare its `value` folded, or the id of the
 * entity a relation relates to (`object`). A memory filed under no
 * attribute is a restatement of another when it says the same of the
 * same related entity, in the same speaker's word (`restatementOf`, then
 * the entity's id): so the
 * same fact said again by its source or its writer ends what it said
 * before, kept as history, and anything worded otherwise never does. For
 * an add and a restore (restore.ts) alike.
 */
export const valueKeyFor = (
  rule: AttributeRule | undefined,
  {
    value,
    object,
    restatement,
  }: { value: string | null; object: string | null; restatement: string }
): string | null => {
  if (rule === undefined) {
    return `${restatement}:${object ?? ""}`;
  }
  return rule.relation === undefined ? foldName(value ?? "") : object;
};

/** What a newer memory of its lineage must match to end `memory` (`valueKeyFor`). */
const valueKeyOf = (
  { ids, restatements }: Into,
  memory: NewMemory,
  plan: Planned,
  index: number
): string | null =>
  valueKeyFor(plan.rule, {
    value: memory.value ?? null,
    object: plan.object === undefined ? null : (ids[plan.object] ?? null),
    restatement: restatements[index] ?? "",
  });

/** The SHA-256 of `source`, which the add hashed before its transaction. */
const subjectOfSource = (
  subjects: ReadonlyMap<string, string>,
  source: string
): string => {
  const subject = subjects.get(source);
  if (subject === undefined) {
    throw new Error("The Brain did not hash a source it adds");
  }
  return subject;
};

/** The SHA-256 of `writer`'s lineage, which the add hashed before its transaction. */
const subjectOfWriter = (
  writers: ReadonlyMap<string, string>,
  writer: string
): string => {
  const subject = writers.get(writer);
  if (subject === undefined) {
    throw new Error("The Brain did not hash a writer it adds");
  }
  return subject;
};

/** Where a memory's basis puts it: its version, writer, lineage and place in that lineage. */
const basisOf = (
  into: Into,
  basis: NewMemory["basis"],
  index: number
): {
  source: string | null;
  version: number | null;
  subject: string | null;
  writer: string | null;
  writerSubject: string | null;
  lineage: string;
  order: number;
} => {
  if (basis.kind === "writer") {
    return {
      source: null,
      version: null,
      subject: null,
      writer: basis.writer,
      writerSubject: subjectOfWriter(into.writers, basis.writer),
      lineage: lineageOfWriter(basis.writer),
      order: 0,
    };
  }
  holdVersion(
    into,
    basis.source,
    basis.version,
    `memory ${index} rests on a version this store doesn't hold`
  );
  return {
    source: basis.source,
    version: basis.version,
    subject: subjectOfSource(into.subjects, basis.source),
    writer: null,
    writerSubject: null,
    lineage: lineageOfSource(basis.source),
    order: basis.version,
  };
};

/** The names and identifiers of the entities a memory mentions, kept as it gave them. */
const keepMentions = (into: Into, plan: Planned, row: number): void => {
  for (const at of plan.object === undefined
    ? [plan.about]
    : [plan.about, plan.object]) {
    const entity = into.entities[at];
    const entityRow = into.rows[at];
    if (entity !== undefined && entityRow !== undefined) {
      keepNames(into.sql, entityRow, row, entity.names, entity.identifiers);
    }
  }
};

/**
 * Writes `memory`, the add's `index`th, with its words and stems and the
 * names and identifiers of the entities it mentions, as it gave them.
 * Answers its id, and its row with what it rests on.
 */
const writeMemory = (
  into: Into,
  memory: NewMemory,
  plan: Planned | undefined,
  index: number
): { id: string; written: Written } => {
  const { sql, rows } = into;
  const aboutRow = plan === undefined ? undefined : rows[plan.about];
  if (plan === undefined || aboutRow === undefined) {
    throw refused(`memory ${index} names an entity the add doesn't give`);
  }
  const based = basisOf(into, memory.basis, index);
  const id = crypto.randomUUID();
  const { row } = sql
    .exec<{ row: number }>(
      `INSERT INTO memories (id, entity, attribute, object, value, value_key,
        one_value, type, statement, quote, source, version, subject, writer,
        writer_subject, lineage, lineage_order, speaker, valid_from,
        valid_until, learned_at, readers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING row`,
      id,
      aboutRow,
      memory.attribute ?? null,
      plan.object === undefined ? null : (rows[plan.object] ?? null),
      memory.value ?? null,
      valueKeyOf(into, memory, plan, index),
      plan.rule?.values === "one" ? 1 : 0,
      memory.type,
      memory.statement,
      memory.basis.quote ?? null,
      based.source,
      based.version,
      based.subject,
      based.writer,
      based.writerSubject,
      based.lineage,
      based.order,
      JSON.stringify(memory.speaker),
      memory.validFrom?.getTime() ?? null,
      memory.validUntil?.getTime() ?? null,
      into.learnedAt,
      into.readers
    )
    .one();
  indexMemoryWords(sql, row, memory.statement, into.memo);
  keepMentions(into, plan, row);
  return {
    id,
    written: {
      row,
      source: based.source,
      version: based.version,
      quote: memory.basis.quote ?? null,
    },
  };
};

/**
 * Marks version `version` of `source` fully extracted by the add `into`
 * writes (contract.ts `extracted`): every memory of an earlier version of
 * it ends then, for readers of the add and of that version (memories.ts).
 * Once per version and set of readers: a repeat changes nothing.
 */
const markExtracted = (
  sql: SqlStorage,
  { source, version }: { source: string; version: number },
  into: Into
): void => {
  const { learnedAt, readers, subjects } = into;
  holdVersion(
    into,
    source,
    version,
    "it marks extracted a version this store doesn't hold"
  );
  sql.exec(
    `INSERT OR IGNORE INTO memory_extractions
      (source, version, subject, lineage, at, readers)
    VALUES (?, ?, ?, ?, ?, ?)`,
    source,
    version,
    subjectOfSource(subjects, source),
    lineageOfSource(source),
    learnedAt,
    readers
  );
};

/** What an add hashes before its transaction (`hashesOf`), for its write (`writeAdd`). */
export interface AddHashes {
  key: string;
  hash: string;
  subjects: ReadonlyMap<string, string>;
  writers: ReadonlyMap<string, string>;
  /** Each memory's restatement key (`restatementOf`), in the add's order. */
  restatements: readonly string[];
  /** What its entities and speakers name, as a person's erasure closes them (people.ts). */
  naming: Naming;
}

/** `adding`'s change key, content and sources, hashed: what its write needs, made before it. */
export const hashesOf = async (adding: Adding): Promise<AddHashes> => {
  const key = await hashOf(encoder.encode(adding.change));
  const hash = await hashOf(
    encoder.encode(
      JSON.stringify([
        adding.access,
        adding.entities,
        adding.memories,
        adding.extracted ?? null,
      ])
    )
  );
  const sources = new Set([
    ...adding.memories.flatMap(({ basis }) =>
      basis.kind === "source" ? [basis.source] : []
    ),
    ...(adding.extracted === undefined ? [] : [adding.extracted.source]),
  ]);
  const subjects = new Map(
    await Promise.all(
      [...sources].map(
        async (source) => [source, await subjectOf(source)] as const
      )
    )
  );
  const restatements = await Promise.all(
    adding.memories.map(
      async ({ type, speaker, value, statement }) =>
        await restatementOf({ type, speaker, value: value ?? null, statement })
    )
  );
  const writers = new Map(
    await Promise.all(
      [
        ...new Set(
          adding.memories.flatMap(({ basis }) =>
            basis.kind === "writer" ? [basis.writer] : []
          )
        ),
      ].map(async (writer) => [writer, await writerSubjectOf(writer)] as const)
    )
  );
  const naming = await namingOf(
    adding.entities,
    adding.memories.map(({ speaker }) => speaker)
  );
  return { key, hash, subjects, writers, restatements, naming };
};

/**
 * Writes `adding` (above), or answers what its change added before, with
 * `hashes` made of it before (`hashesOf`), and its memories that rest on a
 * version before their source's current one judged against `texts`, the
 * current versions' texts (quotes.ts): `CurrentTextsNeededError` when one is
 * missing, writing nothing. Synchronous: run it in a transaction, which a
 * caller may share with checks of its own, so what it checks holds as the
 * add writes.
 */
export const writeAdd = (
  { storage, db, shared }: Omit<RememberStore, "bucket">,
  asked: Adding,
  { key, hash, subjects, writers, restatements, naming }: AddHashes,
  texts: CurrentTexts = new Map()
): AddedMemories => {
  // Refused as asked, before anything is left out of it.
  planOf(asked);
  const { sql } = storage;
  {
    // Nothing is added while a restore runs (restoring.ts): it writes a
    // lineage's memories in their order, which an add between would break.
    if (isRestoring(sql)) {
      throw new Error(restoringNow);
    }
    const [before] = sql
      .exec<{ hash: string; answer: string }>(
        "SELECT hash, answer FROM memory_changes WHERE key = ?",
        key
      )
      .toArray();
    if (before !== undefined) {
      if (before.hash !== hash) {
        throw new Error(changeReused);
      }
      return answerSchema.parse(JSON.parse(before.answer));
    }
    // An identifier a person's erasure closed (people.ts) is left out,
    // and the rest written: answered as for an identifier the store holds
    // nowhere, so an add learns nothing of an erasure. Drawn from a source
    // (a memory rests on a version, or it marks one extracted), the erased
    // person's card is left out too, with what is about it or relates to
    // it: it is answered for none of them. Only extraction
    // speaks for an internal person in the shared store, and it leaves out
    // what is in an erased person's word before it writes: one here is a
    // host's fault. A repeat of an add made before answers above, as it was.
    if (naming.speakers.some((person) => isErasedPerson(sql, person))) {
      throw refused("it is in the word of a person an erasure took");
    }
    const drawn =
      asked.extracted !== undefined ||
      asked.memories.some(({ basis }) => basis.kind === "source");
    const adding: Adding = {
      ...asked,
      ...(drawn
        ? leavingOutCards(sql, asked, naming.identifiers)
        : {
            entities: strippedOf(sql, asked.entities, naming.identifiers)
              .entities,
          }),
    };
    const planned = planOf(adding);
    const identified = new Set(
      asked.entities.flatMap((entity) =>
        entity.identifiers.length > 0 ? [entity.key] : []
      )
    );
    // The set is stored (read sets match readers by it); memories name it
    // by its key alone, never its row id.
    readerSetOf(db, adding.access);
    const readers = readerSetKeyOf(adding.access);
    const rows = entityRowsOf(
      sql,
      adding,
      readers,
      shared,
      adding.entities.map((entity) => identified.has(entity.key))
    );
    const ids = rows.map(
      (row) =>
        sql
          .exec<{ id: string }>("SELECT id FROM entities WHERE row = ?", row)
          .one().id
    );
    const into: Into = {
      sql,
      entities: adding.entities,
      rows,
      ids,
      readers,
      shared,
      subjects,
      writers,
      // Each kept memory's own (the add's hash is of the add as asked).
      restatements: adding.memories.map(
        (memory) => restatements[asked.memories.indexOf(memory)] ?? ""
      ),
      learnedAt: stampWrite(sql),
      memo: new Map(),
    };
    const made = adding.memories.map((memory, index) =>
      writeMemory(into, memory, planned[index], index)
    );
    const written = made.map((memory) => memory.written);
    judgeLate(sql, written, texts);
    const first = written.at(0);
    const last = written.at(-1);
    if (first !== undefined && last !== undefined) {
      markJudged(sql, first.row, last.row);
    }
    const memories = made.map((memory) => memory.id);
    if (adding.extracted !== undefined) {
      markExtracted(sql, adding.extracted, into);
    }
    const answer: AddedMemories = {
      memories,
      entities: Object.fromEntries(
        adding.entities.map(({ key: entityKey }, index) => [
          entityKey,
          ids[index] ?? "",
        ])
      ),
    };
    sql.exec(
      "INSERT INTO memory_changes (key, hash, answer) VALUES (?, ?, ?)",
      key,
      hash,
      JSON.stringify(answer)
    );
    return answer;
  }
};

/**
 * What `needed` holds of `adding`'s quotes, read from the bucket one
 * version at a time, each text let go before the next is read: what a late
 * add's transaction asked for (`CurrentTextsNeededError`). A version whose
 * file is gone holds none (quotes.ts `heldIn`).
 */
const textsOf = async (
  bucket: BrainBucket,
  needed: CurrentTextsNeededError["needed"],
  adding: Adding
): Promise<Map<string, CurrentText>> => {
  const read = new Map<string, CurrentText>();
  for (const { source, row, file } of needed) {
    const quotes = adding.memories.flatMap(({ basis }) =>
      basis.kind === "source" && basis.source === source ? [basis.quote] : []
    );
    // oxlint-disable-next-line no-await-in-loop -- one text in memory at a time
    const object = await bucket.get(fileKeyOf(file));
    if (object === null) {
      // As a read of a version whose file is gone says it (sources.ts).
      log.warn("brain.version_file_missing", {});
    }
    // oxlint-disable-next-line no-await-in-loop -- one text in memory at a time
    const text = object === null ? null : await object.text();
    read.set(source, { row, file, held: heldIn(text, quotes) });
  }
  return read;
};

/**
 * Adds `adding` (above), or answers what its change added before. Its
 * memories are readable by its `access` (and, resting on a version, by
 * that version's readers too: memories.ts). A memory resting on a version
 * before its source's current one needs that current version's text: the
 * transaction asks for it, the file is read, and the add is made again
 * with it, again whenever a newer version landed while it read, so it is
 * judged against the version current as it is written.
 */
export const addMemories = async (
  store: RememberStore,
  adding: Adding
): Promise<AddedMemories> => {
  // Checked before anything is hashed, as the add always was.
  planOf(adding);
  const hashes = await hashesOf(adding);
  const attempt = (given: CurrentTexts): AddedMemories =>
    store.storage.transactionSync(() => writeAdd(store, adding, hashes, given));
  let texts: CurrentTexts = new Map();
  for (;;) {
    try {
      return attempt(texts);
    } catch (error) {
      if (!(error instanceof CurrentTextsNeededError)) {
        throw error;
      }
      texts = new Map([
        ...texts,
        // oxlint-disable-next-line no-await-in-loop -- read again only when a newer version landed
        ...(await textsOf(store.bucket, error.needed, adding)),
      ]);
    }
  }
};
