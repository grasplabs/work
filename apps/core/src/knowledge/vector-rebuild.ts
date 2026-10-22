/**
 * The contract of rebuilding a vector index generation (vector-index.ts):
 * how a new model, revision or serving route replaces the generation
 * semantic recall reads, and how a broken index is recovered or exported.
 * The index is a projection of canonical D1 and R2 records, so a rebuild
 * never reads the old index, only those records.
 *
 * The rebuild is a workflow, in these phases, in order:
 *
 * 1. `create`: the provider creates the new generation.
 * 2. `fill`: each canonical record the index covers is read, embedded
 *    through the model gateway with the generation's model, revision and
 *    route, and upserted with its content hash as its source version.
 *    Each record is one idempotent step, keyed by {@link fillStepKey}: a
 *    replayed or retried step embeds and writes the same thing again.
 * 3. `reconcile`: {@link reconcileGeneration} compares what the index
 *    lists with the canonical records. Missing and stale records go back
 *    to `fill`, extra ones are deleted, until nothing is left.
 * 4. `verify`: {@link VectorIndex.status} must report the generation and
 *    `filtering: "working"`.
 * 5. `recall`: a fixed set of queries runs against both generations; the
 *    new one must find what the old one did, within the agreed margin.
 * 6. `switch`: the active generation pointer moves to the new one. The old
 *    generation stays, so switching back is the rollback.
 * 7. `retire`: once rollback isn't needed, the provider drops the old
 *    generation.
 *
 * A failed phase leaves the active pointer where it was: readers never see
 * a generation that hasn't passed `verify` and `recall`.
 */
import { sha256Hex } from "@grasp-os/shared/encoding";

import type { VectorGeneration, VectorIndex } from "./vector-index.ts";

export const rebuildPhases = [
  "create",
  "fill",
  "reconcile",
  "verify",
  "recall",
  "switch",
  "retire",
] as const;

export type RebuildPhase = (typeof rebuildPhases)[number];

/** A rebuild under way: what it builds, and what it replaces. */
export interface VectorRebuild {
  target: VectorGeneration;
  /** The active generation when it started: where a rollback returns. */
  previous: string | undefined;
  phase: RebuildPhase;
}

/**
 * The idempotency key of filling one record into a generation: the same
 * for the same content, another when the record changed.
 */
export const fillStepKey = async (
  generation: VectorGeneration,
  recordId: string,
  contentHash: string
): Promise<string> =>
  await sha256Hex(JSON.stringify([generation.id, recordId, contentHash]));

/** How an index differs from its canonical records. */
export interface Reconciliation {
  /** Canonical records the index doesn't list. */
  missing: string[];
  /**
   * Records the index lists at another source version, or damaged
   * (listed without one): filling them again replaces them.
   */
  stale: string[];
  /**
   * Records the index lists that no canonical record has, damaged ones
   * included: they are deleted.
   */
  extra: string[];
}

/**
 * Compares every record `index` lists with `canonical`, each record's ID
 * and the source version it should be indexed at.
 */
export const reconcileGeneration = async (
  index: VectorIndex,
  canonical: ReadonlyMap<string, string>
): Promise<Reconciliation> => {
  const listed = new Set<string>();
  const stale: string[] = [];
  const extra: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page names where the next starts
    const page = await index.ids(cursor);
    for (const { id, sourceVersion } of page.entries) {
      listed.add(id);
      const expected = canonical.get(id);
      if (expected === undefined) {
        extra.push(id);
      } else if (expected !== sourceVersion) {
        stale.push(id);
      }
    }
    ({ cursor } = page);
  } while (cursor !== undefined);
  const missing = [...canonical.keys()].filter((id) => !listed.has(id));
  return { missing, stale, extra };
};
