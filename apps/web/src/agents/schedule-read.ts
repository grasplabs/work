// A wake-up's schedule as the agent's page draws it (agent-overview.tsx):
// the days of the week it fires on, Monday first, and its time of day.
// Core keeps the schedule as a five-field cron (agent-wakes.ts); this
// reads the ones that fire at one time of day on whole days of the week,
// which is every schedule the agent's pages make (agent-wakes.tsx). Any
// other is shown as its words.

/** The days it fires, Monday first, and its time as hour and minute. */
export interface WeekSchedule {
  days: readonly boolean[];
  hour: number;
  minute: number;
}

const number = /^\d{1,2}$/u;
const range = /^(?<from>\d)(?:-(?<to>\d))?$/u;

/** The days a cron's day-of-week field names, Monday first; undefined for one not read here. */
const daysOf = (field: string): boolean[] | undefined => {
  const days = Array.from({ length: 7 }, () => field === "*");
  if (field === "*") {
    return days;
  }
  for (const part of field.split(",")) {
    const { from, to } = range.exec(part)?.groups ?? {};
    if (from === undefined) {
      return undefined;
    }
    const last = Number(to ?? from);
    if (last > 7 || last < Number(from)) {
      return undefined;
    }
    for (let day = Number(from); day <= last; day += 1) {
      // Cron counts Sunday as 0 and as 7; here it is the last day.
      days[(day + 6) % 7] = true;
    }
  }
  return days;
};

/** A cron's week, when it fires at one time on whole days of the week; undefined for any other. */
export const weekOf = (cron: string): WeekSchedule | undefined => {
  const [minute = "", hour = "", ofMonth, month, ofWeek = "", ...rest] = cron
    .trim()
    .split(/\s+/u);
  if (
    rest.length > 0 ||
    ofMonth !== "*" ||
    month !== "*" ||
    !number.test(minute) ||
    !number.test(hour) ||
    Number(minute) > 59 ||
    Number(hour) > 23
  ) {
    return undefined;
  }
  const days = daysOf(ofWeek);
  return days === undefined
    ? undefined
    : { days, hour: Number(hour), minute: Number(minute) };
};
