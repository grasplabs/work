import { withinTime } from "@grasp-os/shared/deadline";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  embedReplySchema,
  embedTextsMax,
  sourceIdSchema,
  vectorDimensionsMax,
  vectorModelNameOf,
  versionSchema,
} from "./contract.ts";
import type {
  EmbedModel,
  EmbeddingOverview,
  SourceId,
  VectorsToPut,
} from "./contract.ts";
import {
  leftVectorWrite,
  noteVectorWrite,
  settleVectorWrites,
  vectorKeyOf,
  vectorsInDoubt,
} from "./files.ts";
import type { VectorObject } from "./files.ts";
import {
  currentChunkSql,
  dropVectorsStep,
  forgetModel,
  putVectors,
} from "./vectors.ts";
import { defineWork, enqueueWork, WorkError } from "./work.ts";
import type { WorkContext } from "./work.ts";

// Embedding: every chunk of a current version gets vectors from the host's
// embedding model, as work on the queue, so a first load of many sources
// is spread over many short pieces and never holds the store.
//
// - Each version with chunks is put on the queue as it is written, in the
//   transaction that writes it (sources.ts), keyed by its source: a newer
//   version replaces the item still waiting.
// - One run embeds one batch, the version's first `embedBatch` chunks
//   with no codes of the host's model yet, each text once however often
//   the version holds it, then puts the item back while more are left
//   (`again`). A run that stopped in the middle runs again and finds what
//   the last one wrote: codes are written once per chunk and model.
// - A run names a passage by its place and the SHA-256 of its text, and
//   writes nothing for it after an await unless that place still holds a
//   current chunk of that text (`stillHeld`, and `putVectors` in the same
//   statement): a vector made of a text a chunk no longer holds is never
//   kept for it, whatever the place's version.
// - The full vector of each passage is kept in the host's Brain bucket
//   under its model and the SHA-256 of its text (files.ts `vectorKeyOf`),
//   noted before it is written and written before its codes, so the same
//   text is run through the model once however many sources and versions
//   hold it, and the codes can be made again without the model. Only what
//   the model made, and checked, is kept: a reply of another model, of the
//   wrong count, or with a vector that isn't one, fails the item and
//   writes nothing. A vector whose text no current chunk holds any more,
//   or whose build the host no longer runs, is deleted by the file sweep
//   (files.ts), its one way out. A write the run stopped waiting for keeps
//   its row and starts its grace again, so the sweep never deletes the
//   row before the write may still land.
// - Blame comes only from the embedder's own answer for one text: its
//   module failed on it twice (the second time on a fresh instance), or
//   it is too long, or not text. That passage is passed over for this
//   build (`unembeddable`) at once, its neighbours embedded all the same;
//   a re-embed and every other build try it again, and the overview
//   counts it.
// - A call that breaks whole (its object ended, ran out of memory,
//   couldn't load its model, or took the time left) blames nobody: the run
//   keeps what it wrote, and its attempt fails (`embedder_unavailable`),
//   retried after the queue's backoff and parked after its attempts, as
//   any work: so a text that ends its object every time parks its own
//   source's item and stops there, visible to staff, while other items go
//   on. The embedders are the host's own objects, not a provider, so the
//   queue pauses nothing; parked items come back the next day by
//   themselves, or at once when staff re-embed (`reembed`).
// - While the host runs no model, nothing is embedded: an item finds none
//   and is done, and the overview says so.
// - Each call to the bucket is bounded (`bucketCallMs`) and ends with the
//   item's time, so a bucket that hangs fails the item, never holds it.
//
// A change of model: the host's model is its name and its build, a hash
// of the model's files and the code that runs it (@grasp-os/embed), and
// vectors of two builds are never compared. At the first tick with a new
// one, the store walks every current version, a bounded number a tick,
// and puts each with chunks lacking its codes on the queue (`walkStep`),
// marked as the rebuild's. Codes are kept per build, so a search names its
// build: recall searches by the host's model alone, and uses the vector
// way only once the rebuild is over (`EmbeddingOverview.rebuilt`), the
// other ways answering meanwhile. Once the walk is over, the codes of
// every other build are removed a few blocks a tick, and their vectors
// left to the sweep (`dropStep`). A re-embed is a rebuild of the same
// build.
//
// Nothing of a passage reaches a log, an error or the overview: errors
// are the queue's codes, and a host's error is never read.

/** Most passages one run embeds: one call of the embedder (@grasp-os/embed `maxTextsPerCall`). */
export const embedBatch = embedTextsMax;

/** Most current versions a tick's walk looks at. */
export const walkPerTick = 200;

/** Most blocks of a replaced build's codes a tick removes. */
export const dropBlocksPerTick = 16;

/** Most of a replaced build's vectors, or passages it couldn't embed, a tick lets go. */
const dropRowsPerTick = 1000;

/** How long one call to the bucket may take: as long as a sweep waits. */
export const bucketCallMs = 10_000;

/** The kind of work an item of embedding is. */
const embedKind = "embed";

/** A vector: of the model's dimensions, finite numbers, not all zero. */
const isVector = (vector: readonly number[]): boolean =>
  vector.length > 0 &&
  vector.length <= vectorDimensionsMax &&
  vector.every((value) => Number.isFinite(value)) &&
  vector.some((value) => value !== 0);

/** A kept vector's bytes as numbers, or null when they aren't one. */
const vectorOf = (bytes: ArrayBuffer): number[] | null => {
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }
  const vector = [...new Float32Array(bytes)];
  return isVector(vector) ? vector : null;
};

/**
 * `call` to the bucket, at most `bucketCallMs` and never past the item's
 * time: a `WorkError` once either is up (`timed_out`, or the reason the
 * item's signal gives: `erased`). A call left behind goes on, unheard.
 */
const bucketCall = async <T>(
  signal: AbortSignal,
  call: () => Promise<T>
): Promise<T> => {
  signal.throwIfAborted();
  try {
    return await withinTime(call, bucketCallMs, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new WorkError("timed_out");
    }
    throw error;
  }
};

/** A chunk to embed: its place, its text and its text's SHA-256. */
interface Passage {
  position: number;
  text: string;
  hash: string;
}

/**
 * `?1` the source, `?2` the version, `?3` the model's name, `?4` how
 * many: the chunks of the version, if it is current, with no codes of the
 * model and not passed over by it, first first.
 */
const lackingSql = `
SELECT chunks.position AS position, chunks.text AS text, chunks.hash AS hash
FROM source_versions
JOIN current_versions ON current_versions.version_row = source_versions.row
JOIN chunks ON chunks.version_row = source_versions.row
WHERE source_versions.source = ?1 AND source_versions.version = ?2
  AND chunks.hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM vector_codes
    JOIN vector_models ON vector_models.id = vector_codes.model
    WHERE vector_codes.chunk = chunks.row AND vector_models.name = ?3)
  AND NOT EXISTS (
    SELECT 1 FROM unembeddable
    WHERE unembeddable.model = ?3 AND unembeddable.hash = chunks.hash)
ORDER BY chunks.position
LIMIT ?4`;

/** What a run has for a text: as the host's embedders answer (contract.ts `embedReplySchema`). */
type Result = number[] | "unembeddable" | null;

/**
 * The results of `hashes`' texts by `model`, by hash: kept vectors from
 * the bucket, but never one whose delete may still land
 * (`vectorsInDoubt`), the rest from the host's embedders; and which came
 * from the embedders. Throws a `WorkError` when the embedders gave
 * nothing, or gave what isn't theirs to give.
 */
const resultsOf = async (
  texts: ReadonlyMap<string, string>,
  model: EmbedModel,
  { bucket, embedders, signal, storage }: WorkContext
): Promise<{ results: Map<string, Result>; made: Set<string> }> => {
  const name = vectorModelNameOf(model);
  const hashes = [...texts.keys()];
  const inDoubt = vectorsInDoubt(storage.sql, name, hashes);
  const kept = await Promise.all(
    hashes.map(async (hash): Promise<[string, Result]> => {
      if (inDoubt.has(hash)) {
        return [hash, null];
      }
      const object = await bucketCall(
        signal,
        async () => await bucket.get(vectorKeyOf(name, hash))
      );
      return [
        hash,
        object === null
          ? null
          : vectorOf(
              await bucketCall(signal, async () => await object.arrayBuffer())
            ),
      ];
    })
  );
  const results = new Map(kept);
  const missing = hashes.filter((hash) => results.get(hash) === null);
  const made = new Set<string>();
  if (missing.length === 0) {
    return { results, made };
  }
  const parsed = embedReplySchema.safeParse(
    await embedders.embed(missing.map((hash) => texts.get(hash) ?? ""))
  );
  if (
    !parsed.success ||
    parsed.data.kind !== "vectors" ||
    parsed.data.results.length !== missing.length
  ) {
    throw new WorkError("embedder_unavailable");
  }
  const { model: answeredBy, results: answered } = parsed.data;
  // A vector or a verdict is the build's that answered: one of another
  // build than the host's is not this build's, and nothing of it is kept.
  if (
    answered.some((result) => result !== null) &&
    (answeredBy === null || vectorModelNameOf(answeredBy) !== name)
  ) {
    throw new WorkError("embedder_unavailable");
  }
  for (const [at, result] of answered.entries()) {
    const hash = missing[at] ?? "";
    if (Array.isArray(result)) {
      if (!isVector(result)) {
        throw new WorkError("embedder_unavailable");
      }
      made.add(hash);
    }
    results.set(hash, result);
  }
  return { results, made };
};

/**
 * Whether the place of `passage` in the version still holds a current
 * chunk of its text: what every write after an await asks first.
 */
const stillHeld = (
  sql: SqlStorage,
  source: string,
  version: number,
  passage: Passage
): boolean =>
  sql
    .exec(currentChunkSql, source, version, passage.position, passage.hash)
    .toArray().length > 0;

/**
 * Embeds the next batch of one version's chunks (above): done when none
 * is left, the version is no longer current, or the host runs no model.
 */
const embedWork = defineWork({
  kind: embedKind,
  payload: z.strictObject({
    source: sourceIdSchema,
    version: versionSchema,
    /** Put on the queue by a rebuild's walk (`walkStep`). */
    rebuild: z.boolean().optional(),
  }),
  run: async ({ source, version }, context) => {
    const { model } = context.embedders;
    if (model === null) {
      return;
    }
    const { storage, bucket, signal } = context;
    const name = vectorModelNameOf(model);
    const rows = storage.sql
      .exec<{ position: number; text: string; hash: string }>(
        lackingSql,
        source,
        version,
        name,
        embedBatch
      )
      .toArray();
    if (rows.length === 0) {
      return;
    }
    const passages: Passage[] = rows;
    // Each text once, however many of the batch's chunks hold it.
    const texts = new Map(passages.map(({ hash, text }) => [hash, text]));
    const { results, made } = await resultsOf(texts, model, context);
    const vectors = [...results.values()].filter((result) =>
      Array.isArray(result)
    );
    const dimensions = vectors[0]?.length ?? 0;
    if (vectors.some((vector) => vector.length !== dimensions)) {
      throw new WorkError("embedder_unavailable");
    }
    const resultOf = (passage: Passage): Result =>
      results.get(passage.hash) ?? null;
    // Every vector checked: those the embedders made are kept, each noted
    // just before it is written, while a current chunk still holds its
    // text, and never one whose delete may still land.
    const db = drizzle(storage);
    const written: VectorObject[] = [];
    for (const hash of made) {
      const result = results.get(hash);
      const holder = passages.find(
        (passage) =>
          passage.hash === hash &&
          stillHeld(storage.sql, source, version, passage)
      );
      const object = { model: name, hash };
      // An erasure stops the run with `erased`: nothing of it is noted.
      signal.throwIfAborted();
      if (
        Array.isArray(result) &&
        holder !== undefined &&
        noteVectorWrite(db, object)
      ) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- noted one by one, each just before its write
          await bucketCall(
            signal,
            async () =>
              await bucket.put(
                vectorKeyOf(name, hash),
                Float32Array.from(result).buffer
              )
          );
        } catch (error) {
          // It may still land: its row keeps it in the sweep's sight.
          leftVectorWrite(storage.sql, object);
          throw error;
        }
        written.push(object);
      }
    }
    const put: VectorsToPut["vectors"] = passages.flatMap((passage) => {
      const result = resultOf(passage);
      return Array.isArray(result)
        ? [
            {
              chunk: { source, version, position: passage.position },
              vector: result,
              hash: passage.hash,
            },
          ]
        : [];
    });
    const unembeddable = passages.filter(
      (passage) => resultOf(passage) === "unembeddable"
    );
    // An erasure stops the run with `erased`: nothing of it is written.
    signal.throwIfAborted();
    let wrote = 0;
    storage.transactionSync(() => {
      if (put.length > 0) {
        wrote += putVectors(storage.sql, {
          // The 1-bit codes are each dimension's sign: the model's vectors
          // are unit length, so zero is their centre.
          model: { name, centre: Array.from({ length: dimensions }, () => 0) },
          vectors: put,
        });
      }
      settleVectorWrites(storage.sql, written);
      for (const passage of unembeddable) {
        if (stillHeld(storage.sql, source, version, passage)) {
          wrote += storage.sql
            .exec(
              "INSERT OR IGNORE INTO unembeddable (model, hash) VALUES (?, ?) RETURNING hash",
              name,
              passage.hash
            )
            .toArray().length;
        }
      }
    });
    if (passages.some((passage) => resultOf(passage) === null)) {
      // A call broke whole, or the time was up: what came is kept, and
      // the attempt fails, blaming no passage.
      throw new WorkError("embedder_unavailable");
    }
    if (rows.length === embedBatch) {
      // What it wrote, never what it meant to: a run whose every write was
      // refused fails its attempt (`no_progress`), never goes round.
      context.again(wrote);
    }
  },
});

/**
 * Puts the version `version` of `source` on the queue to embed, in place
 * of an item of the source still waiting: as the rebuild's when `rebuild`.
 * Run it in the transaction that writes the version.
 */
export const enqueueEmbedding = (
  storage: DurableObjectStorage,
  source: SourceId,
  version: number,
  { rebuild = false }: { rebuild?: boolean } = {}
): void => {
  // Every version takes the same class: whose class comes first is for the
  // producers to say once their classes differ.
  enqueueWork(storage, embedWork, {
    key: source,
    payload: rebuild ? { source, version, rebuild } : { source, version },
    priority: "recent",
  });
};

interface State extends Record<string, SqlStorageValue> {
  model: string | null;
  walked_to: number;
  walked: number;
  rebuilt: number;
}

const stateOf = (sql: SqlStorage): State | undefined =>
  sql
    .exec<State>(
      "SELECT model, walked_to, walked, rebuilt FROM embedding_state"
    )
    .toArray()
    .at(0);

/**
 * `?1` the last row walked, `?2` the model's name, `?3` how many: the
 * next current versions, by row, and whether any chunk of each lacks codes
 * of the model and isn't passed over by it.
 */
const walkSql = `
SELECT current_versions.version_row AS row, source_versions.source AS source,
  source_versions.version AS version,
  EXISTS (
    SELECT 1 FROM chunks WHERE chunks.version_row = current_versions.version_row
      AND chunks.hash IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM vector_codes
        WHERE vector_codes.chunk = chunks.row
          AND vector_codes.model = (SELECT id FROM vector_models WHERE name = ?2))
      AND NOT EXISTS (
        SELECT 1 FROM unembeddable
        WHERE unembeddable.model = ?2 AND unembeddable.hash = chunks.hash)
  ) AS lacking
FROM current_versions
JOIN source_versions ON source_versions.row = current_versions.version_row
WHERE current_versions.version_row > ?1
ORDER BY current_versions.version_row
LIMIT ?3`;

/** Whether an item the rebuild's walk put on the queue is still there, parked or not. */
const rebuildPendingSql = `
SELECT 1 FROM work_items
WHERE kind = '${embedKind}' AND json_extract(payload, '$.rebuild') = 1
LIMIT 1`;

/**
 * Notes `model` as the host's (null: none), starting the rebuild again
 * when it changed, then walks the next `walkPerTick` current versions,
 * putting each with chunks lacking its codes on the queue; once the walk
 * is over and none of what it put there is left, marks the rebuild done.
 * One transaction. Whether the walk is over.
 */
const walkStep = (
  storage: DurableObjectStorage,
  model: string | null
): boolean =>
  storage.transactionSync(() => {
    const { sql } = storage;
    const state = stateOf(sql);
    const fresh = state === undefined || state.model !== model;
    if (fresh) {
      sql.exec(
        `INSERT INTO embedding_state (id, model, walked_to, walked, rebuilt)
        VALUES (1, ?, 0, 0, 0)
        ON CONFLICT (id) DO UPDATE SET model = excluded.model, walked_to = 0,
          walked = 0, rebuilt = 0`,
        model
      );
    }
    if (model === null) {
      return false;
    }
    if (!fresh && state.walked === 1) {
      if (
        state.rebuilt === 1 ||
        sql.exec(rebuildPendingSql).toArray().length > 0
      ) {
        return true;
      }
      sql.exec("UPDATE embedding_state SET rebuilt = 1");
      return true;
    }
    const versions = sql
      .exec<{ row: number; source: string; version: number; lacking: number }>(
        walkSql,
        fresh ? 0 : state.walked_to,
        model,
        walkPerTick
      )
      .toArray();
    for (const { source, version, lacking } of versions) {
      if (lacking === 1) {
        enqueueEmbedding(storage, source, version, { rebuild: true });
      }
    }
    const walked = versions.length < walkPerTick;
    sql.exec(
      "UPDATE embedding_state SET walked_to = ?, walked = ?",
      versions.at(-1)?.row ?? (fresh ? 0 : state.walked_to),
      walked ? 1 : 0
    );
    return walked;
  });

/**
 * Removes a few blocks of the codes of a build other than `model`, lets
 * the sweep have a batch of its vectors (files.ts) and forgets the
 * passages it couldn't embed, then, once no code of it is left, its row.
 * One transaction.
 */
const dropStep = (storage: DurableObjectStorage, model: string): void => {
  storage.transactionSync(() => {
    const { sql } = storage;
    sql.exec(
      `UPDATE vector_files SET unheld = 1 WHERE rowid IN (
        SELECT rowid FROM vector_files WHERE model <> ? AND unheld = 0 LIMIT ?)`,
      model,
      dropRowsPerTick
    );
    sql.exec(
      `DELETE FROM unembeddable WHERE rowid IN (
        SELECT rowid FROM unembeddable WHERE model <> ? LIMIT ?)`,
      model,
      dropRowsPerTick
    );
    const dropping = dropVectorsStep(sql, model, dropBlocksPerTick);
    if (dropping?.empty === true) {
      forgetModel(sql, dropping.id);
    }
  });
};

/**
 * A tick's step of embedding, before the queue: notes the host's model,
 * walks a few current versions onto the queue for it, and once the walk is
 * over removes a little of the builds it replaced. Bounded, so it never
 * holds the tick; what is left is the next tick's.
 */
export const embeddingStep = (
  storage: DurableObjectStorage,
  model: EmbedModel | null
): void => {
  const name = model === null ? null : vectorModelNameOf(model);
  if (walkStep(storage, name) && name !== null) {
    dropStep(storage, name);
  }
};

/**
 * Starts the rebuild for the host's model as last seen again (staff's
 * re-embed): the walk from the first version, and the passages it
 * couldn't embed tried again. Answers whether it did: not while the store
 * has seen no model, as there is nothing to embed with. During a walk it
 * starts the walk over, so versions the walk already passed (their items
 * parked, say) are put back too; that is safe, as a version put on the
 * queue again replaces its item waiting or parked there.
 */
export const reembed = (storage: DurableObjectStorage): boolean =>
  storage.transactionSync(() => {
    const { sql } = storage;
    const state = stateOf(sql);
    if (state === undefined || state.model === null) {
      return false;
    }
    sql.exec(
      "UPDATE embedding_state SET walked_to = 0, walked = 0, rebuilt = 0"
    );
    sql.exec(
      "DELETE FROM unembeddable WHERE model = (SELECT model FROM embedding_state)"
    );
    return true;
  });

const countOf = (sql: SqlStorage, query: string, ...bindings: unknown[]) =>
  sql.exec<{ count: number }>(query, ...bindings).one().count;

/** How far embedding has come, as staff see it: counts only. */
export const embeddingOverview = (
  storage: DurableObjectStorage
): EmbeddingOverview => {
  const { sql } = storage;
  const state = stateOf(sql);
  const model = state?.model ?? null;
  const current = `FROM current_versions
    JOIN chunks ON chunks.version_row = current_versions.version_row`;
  return {
    model,
    chunks: countOf(sql, `SELECT count(*) AS count ${current}`),
    embedded:
      model === null
        ? 0
        : countOf(
            sql,
            `SELECT count(*) AS count ${current}
            JOIN vector_codes ON vector_codes.chunk = chunks.row
              AND vector_codes.model = (SELECT id FROM vector_models WHERE name = ?)`,
            model
          ),
    unembeddable:
      model === null
        ? 0
        : countOf(
            sql,
            `SELECT count(*) AS count ${current}
            WHERE EXISTS (SELECT 1 FROM unembeddable
              WHERE unembeddable.model = ? AND unembeddable.hash = chunks.hash)`,
            model
          ),
    parked: countOf(
      sql,
      `SELECT count(*) AS count FROM work_items
      WHERE kind = '${embedKind}' AND parked_at IS NOT NULL`
    ),
    rebuilt: model !== null && state?.rebuilt === 1,
  };
};
