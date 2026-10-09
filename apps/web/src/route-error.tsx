import { failureText, withReference } from "@grasp-os/shared/errors";
import { useLingui } from "@lingui/react/macro";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isFileGone, isPageFault, reportError } from "./error-reports.ts";
import { PageError } from "./frame/page-states.tsx";

/**
 * Why a route failed, in words for the person: core's reason with its
 * reference, or, for a fault of the page's own, a plain "something went
 * wrong" with the reference its report got, so the person can quote
 * either. The page's own errors never show their message: it names code,
 * not anything the person can act on.
 */
export const useRouteErrorReason = (error: unknown): string | undefined => {
  const { t } = useLingui();
  const [reference, setReference] = useState<{
    error: unknown;
    requestId?: string;
  }>();
  useEffect(() => {
    let current = true;
    const report = async (): Promise<void> => {
      const requestId = await reportError("render", error);
      if (current) {
        setReference({ error, requestId });
      }
    };
    void report();
    return () => {
      current = false;
    };
  }, [error]);
  if (isFileGone(error)) {
    return t`Grasp was updated while this page was open. Try again to load the new version.`;
  }
  return isPageFault(error)
    ? withReference(
        t`Something went wrong.`,
        reference !== undefined && reference.error === error
          ? reference.requestId
          : undefined
      )
    : failureText(error);
};

/**
 * What a page shows in place of itself when it failed, whatever the
 * route. Trying again loads Grasp anew when the page's file is gone.
 */
export const RouteError = ({ error }: ErrorComponentProps) => (
  <PageError reason={useRouteErrorReason(error)} reload={isFileGone(error)} />
);
