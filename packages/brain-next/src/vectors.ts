import type {
  FoundChunk,
  Reader,
  VectorModel,
  VectorsFound,
  VectorSearch,
  VectorsToPut,
} from "./contract.ts";
import { readableSql } from "./reader-sets.ts";

// The vector way: an exact scan, no index structure. Every chunk of a
// current version can hold a code per embedding model (db/schema.ts
// `vectorCodes`):
//
// - a 1-bit code, a bit per dimension set where the vector is above the
//   model's centre, which every search scans by Hamming distance;
// - an 8-bit code of the unit vector, which re-scores the
//   `rescoreCandidates` nearest by Hamming into a cosine.
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
// repack rewrites one marked block at a time without them.
//
// Everything runs in TypeScript over typed arrays: measured in workerd,
// it scans far beyond what one store holds within the spike's numbers
// (test/brain-next-vector-timings.test.ts in core), so no WebAssembly.

/** Codes in a packed block. */
export const blockSize = 1024;

/** How many of the nearest by Hamming distance are re-scored. */
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

/** `vector`'s 8-bit code: its unit vector in steps of `scale`. */
const fineOf = (
  vector: readonly number[]
): { scale: number; fine: Int8Array<ArrayBuffer> } => {
  let squares = 0;
  let largest = 0;
  for (const value of vector) {
    squares += value * value;
    largest = Math.max(largest, Math.abs(value));
  }
  // The largest component, of the unit vector, is `fineSteps` steps.
  const scale = largest / Math.sqrt(squares) / fineSteps;
  const perStep = 1 / Math.sqrt(squares) / scale;
  const fine = Int8Array.from(vector, (value) => Math.round(value * perStep));
  return { scale, fine };
};

/**
 * The bytes of `view`, as SQLite takes a blob: every array here owns its
 * whole buffer, made or read for itself.
 */
const bytesOf = (view: { readonly buffer: ArrayBuffer }): ArrayBuffer =>
  view.buffer;

/** Whether two blobs hold the same bytes. */
const sameBytes = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  return left.every((byte, index) => byte === right[index]);
};

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
    if (!sameBytes(bytesOf(known.centre), bytesOf(centre))) {
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
 * `?1` the source, `?2` the version, `?3` the position: the chunk there
 * and its version's set of readers, if that version is current.
 */
const currentChunkSql = `
SELECT chunks.row AS chunk, source_versions.reader_set AS reader_set
FROM source_versions
JOIN current_versions ON current_versions.version_row = source_versions.row
JOIN chunks ON chunks.version_row = source_versions.row
WHERE source_versions.source = ?1 AND source_versions.version = ?2
  AND chunks.position = ?3`;

/**
 * Packs the tail of the group of `model` and `readerSet` into blocks of
 * `blockSize`, oldest chunks first, while it holds that many. What is
 * left stays the tail, fewer than `blockSize`.
 */
const packTail = (sql: SqlStorage, model: number, readerSet: number): void => {
  for (;;) {
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
 * that reached a block. Run it in one transaction.
 */
export const putVectors = (
  sql: SqlStorage,
  { model, vectors }: VectorsToPut
): void => {
  const stored = modelOf(sql, model);
  const groups = new Set<number>();
  for (const { chunk, vector } of vectors) {
    const found = sql
      .exec<{ chunk: number; reader_set: number }>(
        currentChunkSql,
        chunk.source,
        chunk.version,
        chunk.position
      )
      .toArray()
      .at(0);
    if (found !== undefined) {
      const { scale, fine } = fineOf(vector);
      sql.exec(
        `INSERT INTO vector_codes (chunk, model, reader_set, bits, scale, fine)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (chunk, model) DO NOTHING`,
        found.chunk,
        stored.id,
        found.reader_set,
        bytesOf(bitsOf(vector, stored.centre)),
        scale,
        bytesOf(fine)
      );
      groups.add(found.reader_set);
    }
  }
  for (const readerSet of groups) {
    packTail(sql, stored.id, readerSet);
  }
};

/**
 * Removes the codes of the chunks of the version at `versionRow`, for
 * every model: a packed one is marked removed in its block, until a
 * repack drops it. Run it in the transaction that makes the version no
 * longer current, or that erases it.
 */
export const removeVectorsOf = (sql: SqlStorage, versionRow: number): void => {
  sql.exec(
    `INSERT OR IGNORE INTO vector_removed (block, slot)
    SELECT block, slot FROM vector_codes
    WHERE block IS NOT NULL
      AND chunk IN (SELECT row FROM chunks WHERE version_row = ?)`,
    versionRow
  );
  sql.exec(
    "DELETE FROM vector_codes WHERE chunk IN (SELECT row FROM chunks WHERE version_row = ?)",
    versionRow
  );
};

/**
 * Repacks the block with the most removed codes: its other codes go back
 * to their group's tail, which packs again, and the block and its marks
 * are deleted. Run it in one transaction. True when another block holds
 * removed codes.
 */
export const repackVectors = (sql: SqlStorage): boolean => {
  const marked = sql
    .exec<{ block: number; model: number; reader_set: number }>(
      `SELECT vector_removed.block AS block, vector_blocks.model AS model,
        vector_blocks.reader_set AS reader_set
      FROM vector_removed
      JOIN vector_blocks ON vector_blocks.id = vector_removed.block
      GROUP BY vector_removed.block
      ORDER BY count(*) DESC, vector_removed.block
      LIMIT 1`
    )
    .toArray()
    .at(0);
  if (marked === undefined) {
    return false;
  }
  sql.exec(
    "UPDATE vector_codes SET block = NULL, slot = NULL WHERE block = ?",
    marked.block
  );
  sql.exec("DELETE FROM vector_removed WHERE block = ?", marked.block);
  sql.exec("DELETE FROM vector_blocks WHERE id = ?", marked.block);
  packTail(sql, marked.model, marked.reader_set);
  return sql.exec("SELECT 1 FROM vector_removed LIMIT 1").toArray().length > 0;
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
 */
const blocksSql = `
WITH ${readableSql}
SELECT chunks, bits,
  (SELECT json_group_array(slot) FROM vector_removed
    WHERE vector_removed.block = vector_blocks.id) AS removed
FROM vector_blocks
WHERE model = ?1 AND reader_set IN (SELECT reader_set FROM readable)`;

/** As `blocksSql`: the tail codes of the reader's groups. */
const tailSql = `
WITH ${readableSql}
SELECT chunk, bits FROM vector_codes
WHERE model = ?1 AND block IS NULL
  AND reader_set IN (SELECT reader_set FROM readable)`;

/**
 * As `blocksSql`, and `?4` the candidates' chunks (JSON): each one's
 * 8-bit code and place, if its version is current and the reader may
 * read it. The scan only offered such codes; this checks again, so a code
 * left behind by a fault is dropped before it is ranked, never returned.
 * The candidates come first (`CROSS JOIN` keeps SQLite to that order), so
 * it looks up at most `rescoreCandidates` codes: left to choose, SQLite
 * read every code of the model, 100 ms at 10,000.
 */
const candidatesSql = `
WITH ${readableSql}
SELECT vector_codes.chunk AS chunk, vector_codes.scale AS scale,
  vector_codes.fine AS fine, source_versions.source AS source,
  source_versions.version AS version, chunks.position AS position
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

/** The dot product of two 8-bit codes. */
const dotOf = (a: Int8Array, b: Int8Array): number => {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
};

/**
 * The chunks of current versions `reader` may read whose codes for the
 * model are nearest `vector`, nearest first: the `rescoreCandidates`
 * nearest by Hamming distance over every such code, block by block, then
 * re-scored by their 8-bit codes into a cosine. Ties go to the older
 * chunk. Memory stays at one block and the candidates.
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
  const { person, groups } = reader satisfies Reader;
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
    return { chunks: [] };
  }
  const asked = fineOf(vector);
  const scored = sql
    .exec<{
      chunk: number;
      scale: number;
      fine: ArrayBuffer;
      source: string;
      version: number;
      position: number;
    }>(candidatesSql, stored.id, person, readerJson, JSON.stringify(candidates))
    .toArray()
    .map(({ chunk, scale, fine, source, version, position }) => ({
      chunk,
      found: {
        source,
        version,
        position,
        score: asked.scale * scale * dotOf(asked.fine, new Int8Array(fine)),
      } satisfies FoundChunk,
    }));
  scored.sort((a, b) => b.found.score - a.found.score || a.chunk - b.chunk);
  return { chunks: scored.slice(0, limit).map(({ found }) => found) };
};
