// Dates as ISO strings ("2026-11-20"), worked on in the local calendar: the presets of a date range
// picker (date-range-picker.tsx). No time and no time zone, as UI SDK's calendar takes them.

const pad = (value: number) => String(value).padStart(2, "0");

/** A local date as an ISO date. */
export const isoOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** An ISO date as a local date at noon, so a change of clocks never moves it a day. */
export const dateOf = (iso: string) => {
  const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
};

/** The ISO date `days` after `iso` (before, when negative). */
export const addDays = (iso: string, days: number) => {
  const date = dateOf(iso);
  date.setDate(date.getDate() + days);
  return isoOf(date);
};

/** The first and the last day of the month `iso` is in, `months` later. */
export const monthOf = (iso: string, months = 0): [string, string] => {
  const date = dateOf(iso);
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
  const last = new Date(
    date.getFullYear(),
    date.getMonth() + months + 1,
    0,
    12
  );
  return [isoOf(first), isoOf(last)];
};
