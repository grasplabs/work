import { pageLimits } from "@grasp-os/shared/pages";

// Where a page with an end is split. A live list's loaded page
// (`usePaginatedQuery`) ends at the cursor the next page starts at, so it
// grows as records move into it. Past a bound, its answer says where to
// split it (`splitCursor`), and the list follows its two halves instead.
// The store's pages (store-queries.ts, `readPage`) and the workflow
// queries' (workflow-reference-queries.ts) are cut by the same rule.

/**
 * How a page with an end is answered: its first `keep` records, and,
 * when it is to be split, after which (`split`, an index of them), or at
 * the place its read stopped short of its end (`"stopped"`).
 */
export interface PageCut {
  readonly keep: number;
  readonly split: number | "stopped" | undefined;
}

/**
 * How much of a page with an end to answer, and where to split it, given
 * each record's answer bytes (`sizes`) and whether its read stopped short
 * of its end at a bound of its own (`stopped`):
 * - past half of what one answer may carry (`pageLimits.answerBytes`), or
 *   stopped, it answers its first records within that half, one at least,
 *   and is split after them, or where it stopped when all of them fit;
 * - else past twice `pageSize`, it is split after its first `pageSize`;
 * - else it is answered whole.
 */
export const pageCut = (
  sizes: readonly number[],
  pageSize: number,
  stopped: boolean
): PageCut => {
  const budget = pageLimits.answerBytes / 2;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (stopped || total > budget) {
    let within = 0;
    let keep = 0;
    for (const size of sizes) {
      if (keep > 0 && within + size > budget) {
        break;
      }
      within += size;
      keep += 1;
    }
    if (keep < sizes.length) {
      return { keep, split: keep - 1 };
    }
    return { keep, split: stopped ? "stopped" : undefined };
  }
  return {
    keep: sizes.length,
    split: sizes.length > 2 * pageSize ? pageSize - 1 : undefined,
  };
};

/** The bytes `value` takes in an answer, as JSON. */
export const answerSize = (value: unknown): number =>
  JSON.stringify(value)?.length ?? 0;
