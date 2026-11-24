import { pageLimits } from "@grasp-os/shared/pages";

// Where a page with an end is split. A live list's loaded page
// (`usePaginatedQuery`) ends at the cursor the next page starts at, so it
// grows as records move into it. Past a bound, its answer says where to
// split it (`splitCursor`), and the list follows its two halves instead.
// The store's pages (store-queries.ts, `readPage`) and the workflow
// queries' (workflow-reference-queries.ts) are cut by the same rule.
//
// What a `splitCursor` means, whichever rule set it: the answer holds
// every record of the page up to that place, and may hold those after
// it. A page answers whole while it fits one answer, so the first half
// shows the whole page until both halves answer; only a page past what
// one answer may carry, or whose read stopped at a bound short of its
// end, answers just its records up to the split.

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
 * After which record a page that fits one answer is split, given each
 * record's answer bytes (`sizes`): past half of what one answer may carry,
 * after the last record within the first half of their bytes; else past
 * twice `pageSize`, after its first `pageSize`; else none.
 */
const splitWithin = (
  sizes: readonly number[],
  total: number,
  pageSize: number
): number | undefined => {
  if (sizes.length >= 2 && total > pageLimits.answerBytes / 2) {
    let within = 0;
    let at = 0;
    for (const [position, size] of sizes.entries()) {
      within += size;
      if (within > total / 2 || position === sizes.length - 1) {
        break;
      }
      at = position;
    }
    return at;
  }
  return sizes.length > 2 * pageSize ? pageSize - 1 : undefined;
};

/**
 * How much of a page with an end to answer, and where to split it, given
 * each record's answer bytes (`sizes`) and whether its read stopped short
 * of its end at a bound of its own (`stopped`):
 * - past what one answer may carry (`pageLimits.answerBytes`), or
 *   stopped, it answers its first records within half an answer, one at
 *   least, and is split after them, or where it stopped when all fit;
 * - else it answers whole, split as `splitWithin` says.
 */
export const pageCut = (
  sizes: readonly number[],
  pageSize: number,
  stopped: boolean
): PageCut => {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (stopped || total > pageLimits.answerBytes) {
    const budget = pageLimits.answerBytes / 2;
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
  return { keep: sizes.length, split: splitWithin(sizes, total, pageSize) };
};

const encoder = new TextEncoder();

/** The bytes `value` takes in an answer, as UTF-8 JSON. */
export const answerSize = (value: unknown): number =>
  encoder.encode(JSON.stringify(value) ?? "").byteLength;
