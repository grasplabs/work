import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { versionSchema } from "./contract.ts";
import type { SourceId } from "./contract.ts";
import { textOf } from "./current.ts";
import { stampWrite } from "./memories.ts";
import { quoteIndexOf } from "./quotes.ts";
import { isRestoring } from "./restoring.ts";
import { defineWork, enqueueWork, WorkError } from "./work.ts";
import type { WorkDefinition } from "./work.ts";

// Re-checking memories when their source changes (the plan, "Dreaming"):
// an item of the work queue per source and set of readers of its versions
// (`keyOf`), put on the queue as a newer version is added, so a newer
// version for the same readers waiting replaces an older one's item, and
// one for other readers leaves it be: each set of readers gets the
// re-check of the latest version it may read, as in a store without the
// versions it may not. It reads the version's text and judges every memory
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

/** A SHA-256, in hex, as the store keeps a source's (`source_subjects`). */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * What an item carries: its source by its SHA-256 (`source_subjects`), so
 * no source's key is kept with work, the version judged against, and the
 * last memory read (its row). A source's erasure takes its items
 * (`dropRechecksOf`), and its SHA-256 with its last version, so an item
 * left from before finds nothing.
 */
const payloadSchema = z.strictObject({
  subject: sha256Schema,
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

/**
 * The version `version` of `source` as a re-check judges against it: its
 * file and its set of readers (`reader_sets.id`), while it is the latest
 * version of its source for those readers and no erasure is under way of
 * it; else undefined, and a newer version for the same readers has its
 * own item. A newer version for other readers leaves it to be judged, so
 * each set of readers gets the re-check of the latest version it may read
 * (memories.ts `judgedAtSql`), whatever versions for others came after:
 * as in a store without those.
 */
const judgedVersionOf = (
  sql: SqlStorage,
  source: string,
  version: number
): { file: string; readerSet: number } | undefined =>
  sql
    .exec<{ file: string; readerSet: number }>(
      `SELECT judging.file AS file, judging.reader_set AS readerSet
      FROM source_versions AS judging
      WHERE judging.source = ?1 AND judging.version = ?2
        AND judging.row NOT IN (SELECT version_row FROM erasing_versions)
        AND NOT EXISTS (
          SELECT 1 FROM source_versions AS later
          WHERE later.source = ?1 AND later.version > ?2
            AND later.reader_set = judging.reader_set
        )`,
      source,
      version
    )
    .toArray()
    .at(0);

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
    if (judgedVersionOf(sql, source, version) === undefined) {
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
    const { subject, version, after = 0 } = payload;
    const { storage } = context;
    const { sql } = storage;
    const [named] = sql
      .exec<{ source: string }>(
        "SELECT source FROM source_subjects WHERE subject = ?",
        subject
      )
      .toArray();
    // Its source erased: done.
    if (named === undefined) {
      return;
    }
    const { source } = named;
    const found = judgedVersionOf(sql, source, version);
    // Gone, replaced for its readers or being erased: done.
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
      context.keep({ subject, version, after: through });
      context.again(1);
    }
  },
});

/**
 * The key of the item that re-checks `source`'s memories against
 * `version`: one per source and set of readers of its versions, so a
 * newer version for other readers never takes the place of one waiting.
 * The source by its SHA-256 (`source_subjects`) and the set by its id:
 * staff see keys, never what they name. None for a version not stored.
 */
const keyOf = (
  sql: SqlStorage,
  source: string,
  version: number
): { key: string; subject: string } | undefined => {
  const [found] = sql
    .exec<{ subject: string; readerSet: number }>(
      `SELECT source_subjects.subject AS subject,
        source_versions.reader_set AS readerSet
      FROM source_versions
      JOIN source_subjects ON source_subjects.source = source_versions.source
      WHERE source_versions.source = ? AND source_versions.version = ?`,
      source,
      version
    )
    .toArray();
  return found === undefined
    ? undefined
    : { key: `${found.subject}:${found.readerSet}`, subject: found.subject };
};

/**
 * Deletes every re-check item of `source`, waiting, parked or running
 * (`keyOf`: the keys from its SHA-256 and `:` on): what a source's
 * erasure takes of its work (erasure.ts `hideVersions`), in the caller's
 * transaction. Answers their keys, for what runs to stop. Two seeks of a
 * range of keys, one on each of the queue's indexes of a kind and key,
 * each partial on `running`. None when the source has no SHA-256 kept.
 */
export const dropRechecksOf = (sql: SqlStorage, source: string): string[] => {
  const [named] = sql
    .exec<{ subject: string }>(
      "SELECT subject FROM source_subjects WHERE source = ?",
      source
    )
    .toArray();
  if (named === undefined) {
    return [];
  }
  // `running` written out, not bound: a partial index is taken only for a
  // statement that says its condition.
  return ["running = 0", "running = 1"].flatMap((running) =>
    sql
      .exec<{ key: string }>(
        `DELETE FROM work_items
        WHERE kind = ?1 AND key >= ?2 || ':' AND key < ?2 || ';' AND ${running}
        RETURNING key`,
        recheckWork.kind,
        named.subject
      )
      .toArray()
      .map(({ key }) => key)
  );
};

/** Whether the item `key` waits or runs for `version` already. */
const queuedFor = (sql: SqlStorage, key: string, version: number): boolean =>
  sql
    // Two seeks, waiting and running: each of the queue's indexes on a
    // kind and key is partial on `running` (`work_items_waiting_key`,
    // `work_items_running_idx`), so one statement for both reads the queue.
    .exec<{ payload: string }>(
      `SELECT payload FROM work_items WHERE kind = ?1 AND key = ?2 AND running = 0
      UNION ALL
      SELECT payload FROM work_items WHERE kind = ?1 AND key = ?2 AND running = 1`,
      recheckWork.kind,
      key
    )
    .toArray()
    .some(
      ({ payload }) =>
        payloadSchema.safeParse(JSON.parse(payload)).data?.version === version
    );

/**
 * Puts `source`'s memories on the queue to be checked against its version
 * `version`, when it holds a memory drawn from an earlier version: in
 * place of an item still waiting for an earlier version for the same
 * readers (`keyOf`), and never over one that waits or runs for this one,
 * which keeps its place and reaches every memory added since. Run it in
 * the transaction that adds the version, adds such a memory, or restores
 * one.
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
  const keyed = keyOf(sql, source, version);
  if (
    drawnBefore &&
    keyed !== undefined &&
    !queuedFor(sql, keyed.key, version)
  ) {
    enqueueWork(storage, recheckWork, {
      key: keyed.key,
      payload: { subject: keyed.subject, version },
      priority: "recent",
    });
  }
};
