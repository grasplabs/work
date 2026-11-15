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
// older one's item. It reads the version's text and judges every memory
// drawn from an earlier version: one whose quote the text no longer
// holds, word for word as extraction checks a quote (quotes.ts), is
// recorded as out against that version (`memory_rechecks`). In code,
// never by a model, so text in the source can neither keep a memory
// alive nor put one out.
//
// Its judgments count once it has finished: its last page marks the
// version re-checked (`memory_rechecked`), in the transaction of its own
// judgments, and only the judgments of the latest version so marked count (memories.ts `judgedAtSql`), for readers of
// that version. Until then the judgments of the version re-checked
// before count as they did, for its readers: a memory out stays out while
// a newer version waits for its turn, and a reader who may not read the
// version judged against is answered as by a store that never held it.
// The memory itself is never written: `retired_at` stays its writer's.
//
// A page of the source's memories a run, in the order they were added
// (`memories_source_idx`), the next page put back on the queue
// (`WorkContext.again`), so no step grows with the source's history: each
// reads at most `recheckPage` memories and the version's text once,
// indexed. A memory added while it runs comes after where it is, so it
// reaches it; its last page asks again, in its transaction, that none is
// left behind it. It asks no model.

/**
 * The most memories one run reads: what bounds a step, never what is
 * judged, as the next page follows on the queue.
 */
export const recheckPage = 500;

/** What an item carries: the source, the version judged against, and the last memory read (its row). */
const payloadSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  after: z.int().positive().optional(),
});
type Payload = z.infer<typeof payloadSchema>;

/** A memory of a page: its row, version and quote. */
interface Held extends Record<string, SqlStorageValue> {
  row: number;
  version: number;
  quote: string | null;
}

/** `?1` the source, `?2` the last row read, `?3` the page's size: its next memories, in order. */
const pageSql = `
SELECT row, version, quote FROM memories
WHERE source = ?1 AND row > ?2
ORDER BY row
LIMIT ?3`;

/** What a page asks `judge` to write. */
interface Judging {
  source: string;
  version: number;
  /** The memories it found out. */
  rows: readonly number[];
  /** Whether the page read the source's last memory. */
  last: boolean;
  /** The last row it read. */
  through: number;
}

/**
 * Records `rows` out against `version`, and, on the last page, the source
 * re-checked through it, in one transaction that first asks again whether
 * `version` is still current and not being erased, so nothing is judged
 * against a text a newer version or an erasure replaced while it was
 * read; and, on the last page, whether a memory of an earlier version was
 * added past `through` since, which makes it a page like any other.
 * "superseded" when the version no longer is current, written nothing;
 * "marked" once the source is marked; else "judged". All at one stamp
 * (`stampWrite`); a judgment or a mark recorded already stays as it
 * was, and the latest mark of a source is its highest, so it never goes
 * back.
 */
const judge = (
  storage: DurableObjectStorage,
  { source, version, rows, last, through }: Judging
): "marked" | "judged" | "superseded" =>
  storage.transactionSync(() => {
    const { sql } = storage;
    if (currentOf(sql, source, version) === undefined) {
      return "superseded";
    }
    // A restore under way writes nothing meanwhile: the queue tries again.
    if (isRestoring(sql)) {
      throw new WorkError("restoring");
    }
    const finished =
      last &&
      sql
        .exec(
          // From the last row read on (`memories_source_idx`): `+` keeps
          // the planner off the version's index, which would read every
          // earlier memory of the source.
          `SELECT 1 FROM memories
          WHERE source = ? AND row > ? AND +version < ? LIMIT 1`,
          source,
          through,
          version
        )
        .toArray().length === 0;
    if (rows.length === 0 && !finished) {
      return "judged";
    }
    const stamp = stampWrite(sql);
    // Each row checked again in the same statement: still of this source,
    // before this version. Sought by its row, one each (CROSS JOIN keeps
    // the planner from walking the source's memories instead).
    sql.exec(
      `INSERT OR IGNORE INTO memory_rechecks (memory, source, version, subject, at)
      SELECT m.row, m.source, ?3, m.subject, ?4 FROM json_each(?1) AS listed
      CROSS JOIN memories AS m ON m.row = listed.value
      WHERE m.source = ?2 AND m.version < ?3`,
      JSON.stringify(rows),
      source,
      version,
      stamp
    );
    if (!finished) {
      return "judged";
    }
    sql.exec(
      `INSERT OR IGNORE INTO memory_rechecked (source, through, subject, at)
      SELECT ?1, ?2, subject, ?3 FROM source_subjects WHERE source = ?1`,
      source,
      version,
      stamp
    );
    return "marked";
  });

const recheckWork: WorkDefinition<Payload> = defineWork({
  kind: "recheck",
  payload: payloadSchema,
  run: async (payload, context) => {
    const { source, version, after = 0 } = payload;
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
    const page = sql.exec<Held>(pageSql, source, after, recheckPage).toArray();
    const judged = page.flatMap(({ row, quote, version: of }) =>
      of < version && quote !== null ? [{ row, quote }] : []
    );
    let out: number[] = [];
    if (judged.length > 0) {
      const text = await textOf(context, found.file);
      // The current version's file gone: what it works on can't be read.
      if (text === null) {
        throw new WorkError("unreadable");
      }
      const index = quoteIndexOf(text);
      out = judged.flatMap(({ row, quote }) =>
        index.holds(quote) ? [] : [row]
      );
    }
    const through = page.at(-1)?.row ?? after;
    const outcome = judge(storage, {
      source,
      version,
      rows: out,
      last: page.length < recheckPage,
      through,
    });
    if (outcome === "superseded") {
      log.info("brain.recheck_superseded", { version });
      return;
    }
    // One event a page: counts alone, nothing of the text.
    log.info("brain.recheck", {
      version,
      read: page.length,
      checked: judged.length,
      out: out.length,
    });
    if (outcome === "judged") {
      context.keep({ source, version, after: through });
      context.again(1);
    }
  },
});

/** Whether an item of `source` waits or runs for `version` already. */
const queuedFor = (sql: SqlStorage, source: string, version: number): boolean =>
  sql
    .exec<{ payload: string }>(
      "SELECT payload FROM work_items WHERE kind = ? AND key = ?",
      recheckWork.kind,
      source
    )
    .toArray()
    .some(
      ({ payload }) =>
        payloadSchema.safeParse(JSON.parse(payload)).data?.version === version
    );

/**
 * Puts `source`'s memories on the queue to be checked against its version
 * `version`, now current, when it holds a memory drawn from an earlier
 * version: in place of an item of the source still waiting for another
 * version, and never over one that waits or runs for this one, which keeps
 * its place and reaches every memory added since. Run it in the
 * transaction that makes the version current, adds such a memory, or
 * restores one.
 */
export const enqueueRecheck = (
  storage: DurableObjectStorage,
  source: SourceId,
  version: number
): void => {
  const { sql } = storage;
  const drawnBefore =
    sql
      .exec(
        "SELECT 1 FROM memories WHERE source = ? AND version < ? LIMIT 1",
        source,
        version
      )
      .toArray().length > 0;
  if (drawnBefore && !queuedFor(sql, source, version)) {
    enqueueWork(storage, recheckWork, {
      key: source,
      payload: { source, version },
      priority: "recent",
    });
  }
};
