import type { App, AppContents, AppMember } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { RunsPage, WorkflowSummary } from "@grasp-os/shared/workflows";
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
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, createFileRoute, Link } from "@tanstack/react-router";
import { CogIcon, LayoutGridIcon } from "lucide-react";
import type { ReactElement } from "react";

import { IntegrationRow } from "../connections/integration-row.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { EngineIcon } from "../engines/engine-icon.tsx";
import {
  LoadingLines,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { roleLabel } from "../labels.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { listRuns, listWorkflows } from "../workflows/reads.ts";
import { RunsLog } from "../workflows/runs.tsx";
import { WorkflowsTable } from "../workflows/workflows-table.tsx";

// One engine (core's App), as in the prototype (`routes/engines/$engineId.tsx`):
// its icon, name and what it is for, then its workflows (with their runs),
// its apps (core's screens), the integrations it uses and, which the
// prototype doesn't have, its members. Each tab's read is its own: one
// that hangs or is refused leaves the others. There is no menu yet:
// removing an engine waits on core (GRA-161).

/** A read only one tab waits for: the page shows before it comes. */
type Deferred<T> = Promise<Loaded<T>>;

/**
 * A read started the first time its tab asks for it, then shared: hidden
 * tabs aren't rendered, so a tab never opened never reads.
 */
type OnFirstUse<T> = () => { read: Deferred<T> };

const onFirstUse = <T,>(start: () => Deferred<T>): OnFirstUse<T> => {
  // The same promise each time, which `Await` follows across renders.
  let started: Deferred<T> | undefined;
  return () => {
    started ??= start();
    return { read: started };
  };
};

interface EnginePage {
  app: App;
  contents: AppContents;
}

const loadEngine = async (
  session: Session,
  engine: string
): Promise<EnginePage> => {
  const [found, contents] = await Promise.all([
    session.apps.get(engine),
    session.apps.contents(engine),
  ]);
  return { app: found, contents };
};

/**
 * The integrations the engine uses: those of the connections it asked to
 * use or may use now (its permissions), each with only those connections,
 * so its state is the engine's, not the viewer's. Admins and builders may
 * list permissions; for anyone else the tab isn't there. A connection the
 * engine holds that the viewer can't see (someone else's personal one, or
 * one since disconnected) isn't listed: core has no read of it for them.
 */
const loadIntegrations = async (
  session: Session,
  engine: string
): Promise<Integration[]> => {
  const [permissions, connections, catalog] = await Promise.all([
    session.permissions.list({ type: "app", appId: engine }),
    session.connections.list(),
    session.connections.catalog(),
  ]);
  const used = new Set<string>(
    permissions.flatMap(({ object, status }) =>
      object.type === "connection" && status !== "revoked"
        ? [object.connectionId]
        : []
    )
  );
  return integrationsOf(catalog.entries, connections)
    .map((integration) => ({
      ...integration,
      connections: integration.connections.filter(({ id }) => used.has(id)),
    }))
    .filter(({ connections: held }) => held.length > 0);
};

/** What a tab shows of a read: a skeleton while it comes, why it didn't, or `children` once it did. */
const Later = <T,>({
  promise,
  children,
}: {
  promise: Deferred<T>;
  children: (data: T) => ReactElement;
}) => (
  <Await fallback={<LoadingLines />} promise={promise}>
    {(loaded) =>
      loaded.state === "ready" ? (
        children(loaded.data)
      ) : (
        <NotLoaded page={loaded} />
      )
    }
  </Await>
);

/** The engine's workflows in the workflows table, then their runs. */
const Workflows = ({
  engine,
  workflows,
  runs,
  identity,
}: {
  engine: string;
  workflows: OnFirstUse<WorkflowSummary[]>;
  runs: OnFirstUse<RunsPage>;
  identity: Identity;
}) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6">
      <Later promise={workflows().read}>
        {(rows) => (
          <WorkflowsTable
            empty={
              <p className="text-muted-foreground">
                <Trans>No workflow in this engine yet.</Trans>
              </p>
            }
            rows={rows.filter(({ app }) => app === engine)}
            withEngine={false}
          />
        )}
      </Later>
      <section aria-labelledby="engine-runs" className="flex flex-col gap-3">
        <h2 className="font-medium" id="engine-runs">
          <Trans>Runs</Trans>
        </h2>
        <Later promise={runs().read}>
          {(page) => (
            <RunsLog
              empty={t`No runs yet.`}
              me={identity.userId}
              model={undefined}
              more={page.more}
              runs={page.runs}
            />
          )}
        </Later>
      </section>
    </div>
  );
};

/** One app (core's screen) of the engine, as the prototype's app card: it opens the app in the frame. */
const AppCard = ({ engine, screen }: { engine: string; screen: string }) => (
  <li className="bg-card hover:border-faint relative flex min-w-0 items-center gap-3 rounded-xl border p-4 transition-colors">
    <span
      aria-hidden="true"
      className="bg-muted text-foreground inline-flex size-7.5 flex-none items-center justify-center rounded-lg"
    >
      <LayoutGridIcon className="size-4" />
    </span>
    <Link
      className="min-w-0 flex-1 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
      params={{ engine, screen }}
      to="/engines/$engine/apps/$screen"
    >
      {screen}
    </Link>
  </li>
);

/** The engine's apps, or why there are none. */
const Apps = ({
  engine,
  contents,
}: {
  engine: string;
  contents: AppContents;
}) => {
  const { t } = useLingui();
  if (contents.version === null || contents.screens.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
        <span
          aria-hidden="true"
          className="bg-tile flex size-7 items-center justify-center rounded-md border"
        >
          <LayoutGridIcon className="size-4" />
        </span>
        <div className="flex max-w-prose flex-col gap-1">
          <span className="font-medium">
            <Trans>No apps yet</Trans>
          </span>
          <p className="text-muted-foreground">
            {contents.version === null ? (
              <Trans>This engine has no version to run yet.</Trans>
            ) : (
              <Trans>
                An app is what this engine&apos;s team works in, standing on its
                workflows and integrations. Ask Grasp in chat to build one.
              </Trans>
            )}
          </p>
        </div>
      </div>
    );
  }
  return (
    <ul
      aria-label={t`Apps`}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {contents.screens.map((screen) => (
        <AppCard engine={engine} key={screen} screen={screen} />
      ))}
    </ul>
  );
};

const Integrations = ({
  integrations,
  identity,
}: {
  integrations: Deferred<Integration[]>;
  identity: Identity;
}) => (
  <Later promise={integrations}>
    {(used) =>
      used.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>This engine doesn&apos;t use an integration yet.</Trans>
        </p>
      ) : (
        <div className="@container">
          <ul className="grid grid-cols-1 gap-x-10 @2xl:grid-cols-2">
            {used.map((integration) => (
              <IntegrationRow
                identity={identity}
                integration={integration}
                key={integration.key}
              />
            ))}
          </ul>
        </div>
      )
    }
  </Later>
);

const MembersTable = ({ members }: { members: AppMember[] }) => {
  const { i18n } = useLingui();
  if (members.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>It isn&apos;t shared with anyone.</Trans>
      </p>
    );
  }
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">
              <Trans>Shared with</Trans>
            </TableHead>
            <TableHead className="w-40" variant="card">
              <Trans>Role</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={`${member.type}:${member.id}`}>
              <TableCell variant="card">
                {member.type === "team"
                  ? i18n._(
                      msg`${ph({ team: member.name ?? member.id })} (team)`
                    )
                  : (member.name ?? member.id)}
              </TableCell>
              <TableCell variant="card">{roleLabel(member.role)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

/**
 * Who opens the engine: its owner and the admins, who build it, and the
 * people and teams it is shared with, each as a user or a builder.
 */
const Members = ({
  app,
  members,
  identity,
}: {
  app: App;
  members: Deferred<AppMember[]>;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const { owner } = app;
  return (
    <div className="flex flex-col gap-3">
      <p>
        {owner === identity.userId
          ? t`Created by you.`
          : t`Created by the member ${owner}.`}
      </p>
      <Later promise={members}>
        {(listed) => <MembersTable members={listed} />}
      </Later>
    </div>
  );
};

/** How many a tab holds, after its name. */
const Count = ({ count }: { count: number }) => (
  <span className="text-muted-foreground tabular-nums">{count}</span>
);

const EngineView = ({ page }: { page: EnginePage }) => {
  const { workflows, runs, members, integrations } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { app, contents } = page;
  const { version } = contents;
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
      <div className="flex flex-wrap items-start gap-4">
        <EngineIcon />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-2xl font-medium tracking-tight">{app.name}</h1>
          {app.description === "" ? null : (
            <p className="text-muted-foreground">{app.description}</p>
          )}
          <p className="text-muted-foreground">
            {version === null ? (
              <Trans>Not released</Trans>
            ) : (
              <Trans>Version {version}</Trans>
            )}
          </p>
        </div>
      </div>
      <Tabs defaultValue="apps">
        <TabsList variant="line">
          <TabsTrigger value="apps">
            <Trans>Apps</Trans>
            <Count count={contents.screens.length} />
          </TabsTrigger>
          <TabsTrigger value="workflows">
            <Trans>Workflows</Trans>
            <Count count={contents.workflows.length} />
          </TabsTrigger>
          {integrations === undefined ? null : (
            <TabsTrigger value="integrations">
              <Trans>Integrations</Trans>
            </TabsTrigger>
          )}
          <TabsTrigger value="members">
            <Trans>Members</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="workflows">
          <div className="pt-4">
            <Workflows
              engine={app.id}
              identity={identity}
              runs={runs}
              workflows={workflows}
            />
          </div>
        </TabsContent>
        <TabsContent value="apps">
          <div className="pt-4">
            <Apps contents={contents} engine={app.id} />
          </div>
        </TabsContent>
        {integrations === undefined ? null : (
          <TabsContent value="integrations">
            <div className="pt-4">
              <Integrations identity={identity} integrations={integrations} />
            </div>
          </TabsContent>
        )}
        <TabsContent value="members">
          <div className="pt-4">
            <Members app={app} identity={identity} members={members} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

const EnginePageView = () => {
  const { page } = Route.useLoaderData();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Engines`, to: "/engines" }, { label: t`Engine` }]}
        icon={CogIcon}
        notFound={t`Engine not found`}
        page={page}
      />
    );
  }
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Engines`, to: "/engines" },
          { label: page.data.app.name },
        ]}
      />
      <EngineView key={page.data.app.id} page={page.data} />
    </>
  );
};

export const Route = createFileRoute("/_shell/engines/$engine/")({
  pendingComponent: PageLoading,
  component: EnginePageView,
  loader: async ({ context: { core, identity }, params }) => ({
    // Not awaited: only their tabs wait for them. Core lists every
    // engine's workflows at once (there is no read of one engine's), so
    // that read, and the runs, wait until Workflows is opened.
    workflows: onFirstUse(async () => await loadFromCore(core, listWorkflows)),
    runs: onFirstUse(
      async () =>
        await loadFromCore(
          core,
          async (session) => await listRuns(session, { app: params.engine })
        )
    ),
    members: loadFromCore(
      core,
      async (session) => await session.apps.members.list(params.engine)
    ),
    integrations: canBuild(identity.role)
      ? loadFromCore(
          core,
          async (session) => await loadIntegrations(session, params.engine)
        )
      : undefined,
    page: await loadFromCore(
      core,
      async (session) => await loadEngine(session, params.engine)
    ),
  }),
});
