import { Trans, useLingui } from "@lingui/react/macro";
import { Await, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Activity } from "../dashboard/activity.tsx";
import { readDashboard } from "../dashboard/read-dashboard.ts";
import { ReportBar } from "../dashboard/report-bar.tsx";
import { ReportDialog } from "../dashboard/report-dialog.tsx";
import { programmeLine } from "../dashboard/report.ts";
import { ToDo } from "../dashboard/to-do.tsx";
import { WidgetBoard } from "../dashboard/widget-board.tsx";
import { LoadingLines, PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { NotLoaded } from "../load-from-core.tsx";

// The dashboard, as the prototype's (`routes/dashboard.tsx`, the wide
// `Page` with its `PageHeading`): what waits on the person, each with its
// next step; under it the widget board (widget-board.tsx), the
// prototype's return, goals, teams and workflows, then the engines, the
// runs this week, and what could be better, from the daily signals; and,
// for admins, the latest of what Grasp and people did. With a plan for the interviews, the heading says the programme's
// week and stage, and the weekly report's bar is under what waits: when
// the next report is ready, and its export (report-dialog.tsx), made of
// what core has; the prototype's hours and euros aren't in it. It
// replaces the Notifications page and Settings' pending approvals, which
// lead here.

const DashboardPage = () => {
  const { waiting, board, programme, report, activity } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { i18n, t } = useLingui();
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  // A programme only with a plan; none read, no line and no report.
  const planned = programme.state === "ready" ? programme.data : null;
  const line = planned === null ? undefined : programmeLine(planned, i18n);
  const next = planned?.nextReport;
  const today = planned?.today;
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Dashboard` }]} />
      <Page wide>
        <PageHeading
          description={
            line ?? (
              <Trans>
                What waits on you, each with its next step, and what could be
                better.
              </Trans>
            )
          }
          title={<Trans>Dashboard</Trans>}
        />
        <ToDo identity={identity} waiting={waiting} />
        {next === undefined ||
        line === undefined ||
        today === undefined ? null : (
          <>
            <ReportBar
              next={next}
              onExport={() => {
                // Read again first, so the report is as it stands now,
                // not as it stood when the page was opened.
                void (async () => {
                  await router.invalidate();
                  setExporting(true);
                })();
              }}
            />
            <ReportDialog
              line={line}
              next={next}
              onOpenChange={setExporting}
              open={exporting}
              reads={report}
              today={today}
            />
          </>
        )}
        {/* Each comes as it is read: a slow one holds back nothing else. */}
        <WidgetBoard board={board} />
        {activity === undefined ? null : (
          <Await fallback={<LoadingLines />} promise={activity}>
            {(loaded) =>
              loaded.state === "ready" ? (
                <Activity activity={loaded.data} />
              ) : (
                <NotLoaded page={loaded} />
              )
            }
          </Await>
        )}
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/dashboard")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core, identity } }) =>
    await readDashboard(core, identity),
  component: DashboardPage,
});
