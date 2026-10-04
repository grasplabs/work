import type { App } from "@grasp-os/shared/apps";
import { roleErrors } from "@grasp-os/shared/roles";
import { failedRunDays, runFilterStatuses } from "@grasp-os/shared/workflows";
import type {
  RunFilter,
  RunsPage,
  RunFilterStatus,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { RunResult, RunsLog } from "../workflows/runs.tsx";

// Everything that runs on its own, in one place: every workflow of every
// App the person can open, and, on the Runs tab, their runs, waiting ones
// first, filtered by App, workflow and status. The tab and the filters
// are in the address, so a link can open the runs it means. Each tab
// reads only what it shows: changing a filter reads the runs again, never
// the list of workflows.

interface WorkflowsSearch {
  tab?: "runs";
  app?: string;
  workflow?: string;
  status?: RunFilterStatus;
}

const isStatus = (value: unknown): value is RunFilterStatus =>
  runFilterStatuses.some((status) => status === value);

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
 * The workflows core lists for the person. While sharing Apps is switched
 * off, core refuses the list to the user role: they have no App to list.
 */
const listWorkflows = async (session: Session): Promise<WorkflowSummary[]> => {
  try {
    return await session.workflows.overview();
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return [];
    }
    throw error;
  }
};

/**
 * The runs core lists for the person, as `filter` narrows them; none
 * when refused to their role, as for the list.
 */
const listRuns = async (
  session: Session,
  filter: RunFilter
): Promise<RunsPage> => {
  try {
    return await session.workflows.runs(filter);
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return { runs: [], more: false };
    }
    throw error;
  }
};

/**
 * What the Runs tab's filters offer: the Apps, and the chosen App's
 * workflows, or null when they couldn't be read.
 */
interface FilterOptions {
  apps: Option[];
  workflows: string[] | null;
}

/** The Apps core lets the person open; none where it refuses the list. */
const openableApps = async (session: Session): Promise<App[]> => {
  try {
    return await session.apps.list();
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return [];
    }
    throw error;
  }
};

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

/** When a workflow last ran, or that it never did. */
const LastRun = ({ workflow }: { workflow: WorkflowSummary }) =>
  workflow.lastRun === null ? (
    <span className="text-muted-foreground">
      <Trans>Never</Trans>
    </span>
  ) : (
    <span className="tabular-nums">
      {formatDateTime(workflow.lastRun.createdAt)}
    </span>
  );

/** A count of a workflow's runs, linking to them on the Runs tab. */
const RunCount = ({
  workflow,
  status,
  children,
  label,
}: {
  workflow: WorkflowSummary;
  status: RunFilterStatus;
  children: ReactNode;
  /** What the link opens, read out: the count and the workflow, in words. */
  label: string;
}) => (
  <Link
    aria-label={label}
    className="relative z-10 underline-offset-4 hover:underline"
    search={{
      tab: "runs",
      app: workflow.app,
      workflow: workflow.workflow,
      status,
    }}
    to="/workflows"
  >
    {children}
  </Link>
);

/**
 * Where a workflow stands: its last run's result, and the runs waiting
 * for a decision or failed lately, each a link to them on the Runs tab.
 */
const Status = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { t } = useLingui();
  const name = workflow.workflow;
  const { waiting, failed } = workflow;
  const days = failedRunDays;
  return (
    <div className="flex flex-col items-start gap-0.5">
      {workflow.lastRun === null ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <RunResult status={workflow.lastRun.status} />
      )}
      {waiting === 0 ? null : (
        <RunCount
          label={t`${plural(waiting, { one: "# waiting run", other: "# waiting runs" })} of ${name}`}
          status="waiting"
          workflow={workflow}
        >
          <Plural one="# waiting" other="# waiting" value={waiting} />
        </RunCount>
      )}
      {failed === 0 ? null : (
        <RunCount
          label={t`${plural(failed, { one: "# failed run", other: "# failed runs" })} of ${name}`}
          status="failed"
          workflow={workflow}
        >
          <Plural
            one={`# failed in ${days} days`}
            other={`# failed in ${days} days`}
            value={failed}
          />
        </RunCount>
      )}
    </div>
  );
};

/**
 * A workflow's row: its name, the App it is in and its version under it,
 * when it last ran and where it stands. The whole row opens it.
 */
const WorkflowRow = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { version } = workflow;
  return (
    <TableRow className="relative">
      <TableCell variant="roomy">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <Link
              className="truncate outline-none after:absolute after:inset-0 focus-visible:underline"
              params={{ app: workflow.app, workflow: workflow.workflow }}
              to="/workflows/$app/$workflow"
            >
              {workflow.workflow}
            </Link>
            {workflow.scheduleStopped ? (
              <Badge variant="destructive">
                <Trans>Schedule stopped</Trans>
              </Badge>
            ) : null}
          </span>
          <span className="text-muted-foreground truncate @lg:hidden">
            {workflow.appName}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden @lg:table-cell" variant="roomy">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            className="relative z-10 truncate underline-offset-4 hover:underline"
            params={{ app: workflow.app }}
            to="/apps/$app"
          >
            {workflow.appName}
          </Link>
          <span className="text-muted-foreground">
            <Trans>Version {version}</Trans>
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden @2xl:table-cell" variant="roomy">
        <LastRun workflow={workflow} />
      </TableCell>
      <TableCell variant="roomy">
        <Status workflow={workflow} />
      </TableCell>
      <TableCell>
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground mx-auto size-4"
        />
      </TableCell>
    </TableRow>
  );
};

/**
 * Every workflow the person can open, in the prototype's table
 * (grasplabs/prototype `components/workflows-table.tsx`): its columns
 * follow the table's own width, so as it narrows, the last run and then
 * the App fold away.
 */
const WorkflowsTable = ({ rows }: { rows: WorkflowSummary[] }) => {
  if (rows.length === 0) {
    return (
      <div className="bg-card rounded-xl border">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No workflows yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                Workflows are made in chat: describe what should run on its own,
                and Grasp builds it into an App.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              className={buttonVariants({ size: "sm", variant: "outline" })}
              search={{}}
              to="/"
            >
              <Trans>Open Chat</Trans>
            </Link>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  return (
    <div className="bg-card @container overflow-hidden rounded-xl border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead variant="card">
              <Trans>Workflow</Trans>
            </TableHead>
            <TableHead className="hidden w-56 @lg:table-cell" variant="card">
              <Trans>App</Trans>
            </TableHead>
            <TableHead className="hidden w-44 @2xl:table-cell" variant="card">
              <Trans>Last run</Trans>
            </TableHead>
            <TableHead className="w-52" variant="card">
              <Trans context="column: where a workflow stands">Status</Trans>
            </TableHead>
            <TableHead className="w-9" variant="card">
              <span className="sr-only">
                <Trans context="column: a link that opens the workflow">
                  Open
                </Trans>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <WorkflowRow key={`${row.app}/${row.workflow}`} workflow={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
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
        label={t`App`}
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
          <Trans>Couldn&apos;t load this App&apos;s workflows.</Trans>
        </p>
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
  const filtered =
    search.app !== undefined ||
    search.workflow !== undefined ||
    search.status !== undefined;
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <h1 className="sr-only">
          <Trans>Workflows</Trans>
        </h1>
        <Tabs
          onValueChange={(tab: string) => {
            void navigate({
              // The filters are the Runs tab's: the list has none.
              search: tab === "runs" ? { tab: "runs" } : {},
            });
          }}
          value={search.tab ?? "workflows"}
        >
          <TabsList>
            <TabsTrigger value="workflows">
              <Trans>Workflows</Trans>
            </TabsTrigger>
            <TabsTrigger value="runs">
              <Trans context="tab listing the runs of workflows">Runs</Trans>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="workflows">
            {page.tab === "workflows" ? (
              <div className="mt-4 flex flex-col gap-4">
                {page.workflows.state === "ready" ? (
                  <WorkflowsTable rows={page.workflows.data} />
                ) : (
                  <NotLoadedState page={page.workflows} />
                )}
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="runs">
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

export const Route = createFileRoute("/_shell/workflows/")({
  validateSearch: (search: Record<string, unknown>): WorkflowsSearch => ({
    ...(search.tab === "runs" ? { tab: "runs" } : {}),
    ...(typeof search.app === "string" ? { app: search.app } : {}),
    ...(typeof search.workflow === "string"
      ? { workflow: search.workflow }
      : {}),
    ...(isStatus(search.status) ? { status: search.status } : {}),
  }),
  loaderDeps: ({ search }) => search,
  // Each tab reads only what it shows, and each read says on its own why
  // it failed.
  loader: async ({
    context: { core },
    deps: { tab, app, workflow, status },
  }) => {
    if (tab !== "runs") {
      return {
        tab: "workflows" as const,
        workflows: await loadFromCore(core, listWorkflows),
      };
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
