import type { App } from "@grasp-os/shared/apps";
import { businessProcesses } from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { canBuild } from "@grasp-os/shared/roles";
import { runFilterStatuses } from "@grasp-os/shared/run-filter";
import type { RunFilterStatus } from "@grasp-os/shared/run-filter";
import type { WorkflowGoLiveWaiting } from "@grasp-os/shared/workflow-lifecycle";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import type { RunActivity, WorkflowSummary } from "@grasp-os/shared/workflows";
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
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { Session } from "../core.ts";
import { listedOrNone, readPeople } from "../directory.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
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
import { IndependentWorkflows } from "../workflows/independent-workflows.tsx";
import { needsAttention, processesIn, showsUnder } from "../workflows/lists.ts";
import {
  listRuns,
  listWorkflows,
  openableApps,
  readActivity,
} from "../workflows/reads.ts";
import { runFiguresOf } from "../workflows/run-figures.ts";
import { RunsLog } from "../workflows/runs.tsx";
import { TodayLanes } from "../workflows/today-lanes.tsx";
import {
  WorkflowsOverview,
  WorkflowsTable,
} from "../workflows/workflows-table.tsx";
import type { AppProcesses } from "../workflows/workflows-table.tsx";

// Everything that runs on its own, in one place: every workflow of every
// App the person can open, at work and on the way; those that need a
// person now, with the independent workflows waiting for the reader to
// let them go live; and, on the Runs tab, the figures core counted over
// the last days and their runs, waiting ones first, filtered by App,
// workflow and status. The lists filter by the business process their
// workflows serve, once they serve more than one. The tab and the filters
// are in the address, so a link can open the runs it means. Each tab
// reads only what it shows: changing a filter reads the runs again, never
// the list of workflows.

interface WorkflowsSearch {
  tab?: "needs" | "runs";
  /** On the lists: the business process whose workflows show. */
  process?: BusinessProcess;
  /** On the Runs tab: the day's lanes, rather than the log. */
  view?: "today";
  app?: string;
  workflow?: string;
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

/**
 * What the Runs tab's filters offer: the Apps, and the chosen App's
 * workflows, or null when they couldn't be read.
 */
interface FilterOptions {
  apps: Option[];
  workflows: string[] | null;
}

/**
 * The Apps the person can open, and the workflows of `app`'s current
 * version once one is chosen: one App's contents, never every App's. An
 * App whose contents can't be read has its workflows unavailable (null),
 * and its runs are still listed.
 */
const filterOptions = async (
  session: Session,
  app: string | undefined
): Promise<FilterOptions> => {
  const workflowsOf = async (): Promise<string[] | null> => {
    if (app === undefined) {
      return [];
    }
    try {
      const { workflows } = await session.apps.contents(app);
      return workflows;
    } catch {
      return null;
    }
  };
  const [apps, workflows] = await Promise.all([
    openableApps(session),
    workflowsOf(),
  ]);
  return {
    apps: apps.map(({ id, name }) => ({ value: id, label: name })),
    workflows,
  };
};

interface Option {
  value: string;
  label: string;
}

/** One filter of the Runs tab, with "All" first. */
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
    <Select
      disabled={disabled}
      items={items}
      onValueChange={(chosen: string | null) => {
        onChange(chosen === null || chosen === all ? undefined : chosen);
      }}
      value={value ?? all}
    >
      <SelectTrigger aria-label={label} className="min-w-40">
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
  );
};

/**
 * The Runs tab's filters: an App, then one of its workflows (none to pick
 * before an App is), and a status.
 */
const RunFilters = ({ options }: { options: FilterOptions }) => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/" });
  const filterBy = (change: Partial<WorkflowsSearch>): void => {
    void navigate({ search: (previous) => ({ ...previous, ...change }) });
  };
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap gap-2">
      <Filter
        label={t`Domain`}
        onChange={(app) => {
          // A workflow of another App finds nothing in this one.
          filterBy({ app, workflow: undefined });
        }}
        options={options.apps}
        value={search.app}
      />
      <Filter
        // Nothing to pick from while the App's workflows can't be read.
        disabled={options.workflows === null}
        label={t`Workflow`}
        onChange={(workflow) => {
          filterBy({ workflow });
        }}
        options={(options.workflows ?? []).map((name) => ({
          value: name,
          label: name,
        }))}
        value={search.workflow}
      />
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
      {options.workflows === null ? (
        <p className="text-destructive self-center text-sm">
          <Trans>Couldn&apos;t load this domain&apos;s workflows.</Trans>
        </p>
      ) : null}
    </div>
  );
};

/** The independent workflows serving `process`, or why they couldn't be read. */
const Independent = ({
  page,
  canCreate,
  process,
}: {
  page: Loaded<WorkflowResource[]>;
  canCreate: boolean;
  process: BusinessProcess | undefined;
}) =>
  page.state === "ready" ? (
    <IndependentWorkflows
      canCreate={canCreate}
      filtered={process !== undefined}
      workflows={page.data.filter((workflow) =>
        showsUnder(process, workflow.process)
      )}
    />
  ) : (
    <NotLoadedState page={page} />
  );

/**
 * The processes the lists' workflows serve: an App workflow its App's, an
 * independent one its own.
 */
const offeredOf = (
  workflows: Loaded<WorkflowSummary[]>,
  independent: Loaded<WorkflowResource[]>,
  processes: AppProcesses
): BusinessProcess[] =>
  processesIn([
    ...(workflows.state === "ready"
      ? workflows.data.map((row) => processes.get(row.app) ?? null)
      : []),
    ...(independent.state === "ready"
      ? independent.data.map((workflow) => workflow.process)
      : []),
  ]);

/** The App workflows serving `process`, at work and on the way. */
const AppWorkflows = ({
  rows,
  processes,
  process,
}: {
  rows: WorkflowSummary[];
  processes: AppProcesses;
  process: BusinessProcess | undefined;
}) => {
  const shown = rows.filter((row) =>
    showsUnder(process, processes.get(row.app) ?? null)
  );
  // Filtered to nothing: no invitation to make a first one.
  if (process !== undefined && shown.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>No workflow of a domain serves this process.</Trans>
      </p>
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
  processes: AppProcesses;
  process: BusinessProcess | undefined;
  me: string;
  people: ReadonlyMap<string, string>;
}) => {
  const rows =
    workflows.state === "ready"
      ? workflows.data.filter(
          (row) =>
            needsAttention(row) &&
            showsUnder(process, processes.get(row.app) ?? null)
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
  const nothing =
    workflows.state === "ready" &&
    goLives.state === "ready" &&
    rows.length === 0 &&
    waiting.length === 0;
  return (
    <div className="mt-4 flex flex-col gap-8">
      {nothing ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
          <Trans>
            No workflow needs attention: nothing waits for a decision or to go
            live, nothing failed lately.
          </Trans>
        </p>
      ) : null}
      {workflows.state === "ready" ? null : <NotLoadedState page={workflows} />}
      {rows.length === 0 ? null : (
        <WorkflowsTable processes={processes} rows={rows} />
      )}
      {goLives.state === "ready" ? (
        <GoLivesWaiting names={{ people, me }} waiting={waiting} />
      ) : (
        <NotLoadedState page={goLives} />
      )}
    </div>
  );
};

/**
 * The figures over the runs, where core counted them for the person: read
 * once while the Runs tab shows, as they count a window of days whatever
 * the log's filters or the view, which never read them again.
 */
const Figures = () => {
  const core = useCore();
  const [activity, setActivity] = useState<Loaded<RunActivity | null>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(core, readActivity, left.signal);
      if (!left.signal.aborted) {
        setActivity(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return activity?.state === "ready" && activity.data !== null ? (
    <RunFiguresView figures={runFiguresOf(activity.data)} scope="all" />
  ) : null;
};

/** Today's lanes, or the log of every run, on the Runs tab. */
const RunsView = () => {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/" });
  return (
    <ToggleGroup
      aria-label={t`What to show of the runs`}
      onValueChange={(value: unknown[]) => {
        const [next] = value;
        if (next === "today" || next === "log") {
          void navigate({
            // The log's filters are its own: Today takes none.
            search:
              next === "today"
                ? { tab: "runs", view: "today" }
                : { tab: "runs" },
          });
        }
      }}
      value={[search.view ?? "log"]}
      variant="outline"
    >
      <ToggleGroupItem value="today">
        {t({
          message: "Today",
          context: "the workflows' runs of today, laid out in time",
        })}
      </ToggleGroupItem>
      <ToggleGroupItem value="log">
        {t({ message: "All runs", context: "the log of every run" })}
      </ToggleGroupItem>
    </ToggleGroup>
  );
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

const Workflows = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const search = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/workflows/" });
  const filtered =
    search.app !== undefined ||
    search.workflow !== undefined ||
    search.status !== undefined;
  const { process } = search;
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
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
            <TabsList variant="line">
              <TabsTrigger value="workflows">
                <Trans context="tab listing every workflow">All</Trans>
              </TabsTrigger>
              <TabsTrigger value="needs">
                <Trans context="tab listing the workflows that need a person">
                  Needs attention
                </Trans>
              </TabsTrigger>
              <TabsTrigger value="runs">
                <Trans context="tab listing the runs of workflows">Runs</Trans>
              </TabsTrigger>
            </TabsList>
            {page.tab === "workflows" || page.tab === "needs" ? (
              <ProcessFilter
                offered={offeredOf(
                  page.workflows,
                  page.independent,
                  page.processes
                )}
              />
            ) : null}
          </div>
          <TabsContent value="workflows">
            {page.tab === "workflows" ? (
              <div className="mt-4 flex flex-col gap-4">
                {page.workflows.state === "ready" ? (
                  <AppWorkflows
                    process={process}
                    processes={page.processes}
                    rows={page.workflows.data}
                  />
                ) : (
                  <NotLoadedState page={page.workflows} />
                )}
                <Independent
                  canCreate={canBuild(identity.role)}
                  page={page.independent}
                  process={process}
                />
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="needs">
            {page.tab === "needs" ? (
              <NeedsAttention
                goLives={page.goLives}
                independent={page.independent}
                me={identity.userId}
                people={page.people}
                process={process}
                processes={page.processes}
                workflows={page.workflows}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="runs">
            {page.tab === "today" || page.tab === "runs" ? (
              <div className="mt-4">
                <Figures />
              </div>
            ) : null}
            <div className="mt-6">
              <RunsView />
            </div>
            {page.tab === "today" ? (
              <div className="mt-4 flex flex-col gap-4">
                {page.today.state === "ready" ? (
                  <TodayLanes today={page.today.data} />
                ) : (
                  <NotLoadedState page={page.today} />
                )}
              </div>
            ) : null}
            {page.tab === "runs" ? (
              <div className="mt-4 flex flex-col gap-4">
                <RunFilters
                  options={
                    page.filters.state === "ready"
                      ? page.filters.data
                      : { apps: [], workflows: [] }
                  }
                />
                {page.runs.state === "ready" ? (
                  <RunsLog
                    empty={
                      filtered ? t`No runs match these filters.` : undefined
                    }
                    me={identity.userId}
                    model={page.model}
                    more={page.runs.data.more}
                    runs={page.runs.data.runs}
                  />
                ) : (
                  <NotLoadedState page={page.runs} />
                )}
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
};

/** The business process each App serves, by its ID. */
const processesOf = (apps: Loaded<App[]>): AppProcesses =>
  new Map(
    apps.state === "ready"
      ? apps.data.map((app) => [app.id, app.process ?? null])
      : []
  );

export const Route = createFileRoute("/_shell/workflows/")({
  validateSearch: (search: Record<string, unknown>): WorkflowsSearch => ({
    ...(search.tab === "runs" || search.tab === "needs"
      ? { tab: search.tab }
      : {}),
    ...(search.tab !== "runs" && isProcess(search.process)
      ? { process: search.process }
      : {}),
    ...(typeof search.app === "string" ? { app: search.app } : {}),
    ...(typeof search.workflow === "string"
      ? { workflow: search.workflow }
      : {}),
    ...(isStatus(search.status) ? { status: search.status } : {}),
    ...(search.tab === "runs" && search.view === "today"
      ? { view: "today" as const }
      : {}),
  }),
  // The process filters what was read: choosing one reads nothing again.
  loaderDeps: ({ search: { tab, view, app, workflow, status } }) => ({
    tab,
    view,
    app,
    workflow,
    status,
  }),
  // Each tab reads only what it shows, and each read says on its own why
  // it failed.
  loader: async ({
    context: { core },
    deps: { tab, app, workflow, status, view },
  }) => {
    if (tab === "runs" && view === "today") {
      const today = await loadFromCore(
        core,
        async (session) => await session.workflows.today()
      );
      return { tab: "today" as const, today };
    }
    if (tab !== "runs") {
      const needs = tab === "needs";
      const [workflows, independent, apps, goLives, people] = await Promise.all(
        [
          loadFromCore(core, listWorkflows),
          // On both lists: where needs shows them, for the process each
          // waiting to go live serves.
          loadFromCore(
            core,
            async (session) => await session.workflowResources.list()
          ),
          // For their processes only: a mark, none where they can't be
          // listed in time.
          loadFromCore(
            core,
            async (session) => await listedOrNone(session.apps.list())
          ),
          needs
            ? loadFromCore(
                core,
                async (session) =>
                  await session.workflowResources.lifecycle.waiting()
              )
            : undefined,
          // Names only: IDs stand in for anyone not listed in time.
          needs ? loadFromCore(core, readPeople) : undefined,
        ]
      );
      const lists = {
        workflows,
        independent,
        processes: processesOf(apps),
      };
      if (needs && goLives !== undefined) {
        return {
          tab: "needs" as const,
          ...lists,
          goLives,
          people:
            people?.state === "ready" ? people.data : new Map<string, string>(),
        };
      }
      return { tab: "workflows" as const, ...lists };
    }
    const [runs, filters, models] = await Promise.all([
      loadFromCore(
        core,
        async (session) =>
          await listRuns(session, {
            ...(app === undefined ? {} : { app }),
            ...(workflow === undefined ? {} : { workflow }),
            ...(status === undefined ? {} : { status }),
          })
      ),
      loadFromCore(core, async (session) => await filterOptions(session, app)),
      // The model a fix in chat asks with; without one, none is offered.
      loadFromCore(core, async (session) => await session.chats.models()),
    ]);
    return {
      tab: "runs" as const,
      runs,
      filters,
      model: models.state === "ready" ? models.data[0] : undefined,
    };
  },
  component: Workflows,
});
