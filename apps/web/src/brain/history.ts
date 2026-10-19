import type { Dated } from "@grasp-os/shared/brain";

/** What counts now: the newest value. On the same day, the one added last. */
export const latest = <T extends Dated>(history: T[]): T | undefined =>
  history.toSorted((a, b) => a.date.localeCompare(b.date)).at(-1);

/** Oldest first, each with the value it replaced, for a timeline of changes. */
export const changes = <T extends Dated>(
  history: T[]
): { value: T; previous?: T }[] => {
  const ordered = history.toSorted((a, b) => a.date.localeCompare(b.date));
  return ordered.map((value, index) => ({
    value,
    previous: ordered[index - 1],
  }));
};
