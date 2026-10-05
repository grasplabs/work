import { Trans, useLingui } from "@lingui/react/macro";
import { Await, createFileRoute } from "@tanstack/react-router";

import { Activity } from "../dashboard/activity.tsx";
import { readDashboard } from "../dashboard/read-dashboard.ts";
import { CouldBeBetter } from "../dashboard/signals.tsx";
import { ToDo } from "../dashboard/to-do.tsx";
import { LoadingLines, PageLoading } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { NotLoaded } from "../load-from-core.tsx";

// The dashboard, as the right-hand column of the prototype's
// (`routes/dashboard.tsx`): what waits on the person, each with its next
// step; what could be better, from the daily signals; and, for admins, the
// latest of what Grasp and people did. The board report on the
// prototype's left is left out: every number there comes from hours core
// doesn't have. It replaces the Notifications page and Settings' pending
// approvals, which lead here.

const DashboardPage = () => {
  const { waiting, signals, activity } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Dashboard` }]} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-7 text-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium tracking-tight">
            <Trans>Dashboard</Trans>
          </h1>
          <p className="text-muted-foreground">
            <Trans>
              What waits on you, each with its next step, and what could be
              better.
            </Trans>
          </p>
        </div>
        <ToDo identity={identity} waiting={waiting} />
        {/* Each comes as it is read: a slow one holds back nothing else. */}
        <Await fallback={<LoadingLines />} promise={signals}>
          {(loaded) =>
            loaded.state === "ready" ? (
              <CouldBeBetter signals={loaded.data} />
            ) : (
              <NotLoaded page={loaded} />
            )
          }
        </Await>
        {activity === undefined ? null : (
          <Await fallback={<LoadingLines />} promise={activity}>
            {(loaded) =>
              loaded.state === "ready" ? (
                <Activity records={loaded.data} />
              ) : (
                <NotLoaded page={loaded} />
              )
            }
          </Await>
        )}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/dashboard")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core, identity } }) =>
    await readDashboard(core, identity),
  component: DashboardPage,
});
