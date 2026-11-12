import type {
  ChunkRef,
  FoundChunk,
  Reader,
  VectorModel,
  VectorsFound,
  VectorSearch,
  VectorsToPut,
} from "./contract.ts";
import { byNearness } from "./order.ts";
import { readableSql } from "./reader-sets.ts";

// The vector way: an exact 1-bit scan, no index structure, with the
// nearest `rescoreCandidates` re-scored. Every chunk of a current version
// can hold a code per embedding model (db/schema.ts `vectorCodes`):
//
// - a 1-bit code, a bit per dimension set where the vector is above the
//   model's centre, which every search scans, all of it, by Hamming
//   distance;
// - an 8-bit code, which re-scores the `rescoreCandidates` nearest by
//   Hamming: the score is the cosine of the question's code and the
//   chunk's, each by its own length, so it is within -1 to 1, a code
//   scores 1 against itself, and one direction scores alike at every
//   magnitude.
//
// The scan is exact; the final order is the cosine's only among the
// candidates, so a chunk whose 1-bit code falls outside them is missed
// even if its cosine is near the top: how often depends on the model's
// vectors, and recall (GRA-1769) sets `rescoreCandidates` by evaluating
// real embeddings.
//
// Codes are grouped by model and by the set of readers of the chunk's
// version, which the store reads from the chunk, never from the caller. A
// group's new codes are its tail, one row each; once a tail holds
// `blockSize` codes they are packed into a block, one row holding all
// their 1-bit codes, so a scan reads few rows. A search reads only the
// blocks and tails of the groups its reader is in (`readableSql`, as word
// recall does): a code the reader may not read is never read, scored,
// ranked or counted, so it can neither appear nor move what does.
//
// A code is removed when its version stops being current: a tail code is
// deleted, and a packed one is deleted from `vector_codes` and its slot
// marked in `vector_removed`, which the scan skips before scoring. A
// repack rewrites one marked block at a time without them. An erasure
// removes a version's codes the same way, in the transaction that hides
// the version, and repacks each block it marked once it deletes the
// version (erasure.ts), so no block keeps an erased chunk's row or code.
//
// The rule the scan's candidates rest on: every code the scan can offer
// is of a current version the reader may read, by the model asked. Only
// so is no candidate place taken by one the re-scoring then drops, which
// would leave a nearer readable chunk unfound. Each way a chunk stops
// counting takes its codes out of the scan in the same transaction: a
// version replaced (sources.ts), hidden by an erasure and later deleted
// (erasure.ts); its readers never change (new readers make a new
// version); a code is read only from its model's blocks and tails, and
// from the reader's sets' (`blocksSql`); and a vector of other dimensions
// never reaches the scan. So the re-scoring's own check of currency and
// access drops nothing but what a fault left behind.
//
// Everything runs in TypeScript over typed arrays: measured in workerd,
// it scans far beyond what one store holds within the spike's numbers
// (test/brain-next-vector-timings.test.ts in core), so no WebAssembly.

/** Codes in a packed block. */
export const blockSize = 1024;

/**
 * How many of the nearest by Hamming distance are re-scored: a first
 * guess, which recall (GRA-1769) sets by evaluation with real embeddings.
 */
export const rescoreCandidates = 256;

/** Bits in a word of a 1-bit code. */
const wordBits = 32;

/** The largest step of an 8-bit code. */
const fineSteps = 127;

/** A model as the store keeps it. */
interface StoredModel {
  id: number;
  centre: Float64Array<ArrayBuffer>;
}

/** How many words a 1-bit code of `dimensions` takes. */
const wordsOf = (dimensions: number): number =>
  Math.ceil(dimensions / wordBits);

/** `vector`'s 1-bit code: bit `i` set where it is above `centre[i]`. */
const bitsOf = (
  vector: readonly number[],
  centre: Float64Array
): Uint32Array<ArrayBuffer> => {
  const bits = new Uint32Array(wordsOf(centre.length));
  for (const [index, value] of vector.entries()) {
    if (value > (centre[index] ?? 0)) {
      // oxlint-disable-next-line no-bitwise -- a bit per dimension
      bits[index >>> 5] = (bits[index >>> 5] ?? 0) | (1 << (index & 31));
    }
  }
  return bits;
};

/** The dot product of two 8-bit codes. */
const dotOf = (a: Int8Array, b: Int8Array): number => {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
};

/**
 * `vector`'s 8-bit code, its largest component `fineSteps` steps, and one
 * over the code's own length. Divided by its largest component first, so
 * no magnitude a finite, non-zero vector can have underflows to zero or
 * overflows to infinity. The length is the rounded code's, so the cosine
 * of two codes (`cosineOf`) is 1 for a code with itself, and codes of one
 * direction score alike whatever their magnitudes.
 */
const fineOf = (
  vector: readonly number[]
): { inverseLength: number; fine: Int8Array<ArrayBuffer> } => {
  const largest = Math.max(...vector.map((value) => Math.abs(value)));
  const fine = Int8Array.from(vector, (value) =>
    Math.round((value / largest) * fineSteps)
  );
  // At least one step is `fineSteps` (the largest component), so the
  // length is never zero.
  return { inverseLength: 1 / Math.sqrt(dotOf(fine, fine)), fine };
};

/**
 * The cosine of two 8-bit codes, by one over each one's length: within -1
 * to 1 however floating point rounds it.
 */
const cosineOf = (
  a: { inverseLength: number; fine: Int8Array },
  b: { inverseLength: number; fine: Int8Array }
): number =>
  Math.min(
    1,
    Math.max(-1, dotOf(a.fine, b.fine) * a.inverseLength * b.inverseLength)
  );

/**
 * The bytes of `view`, as SQLite takes a blob: every array here owns its
 * whole buffer, made or read for itself.
 */
const bytesOf = (view: { readonly buffer: ArrayBuffer }): ArrayBuffer =>
  view.buffer;

/**
 * Whether two centres hold the same numbers: compared as numbers, so -0
 * and 0 are the same (no centre holds NaN: the contract refuses it).
 */
const sameCentre = (a: Float64Array, b: Float64Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** The model named `name`, if it has codes. */
const storedModel = (
  sql: SqlStorage,
  name: string
): StoredModel | undefined => {
  const found = sql
    .exec<{ id: number; centre: ArrayBuffer }>(
      "SELECT id, centre FROM vector_models WHERE name = ?",
      name
    )
    .toArray()
    .at(0);
  return found === undefined
    ? undefined
    : { id: found.id, centre: new Float64Array(found.centre) };
};

/**
 * `model` as the store keeps it, added the first time: refused when its
 * name is known with another centre, so its codes stay comparable.
 */
const modelOf = (sql: SqlStorage, model: VectorModel): StoredModel => {
  const centre = Float64Array.from(model.centre);
  const known = storedModel(sql, model.name);
  if (known !== undefined) {
    if (!sameCentre(known.centre, centre)) {
      throw new Error(
        "The Brain refused it: this model is known with another centre"
      );
    }
    return known;
  }
  const { id } = sql
    .exec<{ id: number }>(
      "INSERT INTO vector_models (name, centre) VALUES (?, ?) RETURNING id",
      model.name,
      bytesOf(centre)
    )
    .one();
  return { id, centre };
};

/**
 * `?1` the source, `?2` the version, `?3` the position, `?4` the SHA-256
 * of the text the vector was made of, or null: the chunk there and its
 * version's set of readers, if that version is current and, given a
 * hash, the chunk still holds that text. So a vector made of a text a
 * chunk no longer holds is never kept for it, whatever its place.
 */
export const currentChunkSql = `
SELECT chunks.row AS chunk, source_versions.reader_set AS reader_set
FROM source_versions
JOIN current_versions ON current_versions.version_row = source_versions.row
JOIN chunks ON chunks.version_row = source_versions.row
WHERE source_versions.source = ?1 AND source_versions.version = ?2
  AND chunks.position = ?3 AND (?4 IS NULL OR chunks.hash = ?4)`;

/**
 * Packs the tail of the group of `model` and `readerSet` into blocks of
 * `blockSize`, oldest chunks first, while it holds that many. What is
 * left stays the tail, fewer than `blockSize`.
 */
const packTail = (sql: SqlStorage, model: number, readerSet: number): void => {
  for (;;) {
    // Counted first, from the index: most puts leave a tail to grow.
    const { size } = sql
      .exec<{ size: number }>(
        `SELECT count(*) AS size FROM vector_codes
        WHERE model = ? AND reader_set = ? AND block IS NULL`,
        model,
        readerSet
      )
      .one();
    if (size < blockSize) {
      return;
    }
    const tail = sql
      .exec<{ chunk: number; bits: ArrayBuffer }>(
        `SELECT chunk, bits FROM vector_codes
        WHERE model = ? AND reader_set = ? AND block IS NULL
        ORDER BY chunk LIMIT ?`,
        model,
        readerSet,
        blockSize
      )
      .toArray();
    if (tail.length < blockSize) {
      return;
    }
    const words = tail[0] === undefined ? 0 : tail[0].bits.byteLength / 4;
    const rows = new Float64Array(blockSize);
    const bits = new Uint32Array(blockSize * words);
    for (const [slot, code] of tail.entries()) {
      rows[slot] = code.chunk;
      bits.set(new Uint32Array(code.bits), slot * words);
    }
    const { id } = sql
      .exec<{ id: number }>(
        `INSERT INTO vector_blocks (model, reader_set, chunks, bits)
        VALUES (?, ?, ?, ?) RETURNING id`,
        model,
        readerSet,
        bytesOf(rows),
        bytesOf(bits)
      )
      .one();
    for (const [slot, code] of tail.entries()) {
      sql.exec(
        "UPDATE vector_codes SET block = ?, slot = ? WHERE chunk = ? AND model = ?",
        id,
        slot,
        code.chunk,
        model
      );
    }
  }
};

/**
 * Keeps the codes of each vector for its chunk, if that chunk is of a
 * current version and has none for the model yet, then packs the tails
 * that reached a block. Run it in one transaction. How many codes it
 * inserted: one per chunk that had none.
 */
export const putVectors = (
  sql: SqlStorage,
  { model, vectors }: VectorsToPut
): number => {
  const stored = modelOf(sql, model);
  const groups = new Set<number>();
  let written = 0;
  for (const { chunk, vector, hash } of vectors) {
    const found = sql
      .exec<{ chunk: number; reader_set: number }>(
        currentChunkSql,
        chunk.source,
        chunk.version,
        chunk.position,
        hash ?? null
      )
      .toArray()
      .at(0);
    if (found !== undefined) {
      const { inverseLength, fine } = fineOf(vector);
      written += sql
        .exec(
          `INSERT INTO vector_codes (chunk, model, reader_set, bits, inverse_length, fine)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (chunk, model) DO NOTHING
        RETURNING chunk`,
          found.chunk,
          stored.id,
          found.reader_set,
          bytesOf(bitsOf(vector, stored.centre)),
          inverseLength,
          bytesOf(fine)
        )
        .toArray().length;
      groups.add(found.reader_set);
    }
  }
  for (const readerSet of groups) {
    packTail(sql, stored.id, readerSet);
  }
  return written;
};

/**
 * Removes the codes of the chunks of the version at `versionRow`, for
 * every model: a packed one is marked removed in its block, until a
 * repack drops it, and a block left with no code is deleted at once, so
 * no scan reads it again. Run it in the transaction that makes the
 * version no longer current, or that erases it. Answers every block left
 * that holds a removed code of the version, marked now or before, for an
 * erasure to repack at once.
 */
export const removeVectorsOf = (
  sql: SqlStorage,
  versionRow: number
): number[] => {
  const blocks = JSON.stringify(
    sql
      .exec<{ block: number }>(
        `SELECT DISTINCT block FROM vector_codes
        WHERE block IS NOT NULL
          AND chunk IN (SELECT row FROM chunks WHERE version_row = ?)`,
        versionRow
      )
      .toArray()
      .map(({ block }) => block)
  );
  sql.exec(
    `INSERT OR IGNORE INTO vector_removed (block, slot, chunk)
    SELECT block, slot, chunk FROM vector_codes
    WHERE block IS NOT NULL
      AND chunk IN (SELECT row FROM chunks WHERE version_row = ?)`,
    versionRow
  );
  sql.exec(
    "DELETE FROM vector_codes WHERE chunk IN (SELECT row FROM chunks WHERE version_row = ?)",
    versionRow
  );
  const emptied = `SELECT value FROM json_each(?) WHERE NOT EXISTS (
    SELECT 1 FROM vector_codes WHERE vector_codes.block = json_each.value)`;
  sql.exec(`DELETE FROM vector_removed WHERE block IN (${emptied})`, blocks);
  sql.exec(`DELETE FROM vector_blocks WHERE id IN (${emptied})`, blocks);
  // Every block still holding a removed code of these chunks: marked now,
  // or when the version stopped being current, waiting for its repack.
  return sql
    .exec<{ block: number }>(
      `SELECT DISTINCT block FROM vector_removed
      WHERE chunk IN (SELECT row FROM chunks WHERE version_row = ?)`,
      versionRow
    )
    .toArray()
    .map(({ block }) => block);
};

/** A block holding removed codes: its id, model and set of readers. */
interface MarkedBlock extends Record<string, SqlStorageValue> {
  block: number;
  model: number;
  reader_set: number;
}

/**
 * The marked block a repack takes: the first by id, in the marks' own
 * primary key, then the block by its id, so it reads one mark and one
 * block however many wait. Which block comes
 * first doesn't matter: every marked one is repacked in its turn, and
 * none is read by a scan for its removed codes meanwhile.
 */
const nextMarkedSql = `
SELECT id AS block, model, reader_set FROM vector_blocks
WHERE id = (SELECT block FROM vector_removed ORDER BY block LIMIT 1)`;

/**
 * Repacks `marked`: its other codes go back to their group's tail, which
 * packs again, and the block and its marks are deleted, and with the
 * block the rows and 1-bit codes of the codes removed from it.
 */
const repack = (sql: SqlStorage, marked: MarkedBlock): void => {
  sql.exec(
    "UPDATE vector_codes SET block = NULL, slot = NULL WHERE block = ?",
    marked.block
  );
  sql.exec("DELETE FROM vector_removed WHERE block = ?", marked.block);
  sql.exec("DELETE FROM vector_blocks WHERE id = ?", marked.block);
  packTail(sql, marked.model, marked.reader_set);
};

/** Whether a block holds removed codes: what `repackVectors` repacks. */
export const repackDue = (sql: SqlStorage): boolean =>
  sql.exec("SELECT 1 FROM vector_removed LIMIT 1").toArray().length > 0;

/**
 * Repacks one block holding removed codes. Run it in one transaction.
 * True when another block holds removed codes.
 */
export const repackVectors = (sql: SqlStorage): boolean => {
  const marked = sql.exec<MarkedBlock>(nextMarkedSql).toArray().at(0);
  if (marked === undefined) {
    return false;
  }
  repack(sql, marked);
  return repackDue(sql);
};

/**
 * Repacks each of `blocks` that is left, in the caller's transaction (an
 * erasure's), so no block keeps an erased chunk's row or 1-bit code.
 */
export const repackBlocks = (
  sql: SqlStorage,
  blocks: readonly number[]
): void => {
  for (const block of blocks) {
    const marked = sql
      .exec<MarkedBlock>(
        "SELECT id AS block, model, reader_set FROM vector_blocks WHERE id = ?",
        block
      )
      .toArray()
      .at(0);
    if (marked !== undefined) {
      repack(sql, marked);
    }
  }
};

/** A model whose codes are being removed, and whether any are left. */
export interface DroppingModel {
  id: number;
  name: string;
  /** No block or code of it is left: only its row. */
  empty: boolean;
}

/** A build other than `?1` (the host's), which `dropVectorsStep` drops. */
export const replacedModels = "name <> ?1";

/**
 * Removes up to `blocks` blocks of codes, with their marks, and up to
 * `blockSize` tail codes, of the first model kept that isn't `keep`: a
 * build the host no longer runs. Run it in one transaction; null when
 * every model kept is `keep`. Its row stays until `forgetModel`.
 */
export const dropVectorsStep = (
  sql: SqlStorage,
  keep: string,
  blocks: number
): DroppingModel | null => {
  const model = sql
    .exec<{ id: number; name: string }>(
      `SELECT id, name FROM vector_models WHERE ${replacedModels}
      ORDER BY id LIMIT 1`,
      keep
    )
    .toArray()
    .at(0);
  if (model === undefined) {
    return null;
  }
  const taken = `SELECT id FROM vector_blocks WHERE model = ?1 ORDER BY id LIMIT ?2`;
  sql.exec(
    `DELETE FROM vector_removed WHERE block IN (${taken})`,
    model.id,
    blocks
  );
  sql.exec(
    `DELETE FROM vector_codes WHERE block IN (${taken})`,
    model.id,
    blocks
  );
  sql.exec(
    `DELETE FROM vector_blocks WHERE id IN (${taken})`,
    model.id,
    blocks
  );
  sql.exec(
    `DELETE FROM vector_codes WHERE rowid IN (
      SELECT rowid FROM vector_codes WHERE model = ? AND block IS NULL LIMIT ?)`,
    model.id,
    blockSize
  );
  const left = sql
    .exec(
      `SELECT 1 FROM vector_blocks WHERE model = ?1
      UNION ALL SELECT 1 FROM vector_codes WHERE model = ?1 LIMIT 1`,
      model.id
    )
    .toArray();
  return { ...model, empty: left.length === 0 };
};

/** Forgets a model `dropVectorsStep` emptied: its row, unless codes came back meanwhile. */
export const forgetModel = (sql: SqlStorage, id: number): void => {
  sql.exec(
    `DELETE FROM vector_models WHERE id = ?1
      AND NOT EXISTS (SELECT 1 FROM vector_blocks WHERE model = ?1)
      AND NOT EXISTS (SELECT 1 FROM vector_codes WHERE model = ?1)`,
    id
  );
};

/** A 32-bit word's set bits. */
const setBitsOf = (word: number): number => {
  // oxlint-disable-next-line no-bitwise -- a population count
  let bits = word - ((word >>> 1) & 0x55_55_55_55);
  // oxlint-disable-next-line no-bitwise -- a population count
  bits = (bits & 0x33_33_33_33) + ((bits >>> 2) & 0x33_33_33_33);
  // oxlint-disable-next-line no-bitwise -- a population count
  bits = (bits + (bits >>> 4)) & 0x0f_0f_0f_0f;
  // oxlint-disable-next-line no-bitwise -- a population count
  return Math.imul(bits, 0x01_01_01_01) >>> 24;
};

/**
 * The `rescoreCandidates` nearest codes seen, by Hamming distance and then
 * by chunk row, so which are kept never depends on the order they are
 * seen in: a heap with the farthest kept at 0.
 */
interface Nearest {
  readonly distances: Int32Array;
  readonly chunks: Float64Array;
  count: number;
}

const nearestOf = (size: number): Nearest => ({
  distances: new Int32Array(size),
  chunks: new Float64Array(size),
  count: 0,
});

/** Whether the kept code at `a` is farther than the one at `b`. */
const farther = ({ distances, chunks }: Nearest, a: number, b: number) => {
  const da = distances[a] ?? 0;
  const db = distances[b] ?? 0;
  return da === db ? (chunks[a] ?? 0) > (chunks[b] ?? 0) : da > db;
};

const swap = ({ distances, chunks }: Nearest, a: number, b: number): void => {
  const distance = distances[a] ?? 0;
  const chunk = chunks[a] ?? 0;
  distances[a] = distances[b] ?? 0;
  chunks[a] = chunks[b] ?? 0;
  distances[b] = distance;
  chunks[b] = chunk;
};

/** Keeps the chunk at `distance` if it is among the nearest so far. */
const offer = (nearest: Nearest, distance: number, chunk: number): void => {
  const { distances, chunks } = nearest;
  const size = distances.length;
  if (nearest.count < size) {
    let at = nearest.count;
    nearest.count += 1;
    distances[at] = distance;
    chunks[at] = chunk;
    while (at > 0) {
      // oxlint-disable-next-line no-bitwise -- the heap's parent
      const parent = (at - 1) >> 1;
      if (!farther(nearest, at, parent)) {
        return;
      }
      swap(nearest, at, parent);
      at = parent;
    }
    return;
  }
  const top = distances[0] ?? 0;
  if (distance > top || (distance === top && chunk > (chunks[0] ?? 0))) {
    return;
  }
  distances[0] = distance;
  chunks[0] = chunk;
  let at = 0;
  for (;;) {
    const left = 2 * at + 1;
    const right = left + 1;
    let farthest = at;
    if (left < size && farther(nearest, left, farthest)) {
      farthest = left;
    }
    if (right < size && farther(nearest, right, farthest)) {
      farthest = right;
    }
    if (farthest === at) {
      return;
    }
    swap(nearest, at, farthest);
    at = farthest;
  }
};

/**
 * Offers each code of `bits` (as many words a code as `query`), not
 * marked in `skip`, at its Hamming distance from `query`.
 */
const scan = (
  query: Uint32Array,
  bits: Uint32Array,
  chunks: Float64Array,
  skip: Uint8Array | undefined,
  nearest: Nearest
): void => {
  const words = query.length;
  for (let code = 0; code < chunks.length; code += 1) {
    if (skip?.[code] !== 1) {
      const at = code * words;
      let distance = 0;
      for (let word = 0; word < words; word += 1) {
        distance += setBitsOf(
          // oxlint-disable-next-line no-bitwise -- the bits that differ
          (query[word] ?? 0) ^ (bits[at + word] ?? 0)
        );
      }
      offer(nearest, distance, chunks[code] ?? 0);
    }
  }
};

/**
 * `?1` the model, `?2` the reader's person, `?3` their groups (JSON): the
 * blocks of the reader's groups, with the slots marked removed in each.
 * The reader's sets come first (`CROSS JOIN` keeps SQLite to that order),
 * each looked up in the blocks' index (`INDEXED BY`: SQLite refuses the
 * statement rather than run it another way), so a block of another set
 * is never read, whatever SQLite's statistics say: with them, and few
 * blocks, it chose to scan every block for each set.
 */
const blocksSql = `
WITH ${readableSql}
SELECT vector_blocks.chunks AS chunks, vector_blocks.bits AS bits,
  (SELECT json_group_array(slot) FROM vector_removed
    WHERE vector_removed.block = vector_blocks.id) AS removed
FROM readable
CROSS JOIN vector_blocks INDEXED BY vector_blocks_group_idx
  ON vector_blocks.model = ?1
  AND vector_blocks.reader_set = readable.reader_set`;

/** As `blocksSql`, through the codes' group index: the tail codes of the reader's groups. */
const tailSql = `
WITH ${readableSql}
SELECT vector_codes.chunk AS chunk, vector_codes.bits AS bits
FROM readable
CROSS JOIN vector_codes INDEXED BY vector_codes_group_idx
  ON vector_codes.model = ?1
  AND vector_codes.reader_set = readable.reader_set
  AND vector_codes.block IS NULL`;

/**
 * As `blocksSql`, and `?4` the candidates' chunks (JSON): each one's
 * 8-bit code and place, if its version is current and the reader may
 * read it. The scan only offered such codes (the rule above); this checks
 * again, so a code left behind by a fault is dropped before it is ranked,
 * never returned.
 */
const candidatesSql = `
WITH ${readableSql}
SELECT vector_codes.chunk AS chunk,
  vector_codes.inverse_length AS inverse_length,
  vector_codes.fine AS fine, source_versions.source AS source,
  source_versions.version AS version, chunks.position AS position,
  source_versions.added_at AS added_at
FROM json_each(?4) AS candidate
CROSS JOIN vector_codes ON vector_codes.chunk = candidate.value
  AND vector_codes.model = ?1
JOIN chunks ON chunks.row = vector_codes.chunk
JOIN current_versions ON current_versions.version_row = chunks.version_row
JOIN source_versions ON source_versions.row = chunks.version_row
WHERE source_versions.reader_set IN (SELECT reader_set FROM readable)`;

/** The slots `removed` (a JSON array) marks, as a mask of `size`. */
const maskOf = (removed: string, size: number): Uint8Array | undefined => {
  const slots: unknown = JSON.parse(removed);
  if (!Array.isArray(slots) || slots.length === 0) {
    return undefined;
  }
  const mask = new Uint8Array(size);
  for (const slot of slots) {
    if (typeof slot === "number") {
      mask[slot] = 1;
    }
  }
  return mask;
};

/** A chunk the vector way found: its row, its place and cosine, and when its version was added. */
interface Closest {
  chunk: number;
  found: FoundChunk;
  addedAt: number;
}

/**
 * The chunks of current versions `reader` may read whose codes for
 * `stored` are nearest `vector` (as long as its centre), nearest first,
 * at most `limit`: the `rescoreCandidates` nearest by Hamming distance
 * over every such
 * code, block by block, then re-scored by the cosine of their 8-bit
 * codes. Ties go to the older version, then by source and place
 * (order.ts `byNearness`). Memory stays at one block and the candidates.
 */
const closestOf = (
  sql: SqlStorage,
  stored: StoredModel,
  vector: readonly number[],
  reader: Reader,
  limit: number
): Closest[] => {
  const { person, groups } = reader;
  const readerJson = JSON.stringify(groups);
  const query = bitsOf(vector, stored.centre);
  const nearest = nearestOf(rescoreCandidates);
  const blocks = sql.exec<{
    chunks: ArrayBuffer;
    bits: ArrayBuffer;
    removed: string;
  }>(blocksSql, stored.id, person, readerJson);
  for (const block of blocks) {
    const chunks = new Float64Array(block.chunks);
    scan(
      query,
      new Uint32Array(block.bits),
      chunks,
      maskOf(block.removed, chunks.length),
      nearest
    );
  }
  const tail = sql.exec<{ chunk: number; bits: ArrayBuffer }>(
    tailSql,
    stored.id,
    person,
    readerJson
  );
  for (const code of tail) {
    scan(
      query,
      new Uint32Array(code.bits),
      Float64Array.of(code.chunk),
      undefined,
      nearest
    );
  }
  const candidates = [...nearest.chunks.subarray(0, nearest.count)];
  if (candidates.length === 0) {
    return [];
  }
  const asked = fineOf(vector);
  const scored = sql
    .exec<{
      chunk: number;
      inverse_length: number;
      fine: ArrayBuffer;
      source: string;
      version: number;
      position: number;
      added_at: number;
    }>(candidatesSql, stored.id, person, readerJson, JSON.stringify(candidates))
    .toArray()
    .map(
      ({
        chunk,
        inverse_length,
        fine,
        source,
        version,
        position,
        added_at,
      }) => ({
        chunk,
        addedAt: added_at,
        found: {
          source,
          version,
          position,
          score: cosineOf(asked, {
            inverseLength: inverse_length,
            fine: new Int8Array(fine),
          }),
        } satisfies FoundChunk,
      })
    );
  scored.sort((a, b) =>
    byNearness(
      { ...a.found, addedAt: a.addedAt },
      { ...b.found, addedAt: b.addedAt }
    )
  );
  return scored.slice(0, limit);
};

/**
 * The chunks of current versions `reader` may read whose codes for the
 * model are nearest `vector`, nearest first (`closestOf`); none for a
 * model with no codes. Refused for a vector of other dimensions than the
 * model's.
 */
export const searchVectors = (
  sql: SqlStorage,
  { model, vector, reader, limit }: VectorSearch
): VectorsFound => {
  const stored = storedModel(sql, model);
  if (stored === undefined) {
    return { chunks: [] };
  }
  if (vector.length !== stored.centre.length) {
    throw new Error(
      `The Brain refused it: the model's vectors have ${stored.centre.length} dimensions`
    );
  }
  return {
    chunks: closestOf(sql, stored, vector, reader satisfies Reader, limit).map(
      ({ found }) => found
    ),
  };
};

/**
 * A chunk recall's vector way found, with its row, its text and its
 * cosine to the question's vector (by its 8-bit code), which recall
 * across stores orders by.
 */
export interface NearChunk extends ChunkRef {
  row: number;
  text: string;
  score: number;
  addedAt: number;
}

/**
 * For recall: the chunks `searchVectors` finds for the model named
 * `model`, nearest first, at most `limit`, with their rows and texts.
 * None, never a refusal, when the store holds no codes of the model or
 * `vector` has other dimensions than its codes.
 */
export const nearChunks = (
  sql: SqlStorage,
  model: string,
  vector: readonly number[],
  reader: Reader,
  limit: number
): NearChunk[] => {
  const stored = storedModel(sql, model);
  if (stored === undefined || vector.length !== stored.centre.length) {
    return [];
  }
  const closest = closestOf(sql, stored, vector, reader, limit);
  if (closest.length === 0) {
    return [];
  }
  const texts = new Map(
    sql
      .exec<{ row: number; text: string }>(
        "SELECT row, text FROM chunks WHERE row IN (SELECT value FROM json_each(?))",
        JSON.stringify(closest.map(({ chunk }) => chunk))
      )
      .toArray()
      .map(({ row, text }) => [row, text])
  );
  return closest.flatMap(
    ({ chunk, addedAt, found: { source, version, position, score } }) => {
      const text = texts.get(chunk);
      return text === undefined
        ? []
        : [{ row: chunk, source, version, position, text, score, addedAt }];
    }
  );
};
