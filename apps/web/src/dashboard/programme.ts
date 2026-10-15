import { programmeWeeks } from "@grasp-os/shared/onboarding";

// The programme's weeks, as the dashboard counts them, ported from the
// prototype (`lib/weekly-report.ts`): the programme runs in weeks from its
// first Monday (core's `onboarding.programme()`), and a week's report is
// ready on the first day of the week after it: the week has closed, so
// what the report says of it won't change. Pure dates, UTC.

const dayMs = 86_400_000;

const weekDays = 7;

/** Whole days from `start` to `today`, both `YYYY-MM-DD`: negative before it starts. */
const daysFrom = (start: string, today: string): number =>
  Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      dayMs
  );

/** Whole days from `start` to `today`; none before it starts. */
const daysIn = (start: string, today: string): number =>
  Math.max(0, daysFrom(start, today));

/** The week of the programme `today` is in, from 1; week 1 before it starts, and on past its last. */
export const programmeWeek = (start: string, today: string): number =>
  Math.floor(daysIn(start, today) / weekDays) + 1;

/** Whether `week` is one of the programme's own, so the line counts it "of 8". */
export const inProgramme = (week: number): boolean => week <= programmeWeeks;

/** When the next weekly report is ready, and what it is about. */
export interface NextReport {
  /** Days from today until a report is ready; 0 on the day it is. */
  inDays: number;
  /** The week it is on: the one that just closed when it is ready, otherwise the one that runs. */
  week: number;
  /** How many of that week's seven days have passed, 0 to 7; 7 on the day it is ready. */
  through: number;
}

/**
 * The next weekly report, from the programme's first Monday and today.
 * Before the programme begins, the first report is a week after its start,
 * counted down from today, and nothing of its week has passed yet.
 */
export const nextReport = (start: string, today: string): NextReport => {
  const before = daysFrom(start, today);
  if (before < 0) {
    return { inDays: weekDays - before, week: 1, through: 0 };
  }
  const days = before;
  const inWeek = days % weekDays;
  // The first day of a week after the first: the week before it has just closed.
  if (inWeek === 0 && days > 0) {
    return { inDays: 0, week: days / weekDays, through: weekDays };
  }
  return {
    inDays: weekDays - inWeek,
    week: Math.floor(days / weekDays) + 1,
    through: inWeek,
  };
};

/** `YYYY-MM-DD` of the day `days` days after `start`. */
const dayAfter = (start: string, days: number): string =>
  new Date(Date.parse(`${start}T00:00:00Z`) + days * dayMs)
    .toISOString()
    .slice(0, 10);

/** The days a weekly report is about, as core's run activity reads them. */
export interface ReportWindow {
  /** Its last day, `YYYY-MM-DD`. */
  to: string;
  /** How many days, up to and with `to`. */
  days: number;
}

/**
 * What the next weekly report (`nextReport`) is about: its week's days up
 * to today, so the week that just closed whole once it is ready, and the
 * one that runs so far until then. Before the programme begins, today.
 */
export const reportWindow = (start: string, today: string): ReportWindow => {
  const { week } = nextReport(start, today);
  const first = (week - 1) * weekDays;
  const last = Math.min(first + weekDays - 1, daysFrom(start, today));
  if (last < first) {
    return { to: today, days: 1 };
  }
  return { to: dayAfter(start, last), days: last - first + 1 };
};

/** Today in UTC, as the programme counts days: `YYYY-MM-DD`. */
export const todayUtc = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);
