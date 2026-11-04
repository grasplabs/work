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
}

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

const LANGUAGES: Record<string, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
};

/** A language's name, or its code when it isn't one of Stephen's. */
export const languageName = (code: string): string => LANGUAGES[code] ?? code;

const tallyOf = (interviews: readonly Interview[]): Tally => ({
  started: interviews.length,
  finished: interviews.filter((interview) => interview.approved).length,
  ratings: interviews.flatMap((interview) =>
    interview.rating === null ? [] : [interview.rating]
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

/** Whether fewer finished now than before, by more than chance. */
export const finishedFell = (now: Tally, before: Tally): boolean => {
  if (now.started < LEAST_EACH || before.started < LEAST_EACH) {
    return false;
  }
  const was = before.finished / before.started;
  const is = now.finished / now.started;
  const pooled =
    (before.finished + now.finished) / (before.started + now.started);
  const error = Math.sqrt(
    pooled * (1 - pooled) * (1 / before.started + 1 / now.started)
  );
  return was - is > ERRORS * error && was > is;
};

/** Whether people rate him lower now than before, by more than chance. */
export const ratingFell = (now: Tally, before: Tally): boolean => {
  if (now.ratings.length < LEAST_EACH || before.ratings.length < LEAST_EACH) {
    return false;
  }
  const drop = mean(before.ratings) - mean(now.ratings);
  const error = Math.sqrt(
    variance(before.ratings) / before.ratings.length +
      variance(now.ratings) / now.ratings.length
  );
  return drop > ERRORS * error && drop > 0;
};

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
