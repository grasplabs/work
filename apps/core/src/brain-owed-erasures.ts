import { log } from "@grasp-os/shared/log";

import { eraseSources } from "./brain-next-origins.ts";
import type { eraseSource, SourceReaders, SourceRef } from "./brain-next.ts";

// The erasures core owes the Brain of what a company export can hold
// (GRA-1848), in one place. A producer keeps its own record of an erasure
// it asked for until the Brain's call returned (a row left unmarked):
// only a call that returned is in the Brain's ledger. Until then what it
// covers can still be read, and so written into a company export and
// downloaded. So an export starts, and each of its files with content is
// answered, only once none of it is owed (brain-next-exports.ts).
//
// Only sources more than one person may read count: a company export
// leaves out what one person alone may read (`owner`), which is kept in
// their own store, and no company export reads that. So the rule follows
// from the readers each erasure is made with, never from a producer's own
// judgement, and an erasure owed of one person's content (a run past its
// retention, a person's erasure) holds up no export.
//
// - Every producer that can owe the Brain an erasure of such a source
//   lists it in `owedErasureLists`, filtered to those readers in its own
//   query, with the readers its producer adds the source with. None does
//   on main yet: a run's source and a person's own content are one
//   person's. The first will be a team's uploads (#2203) and an
//   interview's team claims (#2206).
// - `settleOwedErasures` makes those calls now, and answers whether any
//   is still owed. It never marks a producer's own record: the producer's
//   next run asks the Brain again, which is safe (a source erased before
//   is not recorded again), and marks it. An erasure made here is
//   recorded in the Brain's ledger, as the producer's own would be, not in
//   core's audit log.
// - A call whose reply was lost counts as failed: owed, so refused, until
//   the next settle or the producer's own retry returns.

/** Readers that are not one person alone: what a company export can hold. */
type SharedReaders = Exclude<SourceReaders, { kind: "owner" }>;

/** Why an erasure is made, as the Brain's ledger records it. */
type ErasureReason = Parameters<typeof eraseSource>[1]["reason"];

/** One erasure of a source core owes the Brain, as its producer would make it. */
export interface OwedErasure {
  source: SourceRef;
  readers: SharedReaders;
  reason: ErasureReason;
}

/** A producer's list of what it owes the Brain at `now`, at most `limit`. */
export type OwedErasureList = (
  env: Env,
  now: Date,
  limit: number
) => Promise<OwedErasure[]>;

/** Every producer that can owe the Brain an erasure a company export can hold. */
export const owedErasureLists: readonly OwedErasureList[] = [];

/**
 * Most erasures one settle makes: half the 1,000 subrequests a Worker's
 * request may make, at one call to the shared store each (no person's own
 * store holds a source others read), so the request it runs in keeps the
 * rest. More owed than that answers `owed` before any call, and the
 * producers' own clock runs work it down.
 */
export const owedErasuresMax = 500;

/**
 * Makes every erasure `lists` owe now, a few at a time, and answers
 * `settled` once every one returned, or `owed` when one failed (none
 * after its few are made) or more were owed than one settle makes
 * ({@link owedErasuresMax}), in which case none is made: they could not
 * change the answer.
 */
export const settleOwedErasures = async (
  env: Env,
  now: Date,
  lists: readonly OwedErasureList[]
): Promise<"settled" | "owed"> => {
  const owed: OwedErasure[] = [];
  for (const list of lists) {
    // oxlint-disable-next-line no-await-in-loop -- one producer after another, within the room left
    owed.push(...(await list(env, now, owedErasuresMax + 1 - owed.length)));
    if (owed.length > owedErasuresMax) {
      log.warn("brain.erasures_owed", {});
      return "owed";
    }
  }
  try {
    for (const reason of new Set(owed.map((each) => each.reason))) {
      // oxlint-disable-next-line no-await-in-loop -- one reason after another
      await eraseSources(
        env,
        owed.filter((each) => each.reason === reason),
        reason
      );
    }
  } catch {
    // A fixed name alone: what is owed names sources.
    log.warn("brain.erasures_owed", {});
    return "owed";
  }
  return "settled";
};
