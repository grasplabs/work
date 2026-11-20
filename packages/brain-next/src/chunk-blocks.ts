// Where a set of readers' chunks are kept: blocks of rows (`chunk_blocks`,
// migration 0026), so recall can ask the word index for a word only
// within the reader's own blocks. The index's lookup of a word, bounded
// to rows from one to another, lists only the chunks between them, and
// workerd counts only what it lists; unbounded, it lists every chunk that
// holds the word, also the ones the reader may not read, which each cost
// the joins up to the reader's check before they are dropped. So with
// each set's chunks in blocks of their own, a chunk the reader may not
// read costs a recall nothing, and what it reads grows with the reader's
// blocks and what they hold, never with anyone else's.
//
// A block only narrows where recall looks: the reader's check stays in
// every statement (recall.ts `searched`), so a chunk in a block it
// shouldn't be in is still never returned to a reader who may not read
// it; a chunk outside its set's blocks would only be missed, which the
// trigger of migration 0026 rules out for every add, by any release.

/**
 * Rows a block holds: block n is rows n × this to (n + 1) × this - 1. Set
 * in migration 0026's trigger too, and fixed with it. A version of the
 * largest source (`sourceTextMaxBytes`, 1 MB) has fewer chunks than this,
 * so one fits in a block; rows stay below 2^53 (exact in JavaScript and
 * as float64s in the vector blocks) for 2^33 blocks.
 */
export const chunkBlockRows = 1_048_576;

/**
 * The first row for `count` chunks of a version read by `readerSet`, to
 * be written at it and the rows after it: after the last chunk in the
 * set's newest block, when they fit there; else at the start of a block
 * never taken before, above every block and every chunk, so it holds the
 * set's chunks alone. Never in block 0: it holds the chunks of stores
 * made before the blocks, of every set, so a new store's first block is 1. Call it in the transaction
 * that writes the chunks. (A row freed by a delete at the end of a block
 * may be taken again, as a row after the last one was before.)
 */
export const placeChunks = (
  sql: SqlStorage,
  readerSet: number,
  count: number
): number =>
  sql
    .exec<{ start: number }>(
      `WITH own AS (
        SELECT max(block) AS block FROM chunk_blocks WHERE reader_set = ?1
      ),
      next AS (
        SELECT coalesce(
          (SELECT max(row) + 1 FROM chunks
            WHERE row BETWEEN own.block * ?2 AND own.block * ?2 + ?2 - 1),
          own.block * ?2
        ) AS row, own.block AS block
        FROM own
      ),
      top AS (
        SELECT max(
          coalesce((SELECT max(block) FROM chunk_blocks), 0),
          coalesce((SELECT max(row) FROM chunks), 0) / ?2
        ) + 1 AS block
      )
      SELECT CASE
        WHEN next.block > 0 AND next.row + ?3 <= (next.block + 1) * ?2
          THEN next.row
        ELSE top.block * ?2
      END AS start
      FROM next, top`,
      readerSet,
      chunkBlockRows,
      count
    )
    .one().start;

/**
 * The blocks of the sets of readers the reader is in, each once, as a
 * common table `blocks` of their first and last rows, for a statement
 * that holds `readable` (reader-sets.ts `readableSql`). Each once: a
 * block of stores made before the blocks may hold several sets' chunks.
 */
export const blocksSql = `blocks AS MATERIALIZED (
  SELECT DISTINCT block * ${chunkBlockRows} AS first,
    block * ${chunkBlockRows} + ${chunkBlockRows - 1} AS last
  FROM chunk_blocks
  WHERE reader_set IN (SELECT reader_set FROM readable)
)`;
