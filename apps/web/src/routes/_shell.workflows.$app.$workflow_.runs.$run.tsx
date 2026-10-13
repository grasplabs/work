import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { historyPageSize, RunHistory } from "../workflows/history-view.tsx";
import { RunResult } from "../workflows/runs.tsx";

// One run of a workflow, reached from the runs log: how it stands, and
// what its engine journaled, step by step and attempt by attempt, a page
// at a time. Core checks every page again; the page shows what it gets.

const RunPage = () => {
  const { status, history } = Route.useLoaderData();
  const { app, workflow, run } = Route.useParams();
  const { t } = useLingui();
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
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6 text-sm">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {t`Run of ${workflow}`}
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
            <RunResult status={summary.status} />
            <span className="tabular-nums">
              {formatDateTime(summary.createdAt)}
            </span>
          </div>
        </div>
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
      </div>
    </>
  );
};

export const Route = createFileRoute(
  "/_shell/workflows/$app/$workflow_/runs/$run"
)({
  pendingComponent: PageLoading,
  // The run and its history are read on their own: each says on its
  // own why it failed.
  loader: async ({ context: { core }, params: { run } }) => {
    const [status, history] = await Promise.all([
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
    ]);
    return { status, history };
  },
  component: RunPage,
});
