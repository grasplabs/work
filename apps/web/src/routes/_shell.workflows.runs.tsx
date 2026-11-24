import { runFilterStatuses } from "@grasp-os/shared/run-filter";
import type { RunFilterStatus } from "@grasp-os/shared/run-filter";
import type {
  RunActivity,
  RunFilter,
  RunsPage,
} from "@grasp-os/shared/workflows";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { RunFiguresView } from "../workflows/figures.tsx";
import { isRunFilterStatus, runsSearchOf } from "../workflows/page-search.ts";
import type { RunsSearch } from "../workflows/page-search.ts";
import {
  listRuns,
  readActivity,
  readWorkflowNames,
} from "../workflows/reads.ts";
import { runFiguresOf } from "../workflows/run-figures.ts";
import { RunsLog } from "../workflows/runs.tsx";
import { TodayLanes } from "../workflows/today-lanes.tsx";
import type { LaneProcesses } from "../workflows/today-lanes.tsx";

// Workflows › Runs: the runs of every workflow the person has a role in.
// Today's runs in time, the figures core counted over the last days, and
// their runs, waiting ones first, filtered by status. The filter is in the
// address, so a link can open the runs it means.

const styles = stylex.create({
  // A filter: what it filters, then the choice.
  filter: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  // "Status is" on one line before its choice.
  filterLabel: { whiteSpace: "nowrap" },
  filters: { display: "flex", flexWrap: "wrap", gap: space["2"] },
  log: { display: "grid", gap: space["4"] },
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
          <Text color="muted" size="sm">
            {t({ message: `${label} is`, context: 'filter: "Place is All"' })}
          </Text>
        </span>
        <Select
          items={items}
          onValueChange={(chosen: string | null) => {
            void navigate({
              search: {
                status: isRunFilterStatus(chosen) ? chosen : undefined,
              },
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
    <RunFiguresView figures={runFiguresOf(read.data)} />
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

/** Who and what the log names, by ID (`readWorkflowNames`). */
type WorkflowNames = Awaited<ReturnType<typeof readWorkflowNames>>;

const noNames: WorkflowNames = {
  people: new Map(),
  workflows: new Map(),
};

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
const RunsLogRead = ({
  log,
  named,
}: {
  log: LogRead;
  named: WorkflowNames;
}) => {
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
          more={read.runs.data.more}
          names={{
            people: named.people,
            me: identity.userId,
          }}
          runs={read.runs.data.runs}
          workflows={named.workflows}
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
      <Page wide>
        <PageHeader title={title} />
        {page.today.state === "ready" ? (
          <TodayLanes
            names={page.named.workflows}
            processes={page.processes}
            today={page.today.data}
          />
        ) : (
          <NotLoadedState page={page.today} />
        )}
        <Figures activity={page.activity} />
        <RunsLogRead log={page.log} named={page.named} />
      </Page>
    </>
  );
};

/**
 * The runs before they are read: the bar and the heading, with the page's
 * parts waiting as lines under them.
 */
const RunsPending = () => {
  const { t } = useLingui();
  const title = t`Runs`;
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Workflows`, to: "/workflows" }, { label: title }]}
      />
      <Page wide>
        <PageHeader title={title} />
        <LoadingLines lines={6} />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/runs")({
  validateSearch: runsSearchOf,
  pendingComponent: RunsPending,
  // Nothing of the address: a filter changed on the page reads the log on
  // its own (RunsLogRead), never today's lanes again. A refresh runs the
  // loader, which reads the log for the address's filter again too.
  loader: async ({ context: { core }, location }) => {
    // The log's read starts now, beside the others, and isn't waited for:
    // for the filter in the address as the page loads or refreshes.
    const filter = filterOf(runsSearchOf(location.search));
    const log: LogRead = {
      key: JSON.stringify(filter),
      read: readRuns(core, filter),
    };
    // The figures likewise: started now, taken by the page once.
    const activity = loadFromCore(core, readActivity);
    const [today, resources, named] = await Promise.all([
      loadFromCore(core, async (session) => await session.workflows.today()),
      // The process each workflow serves, for its lane's mark: none shown
      // where they can't be read.
      loadFromCore(
        core,
        async (session) => await session.workflowResources.list()
      ),
      // Who started each run and each workflow's name, for names only.
      loadFromCore(core, readWorkflowNames),
    ]);
    const processes: LaneProcesses = new Map(
      resources.state === "ready"
        ? resources.data.map((workflow) => [workflow.id, workflow.process])
        : []
    );
    return {
      today,
      processes,
      log,
      activity,
      named: named.state === "ready" ? named.data : noNames,
    };
  },
  component: WorkflowRuns,
});
