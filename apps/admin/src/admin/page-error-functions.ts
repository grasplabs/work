/**
 * Errors the admin's pages hit in the browser (src/admin/page-errors.ts),
 * into the Worker's logs as `admin.page_error` lines: a render the admin
 * can't see otherwise, now that pages render in the browser alone. Behind
 * the Access check and Start's CSRF check every server function passes;
 * the report's shape and lengths are web's (@grasp-os/shared/error-reports).
 * The line leaves out who reported it: the report is about the page, never
 * the person. At most `pageErrorsPerMinute` a minute from each staff
 * member, as core takes web's, so a page in a loop can't flood the logs.
 * Its body isn't bounded here: Start reads it, as it reads every server
 * function's, past the Access check; the line is, by the report's own
 * limits.
 */
import { errorReportSchema } from "@grasp-os/shared/error-reports";
import { log } from "@grasp-os/shared/log";
import { createServerFn } from "@tanstack/react-start";

/** Most reports one staff member makes in a minute; the rest aren't logged. */
export const pageErrorsPerMinute = 10;

/**
 * Reports taken this minute, by staff member. Kept in memory, as a fixed
 * window, as core counts web's (apps/core/src/error-reports.ts): each
 * isolate counts on its own, which bounds a member's reports per isolate,
 * enough to keep a page in a loop from flooding the logs, without a store
 * of its own. The whole map goes when the minute turns.
 */
let counted = { minute: 0, counts: new Map<string, number>() };

/** Counts one report of `email`'s: false once they are past the limit. */
const withinLimit = (email: string): boolean => {
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

export const reportPageErrorFn = createServerFn({ method: "POST" })
  .validator(errorReportSchema)
  .handler(({ data, context }): { logged: boolean } => {
    if (!withinLimit(context.staff.email)) {
      return { logged: false };
    }
    log.error("admin.page_error", data);
    return { logged: true };
  });
