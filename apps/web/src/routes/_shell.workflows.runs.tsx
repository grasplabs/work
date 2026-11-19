import { runFilterStatuses } from "@grasp-os/shared/run-filter";
import type { RunFilterStatus } from "@grasp-os/shared/run-filter";
import { runActivityDefaultDays } from "@grasp-os/shared/workflows";
import type {
  RunActivity,
  RunFilter,
  RunsPage,
} from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonDashboard } from "../grasp/blocks/page-skeleton-dashboard/page-skeleton-dashboard.tsx";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { RunFiguresView } from "../workflows/figures.tsx";
import { listRuns, readActivity } from "../workflows/reads.ts";
import { runFiguresOf } from "../workflows/run-figures.ts";
import { RunsLog } from "../workflows/runs.tsx";
import { TodayLanes } from "../workflows/today-lanes.tsx";
import type { LaneProcesses } from "../workflows/today-lanes.tsx";

// Workflows › Runs: the runs of every workflow the person has a role in.
// Today's runs in time, the figures core counted over the last days, and
// their runs, waiting ones first, filtered by status. The filter is in the
// address, so a link can open the runs it means.

interface RunsSearch {
  status?: RunFilterStatus;
}

const isStatus = (value: unknown): value is RunFilterStatus =>
  runFilterStatuses.some((status) => status === value);

const styles = stylex.create({
  // A filter: what it filters, then the choice.
  filter: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
  // "Status is" on one line before its choice.
  filterLabel: { whiteSpace: "nowrap" },
  filters: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  log: { display: "grid", gap: grasp.space4 },
});

/** What the filter says each status is, in words. */
const filterLabels: Readonly<Record<RunFilterStatus, MessageDescriptor>> = {
  waiting: msg`Waiting for a decision`,
  running: msg`Running`,
  failed: msg`Failed`,
  done: msg`Done`,
};

/** The value of a filter that filters nothing. */
const all = "all";

/**
 * The log's filter by status, with "All" first, as the prototype draws a
 * filter (Requests' "Place is All"): what it filters, then what it is.
 */
const StatusFilter = () => {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/runs" });
  const label = t`Status`;
  const items = [
    { value: all, label: t`All` },
    ...runFilterStatuses.map((status) => ({
      value: status,
      label: i18n._(filterLabels[status]),
    })),
  ];
  return (
    <div {...stylex.props(styles.filters)}>
      <span {...stylex.props(styles.filter)}>
        <span aria-hidden="true" {...stylex.props(styles.filterLabel)}>
          <Text size="sm" tone="muted">
            {t({ message: `${label} is`, context: 'filter: "Place is All"' })}
          </Text>
        </span>
        <Select
          items={items}
          onValueChange={(chosen: string | null) => {
            void navigate({
              search: { status: isStatus(chosen) ? chosen : undefined },
            });
          }}
          value={search.status ?? all}
        >
          <SelectTrigger aria-label={label} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      </span>
    </div>
  );
};

/**
 * The figures over the runs, where core counted them for the person. The
 * loader starts their read on every run of it (the page opened, "Try
 * again", a decision answered in the lanes), beside its other reads, so
 * they count the same moment as the lanes; they count a window of days
 * whatever the log's filter, which never reads them again.
 */
const Figures = ({
  activity,
}: {
  activity: Promise<Loaded<RunActivity | null>>;
}) => {
  const [read, setRead] = useState<Loaded<RunActivity | null>>();
  useEffect(() => {
    let current = true;
    const settle = async (): Promise<void> => {
      const loaded = await activity;
      if (current) {
        setRead(loaded);
      }
    };
    void settle();
    return () => {
      current = false;
    };
  }, [activity]);
  return read?.state === "ready" && read.data !== null ? (
    <RunFiguresView figures={runFiguresOf(read.data)} scope="all" />
  ) : null;
};

/** Reads the runs `filter` lets through. */
const readRuns = async (
  core: CoreConnection,
  filter: RunFilter,
  left?: AbortSignal
): Promise<Loaded<RunsPage>> =>
  await loadFromCore(
    core,
    async (session) => await listRuns(session, filter),
    left
  );

/** The run filter `search` sets: what the log reads. */
const filterOf = ({ status }: RunsSearch): RunFilter =>
  status === undefined ? {} : { status };

/** One read of the log: the filter it was read for, and what it answers. */
interface LogRead {
  key: string;
  read: Promise<Loaded<RunsPage>>;
}

/**
 * The log of runs under its filter. The page's loader starts its read
 * beside today's lanes, and again on every refresh ("Try again", a
 * decision answered in the lanes), so the log never waits for them and
 * never stays stale. A filter changed here reads the log alone, never the
 * lanes or the figures. What was read stays while the next read comes;
 * before the first, its lines are loading.
 */
const RunsLogRead = ({ log }: { log: LogRead }) => {
  const core = useCore();
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { status } = Route.useSearch();
  const key = JSON.stringify(filterOf({ status }));
  // The loader's read is taken once, on the first read after that loader
  // run: a later change of filter, back to this one too, reads again, as
  // the runs may have moved on since.
  const taken = useRef<LogRead | null>(null);
  const [read, setRead] = useState<{ key: string; runs: Loaded<RunsPage> }>();
  useEffect(() => {
    const left = new AbortController();
    const filter = filterOf({ status });
    const fresh = taken.current !== log;
    taken.current = log;
    const load = async (): Promise<void> => {
      const shown = JSON.stringify(filter);
      const runs =
        fresh && shown === log.key
          ? await log.read
          : await readRuns(core, filter, left.signal);
      if (!left.signal.aborted) {
        setRead({ key: shown, runs });
      }
    };
    void load();
    return () => {
      left.abort();
    };
  }, [core, log, status]);
  if (read === undefined) {
    return <LoadingLines lines={4} />;
  }
  // Read for another filter than the one now chosen: the filter stays, and
  // the log is loading rather than showing runs the filter doesn't say.
  const current = read.key === key;
  return (
    <div {...stylex.props(styles.log)}>
      <StatusFilter />
      {current ? null : <LoadingLines lines={4} />}
      {current && read.runs.state === "ready" ? (
        <RunsLog
          empty={
            status === undefined ? undefined : t`No runs match these filters.`
          }
          me={identity.userId}
          more={read.runs.data.more}
          runs={read.runs.data.runs}
        />
      ) : null}
      {current && read.runs.state !== "ready" ? (
        <NotLoadedState page={read.runs} />
      ) : null}
    </div>
  );
};

const WorkflowRuns = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const title = t`Runs`;
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Workflows`, to: "/workflows" }, { label: title }]}
      />
      <Page>
        <PageHeading title={title} />
        {page.today.state === "ready" ? (
          <TodayLanes processes={page.processes} today={page.today.data} />
        ) : (
          <NotLoadedState page={page.today} />
        )}
        <Figures activity={page.activity} />
        <RunsLogRead log={page.log} />
      </Page>
    </>
  );
};

/** Nothing to show in a cell while the runs are read. */
const none = (): string => "";

/**
 * The runs before they are read: the bar, the header, today's lanes, the
 * figures and the log's table waiting with its columns (workflows/runs.tsx).
 */
const RunsPending = () => {
  const { t } = useLingui();
  const days = runActivityDefaultDays;
  const title = t`Runs`;
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Workflows`, to: "/workflows" }, { label: title }]}
      />
      <PageSkeletonDashboard<RunsPage["runs"][number]>
        // As the page lays it out: today's lanes, the figures, then the log.
        chart={{
          title: t({
            message: "Today",
            context: "the workflows' runs of today, laid out in time",
          }),
        }}
        descriptionLines={0}
        stats={{
          "aria-label": t`The runs, in figures`,
          titles: [
            t`${plural(days, {
              one: "runs started today",
              other: "runs started in the last # days",
            })}`,
            t`without a person`,
            t`of them wait for a decision`,
          ],
        }}
        table={{
          label: title,
          columns: [
            {
              key: "when",
              header: t({
                message: "When",
                context: "column: when a run happened",
              }),
              value: none,
            },
            { key: "workflow", header: t`Workflow`, value: none },
            { key: "by", header: t`Started by`, value: none },
            {
              key: "result",
              header: t({
                message: "Result",
                context: "column: what happened in a run",
              }),
              value: none,
            },
          ],
        }}
      />
    </>
  );
};

/** What the address says the page shows, as far as it is valid. */
const searchOf = (search: Record<string, unknown>): RunsSearch =>
  isStatus(search.status) ? { status: search.status } : {};

export const Route = createFileRoute("/_shell/workflows/runs")({
  validateSearch: searchOf,
  pendingComponent: RunsPending,
  // Nothing of the address: a filter changed on the page reads the log on
  // its own (RunsLogRead), never today's lanes again. A refresh runs the
  // loader, which reads the log for the address's filter again too.
  loader: async ({ context: { core }, location }) => {
    // The log's read starts now, beside the others, and isn't waited for:
    // for the filter in the address as the page loads or refreshes.
    const filter = filterOf(searchOf(location.search));
    const log: LogRead = {
      key: JSON.stringify(filter),
      read: readRuns(core, filter),
    };
    // The figures likewise: started now, taken by the page once.
    const activity = loadFromCore(core, readActivity);
    const [today, resources] = await Promise.all([
      loadFromCore(core, async (session) => await session.workflows.today()),
      // The process each workflow serves, for its lane's mark: none shown
      // where they can't be read.
      loadFromCore(
        core,
        async (session) => await session.workflowResources.list()
      ),
    ]);
    const processes: LaneProcesses = new Map(
      resources.state === "ready"
        ? resources.data.map((workflow) => [workflow.id, workflow.process])
        : []
    );
    return { today, processes, log, activity };
  },
  component: WorkflowRuns,
});
