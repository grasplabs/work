import type { ErrorComponentProps } from "@tanstack/react-router";

import { isFileGone } from "./error-reports.ts";
import { PageError } from "./frame/page-states.tsx";
import { useRouteErrorReason } from "./route-error-reason.ts";

/**
 * What a page shows in place of itself when it failed, whatever the
 * route. Trying again loads Grasp anew when the page's file is gone.
 */
export const RouteError = ({ error }: ErrorComponentProps) => (
  <PageError reason={useRouteErrorReason(error)} reload={isFileGone(error)} />
);
