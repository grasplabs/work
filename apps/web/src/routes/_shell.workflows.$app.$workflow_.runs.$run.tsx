import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { historyPageSize, RunHistory } from "../workflows/history-view.tsx";
import { RunResult } from "../workflows/runs.tsx";
import { StopRun } from "../workflows/stop-run.tsx";

// One run of a workflow, reached from the runs log: how it stands, and
// what its engine journaled, step by step and attempt by attempt, a page
// at a time. Core checks every page again; the page shows what it gets.
// The App's builders may stop a run that hasn't ended, asked again first.

const RunPage = () => {
  const { status, history, builds } = Route.useLoaderData();
  const { app, workflow, run } = Route.useParams();
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const crumbs = [
    { label: t`Workflows`, to: "/workflows" },
    {
      label: workflow,
      to: "/workflows/$app/$workflow",
      params: { app, workflow },
    },
    { label: t`Run` },
  ] as const;
  if (status.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowIcon}
        notFound={t`Run not found`}
        page={status}
      />
    );
  }
  const { data: summary } = status;
  const stop = async (): Promise<void> => {
    await core.withSession(
      async (session) => await session.workflows.cancel(run)
    );
    await router.invalidate();
  };
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      {/* As wide as its workflow's page, whose Traces it is one of: the
          prototype opens a run there, at that page's width. */}
      <Page wide>
        <PageHeading
          meta={
            <>
              <RunResult
                aiProvider={summary.aiProvider}
                queued={summary.queued}
                status={summary.status}
              />
              <span className="text-muted-foreground tabular-nums">
                {formatDateTime(summary.createdAt)}
              </span>
            </>
          }
          title={t`Run of ${workflow}`}
          {...(builds && summary.endedAt === null
            ? { action: <StopRun stop={stop} /> }
            : {})}
        />
        {summary.detailsRemoved ? (
          <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
            <Trans>
              This run&apos;s details were removed once its retention was over,
              and its history with them.
            </Trans>
          </p>
        ) : null}
        {!summary.detailsRemoved && history.state === "ready" ? (
          <RunHistory
            // Another run starts with its own history, not this one's.
            key={run}
            first={history.data}
            run={run}
          />
        ) : null}
        {!summary.detailsRemoved && history.state !== "ready" ? (
          <NotLoadedState heading="h2" page={history} />
        ) : null}
      </Page>
    </>
  );
};

export const Route = createFileRoute(
  "/_shell/workflows/$app/$workflow_/runs/$run"
)({
  pendingComponent: PageLoading,
  // The run and its history are read on their own: each says on its
  // own why it failed.
  loader: async ({ context: { core }, params: { app, workflow, run } }) => {
    const [status, history, detail] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflows.status(run)
      ),
      loadFromCore(
        core,
        async (session) =>
          await session.workflows.history(run, {
            pageSize: historyPageSize,
            cursor: null,
          })
      ),
      // Whether the person builds the App, so may stop its runs.
      loadFromCore(
        core,
        async (session) => await session.workflows.get(app, workflow)
      ),
    ]);
    return {
      status,
      history,
      builds: detail.state === "ready" && detail.data.setsParams,
    };
  },
  component: RunPage,
});
