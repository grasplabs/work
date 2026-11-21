/**
 * Errors the admin's pages hit in the browser (src/admin/page-errors.ts),
 * into the Worker's logs as `admin.page_error` lines: a render the admin
 * can't see otherwise, now that pages render in the browser alone. Behind
 * the Access check and Start's CSRF check every server function passes;
 * the report's shape and lengths are web's (@grasp-os/shared/error-reports).
 * The line leaves out who reported it: the report is about the page, never
 * the person. At most `pageErrorsPerMinute` a minute from each staff
 * member (src/admin/page-error-limit.ts), as core takes web's, so a page
 * in a loop can't flood the logs.
 * Its body isn't bounded here: Start reads it, as it reads every server
 * function's, past the Access check; the line is, by the report's own
 * limits.
 */
import { errorReportSchema } from "@grasp-os/shared/error-reports";
import { log } from "@grasp-os/shared/log";
import { createServerFn } from "@tanstack/react-start";

import { withinLimit } from "./page-error-limit.ts";

export const reportPageErrorFn = createServerFn({ method: "POST" })
  .validator(errorReportSchema)
  .handler(({ data, context }): { logged: boolean } => {
    if (!withinLimit(context.staff.email)) {
      return { logged: false };
    }
    log.error("admin.page_error", data);
    return { logged: true };
  });
