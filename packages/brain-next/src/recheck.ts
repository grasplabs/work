import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { sourceIdSchema, versionSchema } from "./contract.ts";
import type { SourceId } from "./contract.ts";
import { currentOf, isQuoted, textOf, wordsSeen } from "./extraction.ts";
import { stampWrite } from "./memories.ts";
import { isRestoring } from "./restoring.ts";
import { defineWork, enqueueWork, WorkError } from "./work.ts";
import type { WorkDefinition } from "./work.ts";

// Re-checking memories when their source changes (the plan, "Dreaming"):
// an item of the work queue per source, keyed by it, put on the queue as
// a newer version becomes current, so a newer version waiting replaces an
// older one's item. It reads the version's text and retires every memory
// drawn from an earlier version whose quote the text no longer holds,
// word for word as extraction checks a quote (extraction.ts `isQuoted`):
// in code, never by a model, so text in the source can neither keep a
// memory alive nor retire one. A memory whose quote still stands stays
// as it is; one a newer version drawn from ends anyway, once that
// version is extracted (its `extracted` mark).
//
// Retired as its writer would retire it (memories.ts `retiredSql`): it
// stays history, current as of any moment before, and gives nothing to
// any other read. Who sees that is no one new: a memory drawn from a
// source is read only by readers of the source's current version, the
// very text it was judged against. Nothing is written but the moment it
// was retired, once.
//
// It asks no model, so it takes nothing from the model's rate limit, and
// it reads only the memories of its own source (`memories_version_idx`),
// never the store.

/** What an item carries: the source, and the version its memories are checked against. */
const payloadSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
});
type Payload = z.infer<typeof payloadSchema>;

/** A memory drawn from an earlier version, not retired: its row and its quote. */
interface Held extends Record<string, SqlStorageValue> {
  row: number;
  quote: string;
}

/** The memories of `source` drawn from a version before `version`, not retired. */
const heldBefore = (sql: SqlStorage, source: string, version: number): Held[] =>
  sql
    .exec<Held>(
      `SELECT row, quote FROM memories
      WHERE source = ? AND version < ? AND retired_at IS NULL
        AND quote IS NOT NULL`,
      source,
      version
    )
    .toArray();

/**
 * Retires the memories `rows` of `source` from before `version`, in one
 * transaction that first asks again whether `version` is still current
 * and not being erased: so nothing is retired against a text a newer
 * version, or an erasure, replaced while it was read. "superseded" when
 * it no longer is, written nothing; else how many it retired, all at one
 * stamp (`stampWrite`).
 */
const retire = (
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
    // before this version, and not retired.
    return sql
      .exec(
        `UPDATE memories SET retired_at = ?1
        WHERE row IN (SELECT value FROM json_each(?2))
          AND source = ?3 AND version < ?4 AND retired_at IS NULL
        RETURNING row`,
        stampWrite(sql),
        JSON.stringify(rows),
        source,
        version
      )
      .toArray().length;
  });

const recheckWork: WorkDefinition<Payload> = defineWork({
  kind: "recheck",
  payload: payloadSchema,
  run: async ({ source, version }, context) => {
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
    const held = heldBefore(sql, source, version);
    if (held.length === 0) {
      return;
    }
    const text = await textOf(context, found.file);
    if (text === null) {
      return;
    }
    const seen = { words: wordsSeen(text) };
    const gone = held.flatMap(({ row, quote }) =>
      isQuoted(seen, quote) ? [] : [row]
    );
    const retired = retire(storage, source, version, gone);
    if (retired === "superseded") {
      log.info("brain.recheck_superseded", { version });
      return;
    }
    // One event for the item: counts alone, nothing of the text.
    log.info("brain.recheck", { version, checked: held.length, retired });
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
