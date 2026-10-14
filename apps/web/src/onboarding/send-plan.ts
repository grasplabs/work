import type { PlanInput } from "@grasp-os/shared/onboarding";

// When the links to an interview go out, as whoever sends them sets it: a
// day and an hour for the first teams, and for the teams left out of that
// either a later moment or nothing yet. Pure: the screen that asks is
// send-plan-form.tsx, and what comes of it is the onboarding's plan, which
// core sends by. From the prototype's `lib/send-plan.ts`.

/** The ISO day `count` days after `day`. */
export const addDays = (day: string, count: number): string => {
  const date = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

/** The ISO day `count` working days after `day`: weekends do not count. */
export const addWorkingDays = (day: string, count: number): string => {
  let at = day.slice(0, 10);
  let left = count;
  while (left > 0) {
    at = addDays(at, 1);
    const weekday = new Date(`${at}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      left -= 1;
    }
  }
  return at;
};

export interface SendChoice {
  /** The day the first links go out, as an ISO day, and the hour on the sender's own clock, as HH:MM. */
  day: string;
  time: string;
  /** The teams left out of the first links, by id. */
  held: string[];
  /** When those go out: a day and an hour, or none while that is not planned. */
  heldDay: string | null;
  heldTime: string;
}

/** The usual hour: the start of a working day. */
export const sendTime = "09:00";

const isoDay = /^\d{4}-\d{2}-\d{2}$/u;
const clockTime = /^\d{2}:\d{2}$/u;

/** The days offered without a calendar: the next working day, the one after, and the Monday of next week. */
export const dayChoices = (
  today: string
): { id: "tomorrow" | "after" | "week"; day: string }[] => {
  const tomorrow = addWorkingDays(today, 1);
  const after = addWorkingDays(today, 2);
  // The first Monday that is not one of those two.
  let week = addDays(today, 1);
  while (new Date(`${week}T12:00:00Z`).getUTCDay() !== 1 || week <= after) {
    week = addDays(week, 1);
  }
  return [
    { id: "tomorrow", day: tomorrow },
    { id: "after", day: after },
    { id: "week", day: week },
  ];
};

/** What the screen starts from: the next working day at nine, every team. */
export const firstChoice = (today: string): SendChoice => ({
  day: addWorkingDays(today, 1),
  time: sendTime,
  held: [],
  heldDay: null,
  heldTime: sendTime,
});

/** A day and an hour on this device's clock as a moment in time; none when either is not one. */
export const momentOf = (day: string, time: string): string | null => {
  if (!isoDay.test(day) || !clockTime.test(time)) {
    return null;
  }
  const moment = new Date(`${day}T${time}:00`);
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString();
};

/** Whether a choice can be sent: a real moment, and the teams that go later not before it. */
export const choiceHolds = (choice: SendChoice, teams: string[]): boolean => {
  const first = momentOf(choice.day, choice.time);
  if (first === null) {
    return false;
  }
  // Somebody has to get a link.
  if (teams.length > 0 && teams.every((team) => choice.held.includes(team))) {
    return false;
  }
  if (choice.held.length === 0 || choice.heldDay === null) {
    return true;
  }
  const later = momentOf(choice.heldDay, choice.heldTime);
  return later !== null && later >= first;
};

/** The plan a choice makes, for interviews that run `days` days. */
export const planOf = (choice: SendChoice, days: number): PlanInput => {
  const at = momentOf(choice.day, choice.time);
  const later =
    choice.heldDay === null ? null : momentOf(choice.heldDay, choice.heldTime);
  return {
    start: choice.day,
    days,
    ...(at === null ? {} : { at }),
    ...(choice.held.length > 0
      ? {
          later: Object.fromEntries(choice.held.map((team) => [team, later])),
        }
      : {}),
  };
};

/** The hour of a moment on this device's own clock, as HH:MM. */
export const clockOf = (moment: string): string => {
  const at = new Date(moment);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** The day of a moment on this device's own clock, as an ISO day. */
export const dayOnClock = (moment: string): string => {
  const at = new Date(moment);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};

/** The choice a saved plan was made from: what they set before stands. */
export const choiceOfPlan = (plan: {
  start: string;
  at?: string;
  later?: Record<string, string | null>;
}): SendChoice => {
  const held = Object.keys(plan.later ?? {});
  const later =
    held
      .map((team) => plan.later?.[team])
      .find((moment) => moment !== undefined && moment !== null) ?? null;
  return {
    day: plan.start,
    time: plan.at === undefined ? sendTime : clockOf(plan.at),
    held,
    heldDay: later === null ? null : dayOnClock(later),
    heldTime: later === null ? sendTime : clockOf(later),
  };
};

/**
 * The plan a choice makes over a plan saved before: what the admin did
 * not change stays as it was. How many days the interviews run is not on
 * the screen, so it stays; the first moment stays while its day and hour
 * do; and while the later day and hour are as the screen showed them, each
 * team held before keeps its own moment, as only the first is shown.
 */
export const replanOf = (
  choice: SendChoice,
  saved: {
    start: string;
    days: number;
    at?: string;
    later?: Record<string, string | null>;
  } | null,
  usualDays: number
): PlanInput => {
  if (saved === null) {
    return planOf(choice, usualDays);
  }
  const plan = planOf(choice, saved.days);
  const shown = choiceOfPlan(saved);
  const sameFirst = choice.day === shown.day && choice.time === shown.time;
  const sameLater =
    choice.heldDay === shown.heldDay && choice.heldTime === shown.heldTime;
  const savedLater = saved.later ?? {};
  return {
    ...plan,
    ...(sameFirst && saved.at !== undefined ? { at: saved.at } : {}),
    ...(plan.later !== undefined && sameLater
      ? {
          later: Object.fromEntries(
            Object.entries(plan.later).map(([team, moment]) => [
              team,
              Object.hasOwn(savedLater, team)
                ? (savedLater[team] ?? null)
                : moment,
            ])
          ),
        }
      : {}),
  };
};
