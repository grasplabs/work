import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { sourceIdSchema, versionSchema } from "./contract.ts";
import type { SourceId } from "./contract.ts";
import { currentOf, textOf } from "./current.ts";
import { stampWrite } from "./memories.ts";
import { quoteIndexOf } from "./quotes.ts";
import { isRestoring } from "./restoring.ts";
import { defineWork, enqueueWork, WorkError } from "./work.ts";
import type { WorkDefinition } from "./work.ts";

// Re-checking memories when their source changes (the plan, "Dreaming"):
// an item of the work queue per source, keyed by it, put on the queue as
// a newer version becomes current, so a newer version waiting replaces an
// older one's item. It reads the version's text and judges each memory
// drawn from an earlier version: one whose quote the text no longer
// holds, word for word as extraction checks a quote (quotes.ts), is
// recorded as out against that version (`memory_rechecks`). In code,
// never by a model, so text in the source can neither keep a memory
// alive nor put one out.
//
// A judgment is the version's, not the memory's: it counts only while
// that version is its source's current one, for those who may read it
// (memories.ts `outSql`), and then the memory is read as a retired one
// is: history, and nothing to any other read. So a version that says the
// quote again brings the memory back, and a reader who may not read the
// version judged against is answered as by a store that never held it.
// The memory itself is never written: `retired_at` stays its writer's.
//
// A page of memories a run, in their order (version, then row), the next
// page put back on the queue (`WorkContext.again`), so no step grows with
// the source's history: each reads the version's text once, indexed, and
// at most `recheckPage` memories. Memories a later version's extraction
// mark already ends for everyone who may read them are passed over: they
// are history whatever the text says. It asks no model, so it takes
// nothing from the model's rate limit, and it reads only the memories of
// its own source (`memories_version_idx`), never the store.

/**
 * The most memories one run judges: what bounds a step, never what is
 * judged, as the next page follows on the queue.
 */
export const recheckPage = 500;

/** What an item carries: the source, the version judged against, and where the last page ended. */
const payloadSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  after: z
    .strictObject({ version: versionSchema, row: z.int().positive() })
    .optional(),
});
type Payload = z.infer<typeof payloadSchema>;

/** A memory of a page: its row, version, quote and readers (`reader_sets.key`). */
interface Held extends Record<string, SqlStorageValue> {
  row: number;
  version: number;
  quote: string | null;
  readers: string;
}

/**
 * `?1` the source, `?2` the version judged against, `?3` and `?4` where
 * the last page ended (version, row), `?5` the page's size: the source's
 * memories of earlier versions after that place, in order, at most `?5`,
 * in two exact seeks of `memories_version_idx` (source, version, row):
 * the rest of the version the last page ended in, then the versions
 * after it. One seek of a row value reads that version's rows from its
 * start.
 */
const pageSql = [
  `SELECT row, version, quote, readers FROM memories
  WHERE source = ?1 AND version = ?3 AND row > ?4 AND version < ?2
  ORDER BY row
  LIMIT ?5`,
  `SELECT row, version, quote, readers FROM memories
  WHERE source = ?1 AND version > ?3 AND version < ?2
  ORDER BY version, row
  LIMIT ?5`,
];

/**
 * `?1` the source, `?2` the version judged against and `?3` its set of
 * readers (`reader_sets.id`), `?4` a memory's readers (`reader_sets.key`):
 * the latest version up to `?2`, not under erasure and of exactly the
 * judged version's readers, marked extracted for exactly those (memories.ts
 * `extractedSql`). It ends every memory of those readers drawn from an
 * earlier version, for every reader who may read it now, so they are
 * passed over. Read from the latest down: the first that holds.
 */
const markedSql = `
SELECT marked.version AS version FROM memory_extractions AS marked
CROSS JOIN source_versions AS extracted
  ON extracted.source = marked.source AND extracted.version = marked.version
WHERE marked.source = ?1 AND marked.version <= ?2 AND marked.readers = ?4
  AND extracted.reader_set = ?3
  AND extracted.row NOT IN (SELECT version_row FROM erasing_versions)
ORDER BY marked.version DESC
LIMIT 1`;

/**
 * Records the memories `rows` of `source` out against `version`, in one
 * transaction that first asks again whether `version` is still current
 * and not being erased: so nothing is judged against a text a newer
 * version, or an erasure, replaced while it was read. "superseded" when
 * it no longer is, written nothing; else how many it recorded, all at one
 * stamp (`stampWrite`). A judgment recorded already stays as it was.
 */
const judge = (
  storage: DurableObjectStorage,
  source: string,
  version: number,
  rows: readonly number[]
): number | "superseded" =>
  storage.transactionSync(() => {
    const { sql } = storage;
    if (currentOf(sql, source, version) === undefined) {
      return "superseded";
    }
    // A restore under way writes nothing meanwhile: the queue tries again.
    if (isRestoring(sql)) {
      throw new WorkError("restoring");
    }
    if (rows.length === 0) {
      return 0;
    }
    // Each row checked again in the same statement: still of this source,
    // before this version.
    return sql
      .exec(
        `INSERT OR IGNORE INTO memory_rechecks (memory, source, version, subject, at)
        SELECT m.row, m.source, ?3, m.subject, ?4 FROM memories AS m
        WHERE m.row IN (SELECT value FROM json_each(?1))
          AND m.source = ?2 AND m.version < ?3
        RETURNING memory`,
        JSON.stringify(rows),
        source,
        version,
        stampWrite(sql)
      )
      .toArray().length;
  });

const recheckWork: WorkDefinition<Payload> = defineWork({
  kind: "recheck",
  payload: payloadSchema,
  run: async (payload, context) => {
    const { source, version, after } = payload;
    const { storage } = context;
    const { sql } = storage;
    const found = currentOf(sql, source, version);
    // Gone, replaced or being erased: done.
    if (found === undefined) {
      return;
    }
    if (isRestoring(sql)) {
      throw new WorkError("restoring");
    }
    const page: Held[] = [];
    for (const statement of pageSql) {
      page.push(
        ...sql
          .exec<Held>(
            statement,
            source,
            version,
            after?.version ?? 0,
            after?.row ?? 0,
            recheckPage - page.length
          )
          .toArray()
      );
    }
    // The latest extraction mark of each set of readers the page holds:
    // a memory of an earlier version is history already.
    const marked = new Map<string, number>();
    for (const readers of new Set(page.map((held) => held.readers))) {
      const [latest] = sql
        .exec<{ version: number }>(
          markedSql,
          source,
          version,
          found.readerSet,
          readers
        )
        .toArray();
      marked.set(readers, latest?.version ?? 0);
    }
    const judged = page.flatMap(({ row, quote, readers, version: of }) =>
      quote !== null && of >= (marked.get(readers) ?? 0) ? [{ row, quote }] : []
    );
    let out: number | "superseded" = 0;
    if (judged.length > 0) {
      const text = await textOf(context, found.file);
      if (text === null) {
        return;
      }
      const index = quoteIndexOf(text);
      out = judge(
        storage,
        source,
        version,
        judged.flatMap(({ row, quote }) => (index.holds(quote) ? [] : [row]))
      );
    }
    if (out === "superseded") {
      log.info("brain.recheck_superseded", { version });
      return;
    }
    // One event a page: counts alone, nothing of the text.
    log.info("brain.recheck", {
      version,
      read: page.length,
      checked: judged.length,
      out,
    });
    const last = page.at(-1);
    if (page.length === recheckPage && last !== undefined) {
      context.keep({
        source,
        version,
        after: { version: last.version, row: last.row },
      });
      context.again(1);
    }
  },
});

/**
 * Puts `source`'s memories on the queue to be checked against its version
 * `version`, now current, in place of an item of the source still
 * waiting, when it holds a memory drawn from an earlier version. Run it in
 * the transaction that makes the version current.
 */
export const enqueueRecheck = (
  storage: DurableObjectStorage,
  source: SourceId,
  version: number
): void => {
  const drawnBefore =
    storage.sql
      .exec(
        "SELECT 1 FROM memories WHERE source = ? AND version < ? LIMIT 1",
        source,
        version
      )
      .toArray().length > 0;
  if (drawnBefore) {
    enqueueWork(storage, recheckWork, {
      key: source,
      payload: { source, version },
      priority: "recent",
    });
  }
};
