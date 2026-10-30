/**
 * A release's id, and the one place its format lives: making the next
 * one, parsing one and ordering two.
 *
 * A published release is `YY.MM.N`: the two-digit year and zero-padded
 * month (UTC) it was published in, and N, counting up from 1 within that
 * month, such as `26.10.42`. CI's publish takes the next N from the
 * releases bucket and claims it with a conditional write, trying the one
 * after when another publish got there first (scripts/release/upload-release.ts).
 * Promoting a release copies it with the id it has.
 *
 * A local build is `dev-<time>` until it's published: never in a bucket a
 * client's release comes from.
 *
 * Ids order by year, month and N as numbers, never as strings: `26.10.10`
 * comes after `26.10.9`. The year is two digits, so the order holds until
 * 2100. Nothing but Web APIs: CI (Node) and the admin (workerd) share it.
 */
import { z } from "zod";

const PUBLISHED = /^(?<yy>\d{2})\.(?<mm>0[1-9]|1[0-2])\.(?<n>[1-9]\d{0,8})$/u;
const DEV = /^dev-[0-9a-z]+$/u;

// It becomes an R2 prefix and a Worker version's tag, so nothing else is
// allowed in it.
/** A release's id: `YY.MM.N` once published, `dev-<time>` from a local build. */
export const releaseIdSchema = z
  .string()
  .refine((id) => PUBLISHED.test(id) || DEV.test(id), "Not a release id");

/** A published release's id, in parts: the year as its two digits. */
export interface PublishedReleaseId {
  year: number;
  month: number;
  n: number;
}

/** The parts of a published release's id; undefined for any other. */
export const parsePublishedReleaseId = (
  id: string
): PublishedReleaseId | undefined => {
  const groups = PUBLISHED.exec(id)?.groups;
  if (
    groups?.yy === undefined ||
    groups.mm === undefined ||
    groups.n === undefined
  ) {
    return undefined;
  }
  return {
    year: Number(groups.yy),
    month: Number(groups.mm),
    n: Number(groups.n),
  };
};

const YEAR_DIGITS = 100;

/** The `YY.MM.` every id published in `at`'s UTC month starts with. */
export const releaseMonthPrefix = (at: Date): string =>
  `${String(at.getUTCFullYear() % YEAR_DIGITS).padStart(2, "0")}.${String(at.getUTCMonth() + 1).padStart(2, "0")}.`;

/**
 * The id of the next release published in `at`'s UTC month: N one past
 * the highest of that month's among `taken` (every id the bucket holds, or
 * any part of it that includes the month's), 1 when there's none.
 */
export const nextReleaseId = (taken: Iterable<string>, at: Date): string => {
  const prefix = releaseMonthPrefix(at);
  let highest = 0;
  for (const id of taken) {
    const parts = id.startsWith(prefix)
      ? parsePublishedReleaseId(id)
      : undefined;
    if (parts !== undefined && parts.n > highest) {
      highest = parts.n;
    }
  }
  return `${prefix}${highest + 1}`;
};

/**
 * Orders release ids oldest first: published ones by year, month and N,
 * after every local build (`dev-`), which order by their own text.
 */
export const compareReleaseIds = (a: string, b: string): number => {
  const one = parsePublishedReleaseId(a);
  const other = parsePublishedReleaseId(b);
  if (one !== undefined && other !== undefined) {
    return one.year - other.year || one.month - other.month || one.n - other.n;
  }
  if (one !== undefined) {
    return 1;
  }
  if (other !== undefined) {
    return -1;
  }
  return a < b ? -1 : Number(a > b);
};
