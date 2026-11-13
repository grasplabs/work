import { log } from "@grasp-os/shared/log";

import { erasePerson, eraseSource } from "./brain-next.ts";
import type { SourceReaders, SourceRef } from "./brain-next.ts";
import { owedPersonErasures } from "./person-erasure.ts";
import { owedRunErasures } from "./workflows/retention.ts";

// The erasures core owes the Brain (GRA-1848), in one place. Each producer
// keeps its own record of an erasure it asked for until the Brain's call
// returned (a run's receipt left unmarked, a person's erasure area left
// pending): only a call that returned is in the Brain's ledger. Until then
// what it covers can still be read, and so written into a company export
// and downloaded. So an export starts, and each of its files is answered,
// only once nothing is owed (brain-next-exports.ts), and this file is
// where "what is owed" is known:
//
// - Every producer that can owe the Brain an erasure lists what it owes
//   now in `owing`, as the Brain calls that settle it. A new kind of
//   erasure (an upload's deletion once uploads are handed over, an
//   interview's) adds its list here, or exports can serve what it owes.
// - `settleOwedErasures` makes those calls now, and answers whether
//   anything is still owed. It never marks a producer's own record: the
//   producer's next run asks the Brain again, which is safe, and marks
//   it. An erasure is settled once its call returned, whatever it was owed
//   for: that is when the Brain's ledger has it, and from then on the
//   store serves none of it and every export holding it is stale.
// - A call whose reply was lost counts as failed: owed, so refused, until
//   the next settle or the producer's own retry returns.

/** Why an erasure is made, as the Brain's ledger records it. */
type ErasureReason = Parameters<typeof eraseSource>[1]["reason"];

/** One Brain call core owes, as its producer would make it. */
export type OwedErasure =
  | {
      kind: "source";
      source: SourceRef;
      readers: SourceReaders;
      reason: ErasureReason;
    }
  | { kind: "person"; personId: string; reason: ErasureReason };

/** A producer's list of what it owes the Brain at `now`, at most `limit`. */
type OwedList = (env: Env, now: Date, limit: number) => Promise<OwedErasure[]>;

/** Every producer that can owe the Brain an erasure. */
const owing: readonly OwedList[] = [
  owedRunErasures,
  async (env, _now, limit) => await owedPersonErasures(env, limit),
];

/**
 * Most erasures one settle makes: half the 1,000 subrequests a Worker's
 * request may make, at two store calls each (a person's own store, then
 * the shared one), so the request it runs in keeps the rest. More owed
 * than that answers `owed`, and the producers' own clock runs work it down.
 */
export const owedErasuresMax = 250;

/** How many erasures one settle has under way at once. */
const erasingAtOnce = 8;

/** Makes the Brain call `owed` is. */
const settle = async (env: Env, owed: OwedErasure): Promise<void> => {
  if (owed.kind === "source") {
    const { source, readers, reason } = owed;
    await eraseSource(env, { source, readers, reason });
    return;
  }
  // `still_deleting` is landed too: the shared store's erasure returned,
  // and their own store recorded its own before it deletes its files; it
  // answers nothing from then on, and no export reads it.
  await erasePerson(env, { personId: owed.personId, reason: owed.reason });
};

/**
 * Makes every Brain erasure core owes now, a few at a time, and answers
 * `settled` when every one returned, `owed` when one failed (those after
 * its few are not made) or more were owed than one settle makes
 * ({@link owedErasuresMax}).
 */
export const settleOwedErasures = async (
  env: Env,
  now: Date
): Promise<"settled" | "owed"> => {
  const owed: OwedErasure[] = [];
  for (const list of owing) {
    const room = owedErasuresMax + 1 - owed.length;
    if (room <= 0) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one producer after another, within the room left
    owed.push(...(await list(env, now, room)));
  }
  const settling = owed.slice(0, owedErasuresMax);
  let failed = owed.length > settling.length;
  for (let at = 0; at < settling.length; at += erasingAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    const settled = await Promise.allSettled(
      settling.slice(at, at + erasingAtOnce).map(async (each) => {
        await settle(env, each);
      })
    );
    // Refused whatever the rest do: none started after one failed.
    if (settled.some(({ status }) => status === "rejected")) {
      failed = true;
      break;
    }
  }
  if (failed) {
    // A fixed name alone: what is owed names sources and people.
    log.warn("brain.erasures_owed", {});
    return "owed";
  }
  return "settled";
};
