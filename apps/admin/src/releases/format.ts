import { formatDate } from "../admin/words.ts";

/**
 * A moment as every page of the admin shows one: the day as dates are
 * written everywhere else ("12 Nov 2026"), then the time, `12 Nov 2026,
 * 20:17`, in UTC, the same on the server and in the browser.
 */
export const formatTime = (time: Date): string => {
  const iso = time.toISOString();
  return `${formatDate(iso)}, ${iso.slice(11, 16)}`;
};
