/** The days of a UTC month such as `2026-10`. */
const daysIn = (month: string): number => {
  const [year = 0, number = 0] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
};

/**
 * Where a month's spend ends if the rest of it goes like the days so far;
 * none while `month` (UTC, such as `2026-10`) isn't the month of `now`.
 */
export const monthEnd = (
  spent: number,
  month: string,
  now: Date
): number | null => {
  if (now.toISOString().slice(0, 7) !== month) {
    return null;
  }
  return (spent / now.getUTCDate()) * daysIn(month);
};
