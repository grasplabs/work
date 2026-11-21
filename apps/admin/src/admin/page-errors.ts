/**
 * Reports what the admin's pages hit in the browser to its Worker
 * (src/admin/page-error-functions.ts), as web reports to core
 * (apps/web/src/error-reports.ts): a route that failed (the router's
 * `defaultOnCatch`, src/router.tsx), what is thrown and never caught, and
 * promises that reject with nobody to handle them. Each error once per
 * page load, by message and stack, while a report of it is on its way or
 * once one was taken. Reporting never changes what the page does.
 */
import { errorReportLimits } from "@grasp-os/shared/error-reports";
import type { ErrorReport } from "@grasp-os/shared/error-reports";
import { messageOf } from "@grasp-os/shared/errors";
import { createIsomorphicFn } from "@tanstack/react-start";

import { reportPageErrorFn } from "./page-error-functions.ts";

/** The build the page runs, set when it was built. */
const build = import.meta.env.VITE_GRASP_BUILD.slice(
  0,
  errorReportLimits.build
);

/**
 * What became of a report: logged, refused as past the staff member's
 * limit for the minute, or not answered (offline, or the Worker failed).
 */
type Sent = "logged" | "refused" | "failed";

/** Errors reported since the page loaded, by message and stack. */
const reported = new Map<string, Promise<Sent>>();

/** How long until the Worker's minute turns, when it takes reports again. */
const untilTheMinuteTurns = (): number => 60_000 - (Date.now() % 60_000);

/** Where the page is: its route's pattern, never the URL itself. */
let routeNow = (): string => "unknown";

/** Sends `report`: what became of it. */
const send = async (report: ErrorReport): Promise<Sent> => {
  try {
    const { logged } = await reportPageErrorFn({ data: report });
    return logged ? "logged" : "refused";
  } catch {
    return "failed";
  }
};

/**
 * Reports `error`, once per page load for the same message and stack,
 * and one the Worker refused as past the limit not again within its
 * minute. Never rejects.
 */
export const reportPageError = async (
  kind: ErrorReport["kind"],
  error: unknown
): Promise<void> => {
  try {
    const message = messageOf(error).slice(0, errorReportLimits.message);
    const stack =
      error instanceof Error
        ? error.stack?.slice(0, errorReportLimits.stack)
        : undefined;
    const seen = `${message}\n${stack ?? ""}`;
    if (reported.has(seen)) {
      return;
    }
    const sent = send({
      kind,
      message,
      ...(stack === undefined ? {} : { stack }),
      route: routeNow().slice(0, errorReportLimits.route),
      build,
    });
    reported.set(seen, sent);
    const outcome = await sent;
    if (outcome === "failed") {
      // Not answered: the next time the error comes, it is reported again.
      reported.delete(seen);
    } else if (outcome === "refused") {
      // Past the limit: not sent again until the Worker would take it.
      setTimeout(() => {
        reported.delete(seen);
      }, untilTheMinuteTurns());
    }
  } catch {
    // Something thrown that can't even be read as text: let it go.
  }
};

/**
 * In the browser alone, reports what the page throws and never catches,
 * and promises nobody handles; `route` says which route's pattern the page
 * is on when one comes. Nothing on the server, which renders no page.
 */
export const reportUncaughtErrors = createIsomorphicFn().client(
  (route: () => string | undefined): void => {
    routeNow = () => route() ?? "unknown";
    window.addEventListener("error", (event) => {
      // A resource that failed to load has no error: not a fault of code.
      if (event.error !== undefined && event.error !== null) {
        void reportPageError("uncaught", event.error);
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      void reportPageError("unhandled_rejection", event.reason);
    });
  }
);
