import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Pulse, as in the prototype (`lib/pulse.ts`): the device app that sees
// which tools are used, never what is in them. Coverage over the whole
// directory, and the weekly schedule in plain words, derived on read.
// Core keeps none of it yet: Settings → Pulse shows it empty.

/** A person's device with Pulse on it. */
export interface PulseDevice {
  name: string;
  os: "Windows" | "macOS" | "Linux";
  status: "online" | "offline" | "attention";
  /** When it last reported (ISO 8601). */
  lastSeen: string;
  /** What needs attention, in words. */
  note?: string;
}

/** Everyone in the directory, with or without Pulse. */
export interface PulsePerson {
  id: string;
  name: string;
  email: string;
  /** Their department in the directory. */
  team: string;
  device: PulseDevice | null;
}

/** Per weekday, Monday first, the 24 hours Pulse may report in. */
export type WeekSchedule = boolean[][];

/** A week in which Pulse never reports. */
export const quietWeek: WeekSchedule = Array.from({ length: 7 }, () =>
  Array.from({ length: 24 }, () => false)
);

/** A weekday in the reader's language, Monday first: "Monday", "Montag", "lundi". */
export const dayName = (day: number): string =>
  // 1 January 2024 was a Monday.
  new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    timeZone: "UTC",
  }).format(Date.UTC(2024, 0, 1 + day));

export type Coverage = "online" | "offline" | "attention" | "missing";

export const coverageLabel: Record<Coverage, MessageDescriptor> = {
  online: msg({ message: "Online", context: "Pulse status" }),
  offline: msg({ message: "Offline", context: "Pulse status" }),
  attention: msg({ message: "Needs attention", context: "Pulse status" }),
  missing: msg({ message: "No Pulse", context: "Pulse status" }),
};

export const coverageOf = (person: PulsePerson): Coverage =>
  person.device?.status ?? "missing";

export const coverageCounts = (
  people: readonly PulsePerson[]
): Record<Coverage, number> => {
  const counts: Record<Coverage, number> = {
    online: 0,
    offline: 0,
    attention: 0,
    missing: 0,
  };
  for (const person of people) {
    counts[coverageOf(person)] += 1;
  }
  return counts;
};

export const scheduleHours = (schedule: WeekSchedule): number =>
  schedule.flat().filter(Boolean).length;

const hoursInWeek = 168;

/** A day's on-hours as ranges: "8:00 to 12:00, 13:00 to 18:00". */
const dayRanges = (hours: readonly boolean[]): string => {
  const ranges: string[] = [];
  let start: number | null = null;
  for (let hour = 0; hour <= 24; hour += 1) {
    if (hours[hour] === true && start === null) {
      start = hour;
    }
    if (hours[hour] !== true && start !== null) {
      const from = `${start}:00`;
      const until = `${hour}:00`;
      ranges.push(
        hour === 24
          ? i18n._(msg`${from} to midnight`)
          : i18n._(msg`${from} to ${until}`)
      );
      start = null;
    }
  }
  return ranges.join(", ");
};

/**
 * The schedule in one line: days with the same hours are grouped, so office hours read
 * "Monday to Friday, 8:00 to 18:00".
 */
export const scheduleSummary = (schedule: WeekSchedule): string => {
  const hours = scheduleHours(schedule);
  if (hours === 0) {
    return i18n._(msg({ message: "Never", context: "when Pulse may report" }));
  }
  if (hours === hoursInWeek) {
    return i18n._(msg`All the time`);
  }
  const groups: { from: number; to: number; ranges: string }[] = [];
  for (const [index, day] of schedule.entries()) {
    const ranges = dayRanges(day);
    const last = groups.at(-1);
    if (last?.ranges === ranges && last.to === index - 1) {
      last.to = index;
    } else {
      groups.push({ from: index, to: index, ranges });
    }
  }
  return groups
    .filter((group) => group.ranges !== "")
    .map((group) => {
      const first = dayName(group.from);
      const last = dayName(group.to);
      const { ranges } = group;
      return group.from === group.to
        ? i18n._(
            msg({
              message: `${first}, ${ranges}`,
              comment:
                'A day and its hours: "Wednesday, 8:00 to 12:00, 13:00 to 18:00"',
            })
          )
        : i18n._(
            msg({
              message: `${first} to ${last}, ${ranges}`,
              comment:
                'Days and their hours: "Monday to Friday, 8:00 to 18:00"',
            })
          );
    })
    .join("; ");
};
