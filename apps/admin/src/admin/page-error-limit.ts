/**
 * How many page error reports the admin's Worker logs from each staff
 * member (src/admin/page-error-functions.ts). The Worker's alone: a server
 * function's file keeps nothing at its module scope the browser needn't
 * see (server-only-check.ts).
 */
import "@tanstack/react-start/server-only";

/** Most reports one staff member makes in a minute; the rest aren't logged. */
export const pageErrorsPerMinute = 10;

/**
 * Reports taken this minute, by staff member. Kept in memory, as a fixed
 * window, as core counts web's (apps/core/src/error-reports.ts): each
 * isolate counts on its own, so the bound is per isolate. It is there to
 * keep a page in a loop from flooding the logs, not as a security
 * boundary: staff are past the Access check. The whole map goes when the
 * minute turns.
 */
let counted = { minute: 0, counts: new Map<string, number>() };

/** Counts one report of `email`'s: false once they are past the limit. */
export const withinLimit = (email: string): boolean => {
  const minute = Math.floor(Date.now() / 60_000);
  if (counted.minute !== minute) {
    counted = { minute, counts: new Map() };
  }
  const count = counted.counts.get(email) ?? 0;
  if (count >= pageErrorsPerMinute) {
    return false;
  }
  counted.counts.set(email, count + 1);
  return true;
};
