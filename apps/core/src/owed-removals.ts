import { errorName, log } from "@grasp-os/shared/log";

// Removals from the Brain that core recorded as owed before it asked the
// Brain (brain-uploads.ts: an uploader's removal of a shared upload;
// brain-run-sources.ts: a person's run results once they lost the
// workflow), completed by the clock: each owed row on its own, so one that
// keeps failing never holds up another. Each completion is safe to repeat
// and stores its one event, derived from the row, once.

/**
 * Completes each of `owed` in turn (`complete`): one that fails is logged
 * as `event`, with what `logged` says of it (IDs, never content) and its
 * error's name, and the rest go on; it is owed still, for the clock's next
 * run.
 */
export const completeEachOwed = async <Row>(
  owed: readonly Row[],
  complete: (row: Row) => Promise<void>,
  event: string,
  logged: (row: Row) => Record<string, string>
): Promise<void> => {
  for (const row of owed) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one removal at a time
      await complete(row);
    } catch (error) {
      log.warn(event, { ...logged(row), errorName: errorName(error) });
    }
  }
};
