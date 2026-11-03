/**
 * Live in the Stephen Lab: how real people did with the Stephen most of
 * them talk with now, against the one before him, group by group: by
 * voice or typed, lead or staff, and language. A group's numbers count
 * only interviews the admin has numbers of (GRA-329: never a word).
 *
 * A drop is said only when it is larger than chance: who finished, as two
 * shares (a two-proportion test at two standard errors), and the rating,
 * as two means (two standard errors of their difference). A group with
 * fewer than `LEAST_EACH` interviews on either side says nothing. Pure.
 */
import type { Interview } from "./onboarding-admin.ts";

/** What one group of interviews came to. */
export interface Tally {
  started: number;
  finished: number;
  /** Every rating someone gave, 1 to 5. */
  ratings: number[];
  /** Of each finished interview's notes, the share the person left in. */
  kept: number[];
}

/** How a number moved from one Stephen to the next: past chance either way, within it, or on too few interviews to say. */
export type Change = "better" | "worse" | "within chance" | "too few";

/** One group, with the Stephen in use now and the one before him. */
export interface LiveGroup {
  id: string;
  label: string;
  /** Who they are in a sentence: "people in Dutch", "leads". */
  who: string;
  now: Tally;
  before: Tally | null;
  /** Fewer finished than before, by more than chance. */
  finishedFell: boolean;
  /** The rating fell, by more than chance. */
  ratingFell: boolean;
}

/** The fewest interviews a group needs on each side before a drop is said. */
export const LEAST_EACH = 5;
/** How many standard errors a drop has to be. */
const ERRORS = 2;
/** Below this two numbers are the same; what's left is how floats add up. */
const TIE = 1e-9;

const LANGUAGES: Record<string, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
};

/** A language's name, or its code when it isn't one of Stephen's. */
export const languageName = (code: string): string => LANGUAGES[code] ?? code;

/** What some interviews came to. */
export const tallyOf = (interviews: readonly Interview[]): Tally => ({
  started: interviews.length,
  finished: interviews.filter((interview) => interview.approved).length,
  ratings: interviews.flatMap((interview) =>
    interview.rating === null ? [] : [interview.rating]
  ),
  kept: interviews.flatMap((interview) =>
    interview.approved && interview.facts > 0
      ? [(interview.facts - interview.out) / interview.facts]
      : []
  ),
});

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const variance = (values: readonly number[]): number => {
  if (values.length < 2) {
    return 0;
  }
  const middle = mean(values);
  return (
    values.reduce((sum, value) => sum + (value - middle) ** 2, 0) /
    (values.length - 1)
  );
};

/**
 * How a share moved, `count` of `of` now against before: a two-proportion
 * test at two standard errors, with `LEAST_EACH` or more on each side.
 */
export const shareChange = (
  now: { count: number; of: number },
  before: { count: number; of: number }
): Change => {
  if (now.of < LEAST_EACH || before.of < LEAST_EACH) {
    return "too few";
  }
  const difference = now.count / now.of - before.count / before.of;
  const pooled = (before.count + now.count) / (before.of + now.of);
  const error = Math.sqrt(pooled * (1 - pooled) * (1 / before.of + 1 / now.of));
  if (Math.abs(difference) <= ERRORS * error + TIE) {
    return "within chance";
  }
  return difference > 0 ? "better" : "worse";
};

/**
 * How a mean moved, of `now` against `before`: two standard errors of the
 * difference, with `LEAST_EACH` or more values on each side.
 */
export const meanChange = (
  now: readonly number[],
  before: readonly number[]
): Change => {
  if (now.length < LEAST_EACH || before.length < LEAST_EACH) {
    return "too few";
  }
  const difference = mean(now) - mean(before);
  const error = Math.sqrt(
    variance(before) / before.length + variance(now) / now.length
  );
  if (Math.abs(difference) <= ERRORS * error + TIE) {
    return "within chance";
  }
  return difference > 0 ? "better" : "worse";
};

/** Whether fewer finished now than before, by more than chance. */
export const finishedFell = (now: Tally, before: Tally): boolean =>
  shareChange(
    { count: now.finished, of: now.started },
    { count: before.finished, of: before.started }
  ) === "worse";

/** Whether people rate him lower now than before, by more than chance. */
export const ratingFell = (now: Tally, before: Tally): boolean =>
  meanChange(now.ratings, before.ratings) === "worse";

/** One of the numbers of real people the Lab leads with, with the Stephen in use now and the one before. */
export interface RealFigure {
  id: "finished" | "kept" | "rating";
  label: string;
  /** A share from 0 to 1, or a rating from 1 to 5; none before anyone counts. */
  value: number | null;
  /** How many it rests on. */
  of: number;
  before: number | null;
  change: Change | null;
}

const share = (tally: Tally): number | null =>
  tally.started === 0 ? null : tally.finished / tally.started;

const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : mean(values);

/** Finished, notes kept and rating, now against before: `before` is none where there was no Stephen before. */
export const realFiguresOf = (
  now: Tally,
  before: Tally | null
): RealFigure[] => [
  {
    id: "finished",
    label: "Finished",
    value: share(now),
    of: now.started,
    before: before === null ? null : share(before),
    change:
      before === null
        ? null
        : shareChange(
            { count: now.finished, of: now.started },
            { count: before.finished, of: before.started }
          ),
  },
  {
    id: "kept",
    label: "Notes kept",
    value: average(now.kept),
    of: now.kept.length,
    before: before === null ? null : average(before.kept),
    change: before === null ? null : meanChange(now.kept, before.kept),
  },
  {
    id: "rating",
    label: "Rating",
    value: average(now.ratings),
    of: now.ratings.length,
    before: before === null ? null : average(before.ratings),
    change: before === null ? null : meanChange(now.ratings, before.ratings),
  },
];

/** The groups interviews are seen in: all of them, by channel, by role, and by language. */
const groupsOf = (
  interviews: readonly Interview[]
): {
  id: string;
  label: string;
  who: string;
  holds: (interview: Interview) => boolean;
}[] => {
  const languages = [
    ...new Set(interviews.flatMap((each) => each.language ?? [])),
  ].toSorted();
  return [
    { id: "all", label: "All", who: "people", holds: () => true },
    {
      id: "voice",
      label: "By voice",
      who: "people talking",
      holds: (each) => !each.typed,
    },
    {
      id: "typed",
      label: "Typed",
      who: "people typing",
      holds: (each) => each.typed,
    },
    {
      id: "lead",
      label: "Leads",
      who: "leads",
      holds: (each) => each.kind === "lead",
    },
    {
      id: "staff",
      label: "Team members",
      who: "team members",
      holds: (each) => each.kind === "employee",
    },
    ...languages.map((code) => ({
      id: `language-${code}`,
      label: languageName(code),
      who: `people in ${languageName(code)}`,
      holds: (each: Interview) => each.language === code,
    })),
  ];
};

/**
 * Every group, its numbers with the Stephen in use now (`now`, every release
 * he was run as) and with the one before him (`before`, none when there is no
 * earlier one), and whether
 * either number fell by more than chance.
 */
export const liveGroupsOf = (
  interviews: readonly Interview[],
  now: readonly string[],
  before: readonly string[] | null
): LiveGroup[] => {
  const heldBy = (releases: readonly string[]) =>
    interviews.filter(
      (each) => each.stephen !== undefined && releases.includes(each.stephen)
    );
  const withNow = heldBy(now);
  const withBefore = before === null ? [] : heldBy(before);
  return groupsOf(withNow).flatMap(({ id, label, who, holds }) => {
    const nowTally = tallyOf(withNow.filter(holds));
    if (nowTally.started === 0) {
      return [];
    }
    const beforeTally =
      before === null ? null : tallyOf(withBefore.filter(holds));
    return [
      {
        id,
        label,
        who,
        now: nowTally,
        before: beforeTally,
        finishedFell:
          beforeTally !== null && finishedFell(nowTally, beforeTally),
        ratingFell: beforeTally !== null && ratingFell(nowTally, beforeTally),
      },
    ];
  });
};
