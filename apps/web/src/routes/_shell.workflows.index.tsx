import { runFilterStatuses } from "@grasp-os/shared/workflows";
import type { RunFilterStatus } from "@grasp-os/shared/workflows";
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
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { needsAttention } from "../workflows/lists.ts";
import { listRuns, listWorkflows, openableApps } from "../workflows/reads.ts";
import { RunsLog } from "../workflows/runs.tsx";
import {
  WorkflowsOverview,
  WorkflowsTable,
} from "../workflows/workflows-table.tsx";

// Everything that runs on its own, in one place: every workflow of every
// App the person can open, at work and on the way; those that need a
// person now; and, on the Runs tab, their runs, waiting ones first,
// filtered by App, workflow and status. The tab and the filters
// are in the address, so a link can open the runs it means. Each tab
// reads only what it shows: changing a filter reads the runs again, never
// the list of workflows.

interface WorkflowsSearch {
  tab?: "needs" | "runs";
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
        label={t`Engine`}
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
          <Trans>Couldn&apos;t load this engine&apos;s workflows.</Trans>
        </p>
      ) : null}
    </div>
  );
};

/** The address of a tab: the lists take no filters. */
const tabSearch = (tab: string): WorkflowsSearch => {
  if (tab === "runs" || tab === "needs") {
    return { tab };
  }
  return {};
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
              // The filters are the Runs tab's: the lists have none.
              search: tabSearch(tab),
            });
          }}
          value={search.tab ?? "workflows"}
        >
          <TabsList>
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
          <TabsContent value="workflows">
            {page.tab === "workflows" ? (
              <div className="mt-4 flex flex-col gap-4">
                {page.workflows.state === "ready" ? (
                  <WorkflowsOverview rows={page.workflows.data} />
                ) : (
                  <NotLoadedState page={page.workflows} />
                )}
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="needs">
            {page.tab === "needs" ? (
              <div className="mt-4 flex flex-col gap-4">
                {page.workflows.state === "ready" ? (
                  <WorkflowsTable
                    empty={
                      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
                        <Trans>
                          No workflow needs attention: nothing waits for a
                          decision, nothing failed lately.
                        </Trans>
                      </p>
                    }
                    rows={page.workflows.data.filter(needsAttention)}
                  />
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
    ...(search.tab === "runs" || search.tab === "needs"
      ? { tab: search.tab }
      : {}),
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
        tab: tab ?? ("workflows" as const),
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
