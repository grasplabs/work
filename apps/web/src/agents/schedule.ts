import { useLingui } from "@lingui/react/macro";

import { formatList } from "../format.ts";

// When an agent works on its own, one module both ways: every schedule
// the pages offer (the guided setup's, the chat's, Add a time's) is a
// `Schedule`, written as core keeps it, five cron fields
// (`cronOfSchedule`), and every one core keeps is read back from them
// (`scheduleOfCron`) and said in words (`useScheduleWords`). A schedule
// made elsewhere that is none of these is shown as core keeps it.

/** How often it works on its own; `asked` is never. */
export const frequencies = ["asked", "daily", "weekly", "monthly"] as const;
export type Frequency = (typeof frequencies)[number];

/** When it works on its own: how often, on which days, at what time. */
export interface Schedule {
  frequency: Frequency;
  /** For `weekly`: the days it works, 0 for Sunday to 6 for Saturday. */
  days: ReadonlySet<number>;
  /** For `monthly`: the day of the month, 1 to 28 so every month has it. */
  dayOfMonth: number;
  /** The time, `HH:MM`, in the company's time zone. */
  time: string;
}

/** The days of the working week, Monday to Friday. */
export const weekdays: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

/** The quick choices the chat and Add a time offer. */
export const rhythms = ["weekdays", "daily", "mondays"] as const;
export type Rhythm = (typeof rhythms)[number];

/** The schedule a quick choice names, at `time` (`HH:MM`). */
export const scheduleOfRhythm = (rhythm: Rhythm, time: string): Schedule => ({
  frequency: rhythm === "daily" ? "daily" : "weekly",
  days: rhythm === "mondays" ? new Set([1]) : weekdays,
  dayOfMonth: 1,
  time,
});

const timeOfDay = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;

/**
 * The schedule as core keeps it, five cron fields; undefined when it never
 * runs on its own, or when it can't run (no time, no day).
 */
export const cronOfSchedule = (schedule: Schedule): string | undefined => {
  const { hour, minute } = timeOfDay.exec(schedule.time)?.groups ?? {};
  if (
    schedule.frequency === "asked" ||
    hour === undefined ||
    minute === undefined
  ) {
    return undefined;
  }
  const at = `${String(Number(minute))} ${String(Number(hour))}`;
  if (schedule.frequency === "daily") {
    return `${at} * * *`;
  }
  if (schedule.frequency === "monthly") {
    return `${at} ${String(schedule.dayOfMonth)} * *`;
  }
  if (schedule.days.size === 0) {
    return undefined;
  }
  const days = [...schedule.days].toSorted((a, b) => a - b).join(",");
  return `${at} * * ${days}`;
};

const cronPattern =
  /^(?<minute>\d{1,2}) (?<hour>\d{1,2}) (?<dom>\*|\d{1,2}) \* (?<dow>\S+)$/u;
const dayRange = /^(?<from>[0-7])(?:-(?<to>[0-7]))?$/u;

/** The weekdays a cron day field names (`*`, `1-5`, `1,3,5`, 7 as Sunday); undefined for any other. */
const daysOfField = (field: string): Set<number> | undefined => {
  if (field === "*") {
    return new Set([0, 1, 2, 3, 4, 5, 6]);
  }
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const { from, to } = dayRange.exec(part)?.groups ?? {};
    if (from === undefined) {
      return undefined;
    }
    const last = Number(to ?? from);
    for (let day = Number(from); day <= last; day += 1) {
      days.add(day % 7);
    }
  }
  return days;
};

/**
 * The schedule five cron fields name, as `cronOfSchedule` writes them and
 * as the usual short forms (`1-5`, `7` for Sunday) say the same; undefined
 * for any other, which is shown as core keeps it.
 */
export const scheduleOfCron = (cron: string): Schedule | undefined => {
  const { minute, hour, dom, dow } = cronPattern.exec(cron)?.groups ?? {};
  if (
    minute === undefined ||
    hour === undefined ||
    dom === undefined ||
    dow === undefined ||
    Number(minute) > 59 ||
    Number(hour) > 23
  ) {
    return undefined;
  }
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const days = daysOfField(dow);
  if (days === undefined) {
    return undefined;
  }
  if (dom !== "*") {
    const dayOfMonth = Number(dom);
    // A day of the month and a day of the week at once is neither alone.
    return dow === "*" && dayOfMonth >= 1 && dayOfMonth <= 31
      ? { frequency: "monthly", days: new Set(), dayOfMonth, time }
      : undefined;
  }
  return days.size === 7
    ? { frequency: "daily", days: new Set(), dayOfMonth: 1, time }
    : { frequency: "weekly", days, dayOfMonth: 1, time };
};

/** A Sunday, from which each weekday's name is read. */
const aSunday = new Date(2026, 10, 15);

/** One formatter a language and a shape, made once: a schedule says several names. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterOf = (
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat => {
  const key = `${locale} ${JSON.stringify(options)}`;
  const found = formatters.get(key);
  if (found !== undefined) {
    return found;
  }
  const made = new Intl.DateTimeFormat(locale, options);
  formatters.set(key, made);
  return made;
};

/** The day `day` (0 Sunday) is named, short or long. */
export const dayName = (
  locale: string,
  day: number,
  width: "short" | "long"
): string =>
  formatterOf(locale, { weekday: width }).format(
    new Date(aSunday.getFullYear(), aSunday.getMonth(), aSunday.getDate() + day)
  );

/** A time such as `09:00` as the page's language writes it. */
export const timeName = (locale: string, time: string): string => {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return formatterOf(locale, { timeStyle: "short" }).format(
    new Date(2026, 0, 1, hour, minute)
  );
};

/** Whether `days` are Monday to Friday, no more and no fewer. */
const isWorkingWeek = (days: ReadonlySet<number>): boolean =>
  days.size === weekdays.size && [...weekdays].every((day) => days.has(day));

/**
 * When a schedule works, in words ("Every weekday at 9:00 AM", "Every
 * Monday and Friday at 9:00 AM", "Day 1 of every month at 9:00 AM"), and
 * the same for a schedule as core keeps it (`ofCron`), which is shown as
 * it is kept where it is none the pages make.
 */
export const useScheduleWords = () => {
  const { t, i18n } = useLingui();
  const { locale } = i18n;
  const of = (schedule: Schedule): string => {
    const time = timeName(locale, schedule.time);
    if (schedule.frequency === "asked") {
      return t`Only when someone asks`;
    }
    if (schedule.frequency === "daily") {
      return t`Every day at ${time}`;
    }
    if (schedule.frequency === "monthly") {
      const day = schedule.dayOfMonth;
      return t`Day ${day} of every month at ${time}`;
    }
    if (isWorkingWeek(schedule.days)) {
      return t`Every weekday at ${time}`;
    }
    // Monday first, Sunday last.
    const days = formatList(
      [...schedule.days]
        .toSorted((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map((day) => dayName(locale, day, "long"))
    );
    return t`Every ${days} at ${time}`;
  };
  const ofCron = (cron: string): string => {
    const schedule = scheduleOfCron(cron);
    return schedule === undefined ? cron : of(schedule);
  };
  return { of, ofCron };
};
