import type { OrgView } from "./onboarding-admin.ts";
import { LISTEN_DAYS } from "./onboarding.ts";

/**
 * Where the interviews of an organization stand, as numbers to draw: how far everyone who is asked
 * has come with their link, and how many had talked by each day. Whoever is away, or in a team
 * that does not take part, is not asked and not counted. Pure.
 */

/** How far the people who are asked have come: each step holds everyone who got at least that far. */
export interface Funnel {
  asked: number;
  /** Their link went out. */
  out: number;
  opened: number;
  /** They started talking, whether they finished or not. */
  started: number;
  /** They agreed to what was read back. */
  talked: number;
  /** How many got the one reminder. */
  reminded: number;
  /** Who the one reminder can still go to. */
  toRemind: string[];
}

/** Whether someone in this state has started talking. */
const started = (state: string) =>
  state === "progress" || state === "incomplete" || state === "completed";

export const funnelOf = (view: OrgView): Funnel => {
  const asked = view.people.filter((each) => each.state !== "away");
  return {
    asked: asked.length,
    out: asked.filter((each) => each.sent !== null).length,
    opened: asked.filter((each) => each.opened !== null || started(each.state))
      .length,
    started: asked.filter((each) => started(each.state)).length,
    talked: asked.filter((each) => each.state === "completed").length,
    reminded: asked.filter((each) => each.reminded !== null).length,
    toRemind: asked
      .filter((each) => each.mayRemind)
      .map((each) => each.person.id),
  };
};

/** One day of the interviews: how many agreed to their interview that day, and how many had by then. */
export interface TalkedDay {
  day: number;
  /** On that day alone; none for a day that has not come. */
  talked: number | null;
  /** Up to and with that day; none for a day that has not come. */
  total: number | null;
}

/** Every day of the interviews, from the day the team was told until the links close: the days so far with their counts. */
export const talkedByDay = (view: OrgView): TalkedDay[] => {
  const done = view.people.flatMap((each) =>
    each.state === "completed" && each.completed !== null
      ? [each.completed]
      : []
  );
  return Array.from({ length: LISTEN_DAYS + 1 }, (_, day): TalkedDay => {
    if (!view.told || day > view.day) {
      return { day, talked: null, total: null };
    }
    return {
      day,
      talked: done.filter((at) => at === day).length,
      total: done.filter((at) => at <= day).length,
    };
  });
};
