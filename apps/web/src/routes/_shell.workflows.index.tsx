import { businessProcesses } from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { canBuild } from "@grasp-os/shared/roles";
import { runFilterStatuses } from "@grasp-os/shared/run-filter";
import type { RunFilterStatus } from "@grasp-os/shared/run-filter";
import type { WorkflowGoLiveWaiting } from "@grasp-os/shared/workflow-lifecycle";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import type {
  RunActivity,
  RunFilter,
  RunsPage,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@grasp-os/ui/components/button-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { readPeople } from "../directory.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { EmptyCard } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import {
  ProcessGlyph,
  ProcessHint,
  processNames,
} from "../workflows/business-process.tsx";
import { RunFiguresView } from "../workflows/figures.tsx";
import { GoLivesWaiting } from "../workflows/go-lives-waiting.tsx";
import { NewWorkflow } from "../workflows/independent-workflows.tsx";
import { needsAttention, processesIn, showsUnder } from "../workflows/lists.ts";
import { listRuns, listWorkflows, readActivity } from "../workflows/reads.ts";
import { runFiguresOf } from "../workflows/run-figures.ts";
import { RunsLog } from "../workflows/runs.tsx";
import { TodayLanes } from "../workflows/today-lanes.tsx";
import {
  WorkflowsOverview,
  WorkflowLists,
  processOf,
} from "../workflows/workflows-table.tsx";
import type { WorkflowProcesses } from "../workflows/workflows-table.tsx";

// Everything that runs on its own, in one place: every workflow of every
// App the person can open, at work and on the way; those that need a
// person now, with the independent workflows waiting for the reader to
// let them go live; and, on the Runs tab, today's runs in time, the
// figures core counted over the last days and their runs, waiting ones
// first, filtered by status. The lists filter by the
// business process their workflows serve, once they serve more than one.
// The tab and the filters are in the address, so a link can open the runs
// it means. A new workflow is the page's action, in the bar above it.

interface WorkflowsSearch {
  tab?: "needs" | "runs";
  /** On the lists: the business process whose workflows show. */
  process?: BusinessProcess;
  status?: RunFilterStatus;
}

const isStatus = (value: unknown): value is RunFilterStatus =>
  runFilterStatuses.some((status) => status === value);

const isProcess = (value: unknown): value is BusinessProcess =>
  businessProcesses.some((process) => process === value);

/** What the Runs filter says each status is, in words. */
const filterLabels: Readonly<Record<RunFilterStatus, MessageDescriptor>> = {
  waiting: msg`Waiting for a decision`,
  running: msg`Running`,
  failed: msg`Failed`,
  done: msg`Done`,
};

/** The value of a filter that filters nothing. */
const all = "all";

interface Option {
  value: string;
  label: string;
}

/**
 * One filter of the Runs tab, with "All" first, as the prototype draws a
 * filter (Requests' "Place is All"): what it filters, then what it is.
 */
const Filter = ({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: Option[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}) => {
  const { t } = useLingui();
  const items = [{ value: all, label: t`All` }, ...options];
  return (
    <ButtonGroup>
      <ButtonGroupText aria-hidden="true">
        {t({ message: `${label} is`, context: 'filter: "Place is All"' })}
      </ButtonGroupText>
      <Select
        disabled={disabled}
        items={items}
        onValueChange={(chosen: string | null) => {
          onChange(chosen === null || chosen === all ? undefined : chosen);
        }}
        value={value ?? all}
      >
        <SelectTrigger aria-label={label} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ButtonGroup>
  );
};

/** The Runs tab's filter: a status. */
const RunFilters = () => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/" });
  const filterBy = (change: Partial<WorkflowsSearch>): void => {
    void navigate({ search: (previous) => ({ ...previous, ...change }) });
  };
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap gap-2">
      <Filter
        label={t`Status`}
        onChange={(status) => {
          filterBy({ status: isStatus(status) ? status : undefined });
        }}
        options={runFilterStatuses.map((status) => ({
          value: status,
          label: i18n._(filterLabels[status]),
        }))}
        value={search.status}
      />
    </div>
  );
};

/** The processes the lists' workflows serve. */
const offeredOf = (
  workflows: Loaded<WorkflowSummary[]>,
  processes: WorkflowProcesses
): BusinessProcess[] =>
  processesIn(
    workflows.state === "ready"
      ? workflows.data.map((row) => processOf(processes, row))
      : []
  );

/** The workflows serving `process`, at work and on the way. */
const ListedWorkflows = ({
  rows,
  independent,
  processes,
  process,
}: {
  rows: WorkflowSummary[];
  independent: Loaded<WorkflowResource[]>;
  processes: WorkflowProcesses;
  process: BusinessProcess | undefined;
}) => {
  // Which serve the chosen process can't be told: said, not shown fewer.
  if (domainsUnchecked(independent, process)) {
    return <NotLoadedState page={independent} />;
  }
  const shown = rows.filter((row) =>
    showsUnder(process, processOf(processes, row))
  );
  // Filtered to nothing: no invitation to make a first one.
  if (process !== undefined && shown.length === 0) {
    return (
      <EmptyCard>
        <Trans>No workflow serves this process.</Trans>
      </EmptyCard>
    );
  }
  return <WorkflowsOverview processes={processes} rows={shown} />;
};

/**
 * What needs a person: the App workflows whose runs wait, failed lately
 * or whose schedule stopped, and the independent workflows waiting for
 * the reader to let them go live, each serving `process`.
 */
const NeedsAttention = ({
  workflows,
  independent,
  goLives,
  processes,
  process,
  me,
  people,
}: {
  workflows: Loaded<WorkflowSummary[]>;
  independent: Loaded<WorkflowResource[]>;
  goLives: Loaded<WorkflowGoLiveWaiting[]>;
  processes: WorkflowProcesses;
  process: BusinessProcess | undefined;
  me: string;
  people: ReadonlyMap<string, string>;
}) => {
  const rows =
    workflows.state === "ready"
      ? workflows.data.filter(
          (row) =>
            needsAttention(row) &&
            showsUnder(process, processOf(processes, row))
        )
      : [];
  const served = new Map(
    independent.state === "ready"
      ? independent.data.map((workflow) => [workflow.id, workflow.process])
      : []
  );
  const waiting =
    goLives.state === "ready"
      ? goLives.data.filter((each) =>
          showsUnder(process, served.get(each.workflowId) ?? null)
        )
      : [];
  // Under a process, a list whose processes couldn't be read says so
  // rather than showing fewer.
  const independentGone = domainsUnchecked(independent, process);
  const nothing =
    workflows.state === "ready" &&
    goLives.state === "ready" &&
    !independentGone &&
    rows.length === 0 &&
    waiting.length === 0;
  return (
    <div className="mt-4 flex flex-col gap-8">
      {nothing ? (
        <EmptyCard>
          <Trans>
            No workflow needs attention: nothing waits for a decision or to go
            live, nothing failed lately.
          </Trans>
        </EmptyCard>
      ) : null}
      {workflows.state === "ready" ? null : <NotLoadedState page={workflows} />}
      <IndependentUnread
        gone={independentGone}
        independent={independent}
        listed={workflows.state === "ready" || goLives.state === "ready"}
      />
      {independentGone || rows.length === 0 ? null : (
        <WorkflowLists processes={processes} rows={rows} />
      )}
      {goLives.state === "ready" ? null : <NotLoadedState page={goLives} />}
      {goLives.state !== "ready" || independentGone ? null : (
        <GoLivesWaiting names={{ people, me }} waiting={waiting} />
      )}
    </div>
  );
};

/**
 * The figures over the runs, where core counted them for the person. The
 * loader starts their read on every run of it (the page opened, "Try
 * again", a decision answered in the lanes), beside its other reads, so
 * they count the same moment as the lanes; they count a window of days
 * whatever the log's filters, which never read them again.
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

/**
 * The address of a tab: the lists keep the process they filter by, and
 * take none of the runs' filters.
 */
const tabSearch = (
  tab: string,
  process: BusinessProcess | undefined
): WorkflowsSearch => {
  if (tab === "runs") {
    return { tab };
  }
  const kept = process === undefined ? {} : { process };
  return tab === "needs" ? { tab, ...kept } : kept;
};

/**
 * The lists' filter by business process, as the prototype has it: one
 * process at a time, or all, each by its icon, named when pointed at;
 * only the processes the lists' workflows serve, and only once they serve
 * more than one.
 */
const ProcessFilter = ({ offered }: { offered: BusinessProcess[] }) => {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/" });
  if (offered.length < 2 && search.process === undefined) {
    return null;
  }
  return (
    <ToggleGroup
      aria-label={t`Business process`}
      onValueChange={(value: unknown[]) => {
        const [chosen] = value;
        void navigate({
          search: (previous) => ({
            ...previous,
            process: isProcess(chosen) ? chosen : undefined,
          }),
        });
      }}
      value={search.process === undefined ? [] : [search.process]}
      variant="outline"
    >
      {offered.map((process) => (
        <Tooltip key={process}>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                aria-label={i18n._(processNames[process])}
                value={process}
              />
            }
          >
            <ProcessGlyph process={process} />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <ProcessHint process={process} />
          </TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
};

/** How many workflows a tab holds, beside its name, once they are read. */
const WorkflowCount = ({ count }: { count: number | undefined }) => {
  const { t } = useLingui();
  return count === undefined ? null : (
    <TabsCount
      label={t`${plural(count, { one: "# workflow", other: "# workflows" })}`}
    >
      {count}
    </TabsCount>
  );
};

/**
 * Whether `read`, which says which process each workflow serves, failed
 * while a process is chosen: then which serve it can't be told.
 */
/**
 * The independent workflows' processes place rows and go-lives alike:
 * unread under a process, neither list shows, and this says why.
 */
const IndependentUnread = ({
  gone,
  listed,
  independent,
}: {
  gone: boolean;
  listed: boolean;
  independent: Loaded<WorkflowResource[]>;
}) =>
  gone && listed && independent.state !== "ready" ? (
    <NotLoadedState page={independent} />
  ) : null;

const domainsUnchecked = (
  read: Loaded<unknown>,
  process: BusinessProcess | undefined
): read is Exclude<Loaded<unknown>, { state: "ready" }> =>
  process !== undefined && read.state !== "ready";

/**
 * Every workflow the lists show under `process`: the Apps' and the
 * independent ones, listed together.
 */
const countAll = (
  lists: Lists,
  process: BusinessProcess | undefined
): number | undefined =>
  lists.workflows.state === "ready" &&
  !domainsUnchecked(lists.independent, process)
    ? lists.workflows.data.filter((row) =>
        showsUnder(process, processOf(lists.processes, row))
      ).length
    : undefined;

/**
 * What needs a person under `process`: the Apps' workflows that do,
 * and the go-lives waiting.
 */
const countNeeds = (
  lists: Lists,
  process: BusinessProcess | undefined
): number | undefined => {
  if (lists.workflows.state !== "ready" || lists.goLives.state !== "ready") {
    return undefined;
  }
  // Under a process, which go-live serves it is read off the independent
  // workflows, and which App workflow serves it off the Apps:
  // without either it can't be told, so no count rather than one that
  // leaves some out.
  if (domainsUnchecked(lists.independent, process)) {
    return undefined;
  }
  const served = new Map(
    lists.independent.state === "ready"
      ? lists.independent.data.map((workflow) => [
          workflow.id,
          workflow.process,
        ])
      : []
  );
  return (
    lists.workflows.data.filter(
      (row) =>
        needsAttention(row) &&
        showsUnder(process, processOf(lists.processes, row))
    ).length +
    lists.goLives.data.filter((each) =>
      showsUnder(process, served.get(each.workflowId) ?? null)
    ).length
  );
};

/** What the Runs tab's log shows: its runs. */
interface RunsRead {
  runs: Loaded<RunsPage>;
}

/** Reads the runs `filter` lets through. */
const readRuns = async (
  core: CoreConnection,
  filter: RunFilter,
  left?: AbortSignal
): Promise<RunsRead> => ({
  runs: await loadFromCore(
    core,
    async (session) => await listRuns(session, filter),
    left
  ),
});

/** The run filters `search` sets: what the log reads. */
const filterOf = ({ status }: Pick<WorkflowsSearch, "status">): RunFilter =>
  status === undefined ? {} : { status };

/** One read of the log: the filters it was read for, and what it answers. */
interface LogRead {
  key: string;
  read: Promise<RunsRead>;
}

/**
 * The log of runs under its filters. The page's loader starts its read
 * beside the lists and today's lanes, and again on every refresh ("Try
 * again", a decision answered in the lanes), so the log never waits for
 * them and never stays stale. A filter changed here reads the log alone,
 * never the lists, the lanes or the figures. What was read stays while
 * the next read comes; before the first, its lines are loading.
 */
const RunsLogRead = ({ log }: { log: LogRead }) => {
  const core = useCore();
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { status } = Route.useSearch();
  const key = JSON.stringify(filterOf({ status }));
  // The loader's read is taken once, on the first read after that loader
  // run: a later change of filters, back to these too, reads again, as
  // the runs may have moved on since.
  const taken = useRef<LogRead | null>(null);
  const [read, setRead] = useState<{ key: string; data: RunsRead }>();
  useEffect(() => {
    const left = new AbortController();
    const filter = filterOf({ status });
    const fresh = taken.current !== log;
    taken.current = log;
    const load = async (): Promise<void> => {
      const shown = JSON.stringify(filter);
      const data =
        fresh && shown === log.key
          ? await log.read
          : await readRuns(core, filter, left.signal);
      if (!left.signal.aborted) {
        setRead({ key: shown, data });
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
  // Read for other filters than those now chosen: the filters stay, and
  // the log is loading rather than showing runs the filters don't say.
  const current = read.key === key;
  const filtered = status !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <RunFilters />
      {current ? null : <LoadingLines lines={4} />}
      {current && read.data.runs.state === "ready" ? (
        <RunsLog
          empty={filtered ? t`No runs match these filters.` : undefined}
          me={identity.userId}
          more={read.data.runs.data.more}
          runs={read.data.runs.data.runs}
        />
      ) : null}
      {current && read.data.runs.state !== "ready" ? (
        <NotLoadedState page={read.data.runs} />
      ) : null}
    </div>
  );
};

const Workflows = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const search = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/workflows/" });
  const { process } = search;
  const { lists } = page;
  return (
    <>
      <SiteHeader
        // The page's one action, in the bar above it.
        actions={canBuild(identity.role) ? <NewWorkflow /> : undefined}
        crumbs={[{ label: t`Workflows` }]}
      />
      <div className="pb-chat mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pt-7 text-sm">
        <h1 className="sr-only">
          <Trans>Workflows</Trans>
        </h1>
        <Tabs
          onValueChange={(tab: string) => {
            void navigate({
              // The filters are the Runs tab's: the lists keep only their
              // process.
              search: tabSearch(tab, process),
            });
          }}
          value={search.tab ?? "workflows"}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <TabsList aria-label={t`Show workflows`} variant="line">
              <TabsTrigger value="workflows">
                <Trans context="tab listing every workflow">All</Trans>
                <WorkflowCount count={countAll(lists, process)} />
              </TabsTrigger>
              <TabsTrigger value="needs">
                <Trans context="tab listing the workflows that need a person">
                  Needs you
                </Trans>
                <WorkflowCount count={countNeeds(lists, process)} />
              </TabsTrigger>
              <TabsTrigger value="runs">
                <Trans context="tab listing the runs of workflows">Runs</Trans>
              </TabsTrigger>
            </TabsList>
            {page.tab === "runs" ? null : (
              <ProcessFilter
                offered={offeredOf(lists.workflows, lists.processes)}
              />
            )}
          </div>
          <TabsContent value="workflows">
            {page.tab === "workflows" ? (
              <div className="mt-4 flex flex-col gap-8">
                {lists.workflows.state === "ready" ? (
                  <ListedWorkflows
                    independent={lists.independent}
                    process={process}
                    processes={lists.processes}
                    rows={lists.workflows.data}
                  />
                ) : (
                  <NotLoadedState page={lists.workflows} />
                )}
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="needs">
            {page.tab === "needs" ? (
              <NeedsAttention
                goLives={lists.goLives}
                independent={lists.independent}
                me={identity.userId}
                people={page.people}
                process={process}
                processes={lists.processes}
                workflows={lists.workflows}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="runs">
            {/* Today's runs in time, over the figures and the log of
                them, as the prototype has it. Only while the tab shows:
                the lanes read again every so often only then. */}
            {page.tab === "runs" ? (
              <div className="mt-4 flex flex-col gap-8">
                {page.today.state === "ready" ? (
                  <TodayLanes
                    processes={lists.processes}
                    today={page.today.data}
                  />
                ) : (
                  <NotLoadedState page={page.today} />
                )}
                <Figures activity={page.activity} />
                <RunsLogRead log={page.log} />
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
};

/** The business process each workflow serves, by its ID. */
const processesOf = (
  independent: Loaded<WorkflowResource[]>
): WorkflowProcesses =>
  new Map(
    independent.state === "ready"
      ? independent.data.map((workflow) => [workflow.id, workflow.process])
      : []
  );

/**
 * What the lists show, read on every tab, as the tabs count them: the
 * Apps' workflows, the independent ones, the processes the Apps
 * serve, and the go-lives waiting for the reader.
 */
interface Lists {
  workflows: Loaded<WorkflowSummary[]>;
  independent: Loaded<WorkflowResource[]>;
  processes: WorkflowProcesses;
  goLives: Loaded<WorkflowGoLiveWaiting[]>;
}

const readLists = async (core: CoreConnection): Promise<Lists> => {
  const [workflows, independent, goLives] = await Promise.all([
    loadFromCore(core, listWorkflows),
    loadFromCore(
      core,
      async (session) => await session.workflowResources.list()
    ),
    loadFromCore(
      core,
      async (session) => await session.workflowResources.lifecycle.waiting()
    ),
  ]);
  return {
    workflows,
    independent,
    processes: processesOf(independent),
    goLives,
  };
};

/** What the address says the page shows, as far as it is valid. */
const searchOf = (search: Record<string, unknown>): WorkflowsSearch => ({
  ...(search.tab === "runs" || search.tab === "needs"
    ? { tab: search.tab }
    : {}),
  ...(search.tab !== "runs" && isProcess(search.process)
    ? { process: search.process }
    : {}),
  ...(isStatus(search.status) ? { status: search.status } : {}),
});

export const Route = createFileRoute("/_shell/workflows/")({
  validateSearch: searchOf,
  // The tab alone: the process filters what was read, and a run filter
  // changed on the page reads the log on its own (RunsLogRead), so
  // choosing either reads neither the lists nor today's lanes again. A
  // refresh runs the loader, which reads the log for the address's
  // filters again too.
  loaderDeps: ({ search: { tab } }) => ({ tab }),
  // Every tab reads the lists, as the tabs count them; besides, each tab
  // reads only what it shows, and each read says on its own why it failed.
  loader: async ({ context: { core }, deps: { tab }, location }) => {
    if (tab !== "runs") {
      const [lists, people] = await Promise.all([
        readLists(core),
        // Names only, on Needs you: IDs stand in for anyone not listed in
        // time.
        tab === "needs" ? loadFromCore(core, readPeople) : undefined,
      ]);
      return {
        tab: tab === "needs" ? ("needs" as const) : ("workflows" as const),
        lists,
        people:
          people?.state === "ready" ? people.data : new Map<string, string>(),
      };
    }
    // The log's read starts now, beside the others, and isn't waited for:
    // for the filters in the address as the page loads or refreshes.
    const filter = filterOf(searchOf(location.search));
    const log: LogRead = {
      key: JSON.stringify(filter),
      read: readRuns(core, filter),
    };
    // The figures likewise: started now, taken by the page once.
    const activity = loadFromCore(core, readActivity);
    const [lists, today] = await Promise.all([
      readLists(core),
      loadFromCore(core, async (session) => await session.workflows.today()),
    ]);
    return { tab: "runs" as const, lists, today, log, activity };
  },
  component: Workflows,
});
