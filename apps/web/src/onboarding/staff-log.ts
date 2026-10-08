import { logFilterSchema } from "@grasp-os/shared/onboarding-staff";
import type {
  LogFilter,
  StaffLogEntry,
} from "@grasp-os/shared/onboarding-staff";

// The onboarding's log as Grasp's area shows it (prototype
// `lib/admin-log.ts`): its filters in the address, how much happened on
// each day for the chart, and the export as CSV.

/** The filters in the address, each kept only when core would take it. */
export const logSearchOf = (search: Record<string, unknown>): LogFilter => {
  const { shape } = logFilterSchema;
  const kept: LogFilter = {};
  const actor = shape.actor.safeParse(search.actor);
  if (actor.success && actor.data !== undefined) {
    kept.actor = actor.data;
  }
  const what = shape.what.safeParse(search.what);
  if (what.success && what.data !== undefined) {
    kept.what = what.data;
  }
  const team = shape.team.safeParse(search.team);
  if (team.success && team.data !== undefined && team.data !== "") {
    kept.team = team.data;
  }
  const day = shape.day.safeParse(search.day);
  if (day.success && day.data !== undefined) {
    kept.day = day.data;
  }
  return kept;
};

/** The most days the chart shows, the latest. */
export const chartDaysMax = 60;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * How many entries fall on each day, from the first entry's day to the
 * last's, days without any included, oldest first: at most `chartDaysMax`.
 */
export const perDay = (
  entries: readonly StaffLogEntry[]
): { day: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const { at } of entries) {
    const day = at.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.keys()].toSorted();
  const [first] = days;
  const last = days.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  const end = Date.parse(`${last}T00:00:00Z`);
  const start = Math.max(
    Date.parse(`${first}T00:00:00Z`),
    end - (chartDaysMax - 1) * dayMs
  );
  const shown: { day: string; count: number }[] = [];
  for (let at = start; at <= end; at += dayMs) {
    const day = new Date(at).toISOString().slice(0, 10);
    shown.push({ day, count: counts.get(day) ?? 0 });
  }
  return shown;
};

/**
 * A spreadsheet reads a cell as a formula when it starts with `=`, `+`,
 * `-` or `@`, also after whitespace, or with a tab or carriage return:
 * such a cell gets a `'` in front (CSV injection), as core's audit export.
 */
const formulaStart = /^\s*[=+\-@]|^[\t\r]/u;
const csvQuoted = /[",\r\n]/u;

/** One CSV cell (RFC 4180), safe to open in a spreadsheet. */
const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  const safe = formulaStart.test(text) ? `'${text}` : text;
  return csvQuoted.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const csvRow = (cells: readonly (string | number | null)[]): string =>
  `${cells.map((cell) => csvCell(cell)).join(",")}\r\n`;

/** The log as CSV, as shown: one row per entry, the newest first. */
export const logCsv = (entries: readonly StaffLogEntry[]): string =>
  [
    csvRow(["seq", "at", "actor", "what", "person_id", "person", "team"]),
    ...entries.map((entry) =>
      csvRow([
        entry.seq,
        entry.at,
        entry.actor,
        entry.what,
        entry.person?.id ?? null,
        entry.person?.name ?? null,
        entry.team,
      ])
    ),
  ].join("");
