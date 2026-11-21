/**
 * Errors the admin's pages hit in the browser (src/admin/page-errors.ts),
 * into the Worker's logs as `admin.page_error` lines: a render the admin
 * can't see otherwise, now that pages render in the browser alone. Behind
 * the Access check and Start's CSRF check every server function passes;
 * the report's shape and lengths are web's (@grasp-os/shared/error-reports).
 * The line leaves out who reported it: the report is about the page, never
 * the person.
 */
import { errorReportSchema } from "@grasp-os/shared/error-reports";
import { log } from "@grasp-os/shared/log";
import { createServerFn } from "@tanstack/react-start";

export const reportPageErrorFn = createServerFn({ method: "POST" })
  .validator(errorReportSchema)
  .handler(({ data }) => {
    log.error("admin.page_error", data);
  });
