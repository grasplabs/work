import { withinTime } from "@grasp-os/shared/deadline";

import { bucketCallMs } from "./embedding.ts";
import { fileKeyOf } from "./files.ts";
import { WorkError } from "./work-error.ts";
import type { WorkContext } from "./work.ts";

// What the Brain's background work reads of a source's current version:
// whether a version still is it, and its text. Extraction (extraction.ts)
// and the re-check (recheck.ts) each ask both before they write.

/**
 * The version `source` `version`, if it is its source's current one and
 * no erasure is under way of it: its file, and its reader set by key and id.
 */
export const currentOf = (
  sql: SqlStorage,
  source: string,
  version: number
): { file: string; readers: string; readerSet: number } | undefined =>
  sql
    .exec<{ file: string; readers: string; readerSet: number }>(
      `SELECT source_versions.file AS file, reader_sets.key AS readers,
        reader_sets.id AS readerSet
      FROM current_versions
      JOIN source_versions ON source_versions.row = current_versions.version_row
      JOIN reader_sets ON reader_sets.id = source_versions.reader_set
      WHERE current_versions.source = ? AND source_versions.version = ?
        AND source_versions.row NOT IN (SELECT version_row FROM erasing_versions)`,
      source,
      version
    )
    .toArray()
    .at(0);

/** The text of `file`, or null when it is gone: within the bucket's time and the item's. */
export const textOf = async (
  { bucket, signal }: WorkContext,
  file: string
): Promise<string | null> => {
  try {
    return await withinTime(
      async () => {
        const object = await bucket.get(fileKeyOf(file));
        return object === null ? null : await object.text();
      },
      bucketCallMs,
      signal
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new WorkError("timed_out");
    }
    throw error;
  }
};
