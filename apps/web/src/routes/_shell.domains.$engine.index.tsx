import type { App, AppContents, AppMember } from "@grasp-os/shared/apps";
import type { DependencyApprovals } from "@grasp-os/shared/dependencies";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreenTrustReview } from "@grasp-os/shared/screen-trust";
import type { SurfaceSummary } from "@grasp-os/shared/screens";
import type { RunsPage, WorkflowSummary } from "@grasp-os/shared/workflows";
import { buttonVariants } from "@grasp-os/ui/components/button";
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
import { cn } from "@grasp-os/ui/lib/utils";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Await,
  createFileRoute,
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { CogIcon, LayoutGridIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";

import { IntegrationRow } from "../connections/integration-row.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { decidesRequests } from "../dashboard/to-do.tsx";
import { SaveAsBlueprint } from "../engines/blueprints.tsx";
import { EngineIcon } from "../engines/engine-icon.tsx";
import { engineReaders, loadEnginePage } from "../engines/engine-page.ts";
import type { EnginePage } from "../engines/engine-page.ts";
import { PackageApprovals } from "../engines/package-approvals.tsx";
import { ResourceBindings } from "../engines/resource-bindings.tsx";
import type { ResourcesPage } from "../engines/resource-bindings.tsx";
import { ScreenApproval } from "../engines/screen-approval.tsx";
import { readStoreChanges, StoreChanges } from "../engines/store-changes.tsx";
import {
  LoadingLines,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { roleLabel } from "../labels.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";
import {
  usePushNavigate,
  useScreenOpening,
} from "../screens/screen-navigate.ts";
import { useCore } from "../use-core.ts";
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

/**
 * The engine's declared resources and their bindings and, for an admin,
 * the connections the page names connection permissions by.
 */
const loadResources = async (
  session: Session,
  engine: string,
  decides: boolean
): Promise<ResourcesPage> => {
  const [review, connections] = await Promise.all([
    session.resourceBindings.review(engine),
    decides ? session.connections.list() : [],
  ]);
  return { review, connections };
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
                <Trans>No workflow in this domain yet.</Trans>
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
      to="/domains/$engine/apps/$screen"
    >
      {screen}
    </Link>
  </li>
);

/**
 * The engine's apps, or why there are none, and for someone who builds
 * (`builds`) the way to make a new one; for an admin, with whether their
 * code is approved for the engine's data (`approval`).
 */
const Apps = ({
  engine,
  contents,
  approval,
  builds,
}: {
  engine: string;
  contents: AppContents;
  approval: Deferred<ScreenTrustReview> | undefined;
  builds: boolean;
}) => {
  const { t } = useLingui();
  const none = contents.version === null || contents.screens.length === 0;
  return (
    <div className="flex flex-col gap-6">
      {builds ? (
        <Link
          className={cn(
            buttonVariants({ size: "sm", variant: "outline" }),
            "self-end"
          )}
          to="/apps/new"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>New app</Trans>
        </Link>
      ) : null}
      {none ? (
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
                <Trans>This domain has no version to run yet.</Trans>
              ) : (
                <Trans>
                  An app is what this domain&apos;s team works in, standing on
                  its workflows and integrations. Ask Grasp in chat to build
                  one.
                </Trans>
              )}
            </p>
          </div>
        </div>
      ) : (
        <ul
          aria-label={t`Apps`}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {contents.screens.map((screen) => (
            <AppCard engine={engine} key={screen} screen={screen} />
          ))}
        </ul>
      )}
      {/* Also with no apps now: earlier versions' approvals can still be
          taken back. Not before a first version, which has nothing. */}
      {approval === undefined || contents.version === null ? null : (
        <Later promise={approval}>
          {(review) => <ScreenApproval review={review} />}
        </Later>
      )}
    </div>
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
          <Trans>This domain doesn&apos;t use an integration yet.</Trans>
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

/** The engine's approved npm packages, as the tab's last read found them. */
const Packages = ({
  packages,
}: {
  packages: Deferred<DependencyApprovals>;
}) => (
  <Later promise={packages}>
    {(listed) => <PackageApprovals key={listed.subject.id} listed={listed} />}
  </Later>
);

/**
 * The Packages tab, for whoever core lets read the engine's approvals:
 * its builders at once, and anyone else (someone who may approve
 * packages) once the read says they may.
 */
const PackagesTab = ({
  packages,
}: {
  /** The early read that says whether a non-builder may; none for a builder. */
  packages: Deferred<DependencyApprovals> | undefined;
}) => {
  const trigger = (
    <TabsTrigger value="packages">
      <Trans>Packages</Trans>
    </TabsTrigger>
  );
  // A builder's tab is there from the start, never swapped for another.
  if (packages === undefined) {
    return trigger;
  }
  return (
    <Await fallback={null} promise={packages}>
      {(loaded) => (loaded.state === "ready" ? trigger : null)}
    </Await>
  );
};

/** The App's settings surface (spec 34.1), if it declares one. */
const settingsOf = (surfaces: Loaded<SurfaceSummary[]>) =>
  surfaces.state === "ready"
    ? surfaces.data.find(({ kind }) => kind === "settings")
    : undefined;

/** The Settings tab, there once core says the App declares its surface. */
const SettingsTab = ({
  surfaces,
}: {
  surfaces: Deferred<SurfaceSummary[]>;
}) => (
  <Await fallback={null} promise={surfaces}>
    {(loaded) =>
      settingsOf(loaded) === undefined ? null : (
        <TabsTrigger value="settings">
          <Trans>Settings</Trans>
        </TabsTrigger>
      )
    }
  </Await>
);

/**
 * The App's settings screen: its settings surface, opened with nothing,
 * as any of its screens, with the person's own access and no more. Its
 * navigation opens routes in the main pane, as new entries.
 */
const SettingsScreen = ({
  engine,
  surface,
}: {
  engine: string;
  surface: SurfaceSummary;
}) => {
  const navigate = usePushNavigate(engine);
  // What a navigation to the settings asked for, as core resolved it; a
  // visit to the tab by its address opens with nothing.
  const opening = useScreenOpening(engine, surface.screen);
  const input =
    opening !== undefined && opening.surface === surface.name
      ? opening.input
      : "{}";
  return (
    <ScreenFrame
      app={engine}
      embedded
      input={input}
      key={input}
      onNavigate={navigate}
      route={surface.route}
      screen={surface.screen}
      surface={surface.name}
    />
  );
};

/** How many a tab holds, after its name. */
const Count = ({ count }: { count: number }) => (
  <span className="text-muted-foreground tabular-nums">{count}</span>
);

const EngineView = ({ page }: { page: EnginePage }) => {
  const {
    workflows,
    runs,
    members,
    integrations,
    approval,
    resources,
    storeChanges,
    packages,
    surfaces,
  } = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const entry = useRouterState({
    select: ({ location }) => location.state.__TSR_key,
  });
  const { identity } = Route.useRouteContext();
  const core = useCore();
  // The packages as they are each time their tab opens, not as they were
  // when the page loaded.
  const [packagesRead, setPackagesRead] =
    useState<Deferred<DependencyApprovals>>();
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
        {canBuild(identity.role) && version !== null ? (
          <SaveAsBlueprint app={app.id} name={app.name} version={version} />
        ) : null}
      </div>
      <StoreChanges changes={storeChanges} engine={app} />
      <Tabs
        // The address's tab, again for each entry of the page's history:
        // a navigation to the App's settings opens that tab, whichever the
        // person had chosen on this page since.
        defaultValue={tab ?? "apps"}
        key={`${tab ?? "apps"}/${entry ?? ""}`}
        onValueChange={(value) => {
          if (value === "packages") {
            setPackagesRead(
              loadFromCore(
                core,
                async (session) =>
                  await session.dependencies.approvals({ app: app.id })
              )
            );
          }
        }}
      >
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
          {resources === undefined ? null : (
            <TabsTrigger value="resources">
              <Trans>Resources</Trans>
            </TabsTrigger>
          )}
          <PackagesTab packages={packages} />
          <SettingsTab surfaces={surfaces} />
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
            <Apps
              approval={approval}
              builds={canBuild(identity.role)}
              contents={contents}
              engine={app.id}
            />
          </div>
        </TabsContent>
        {integrations === undefined ? null : (
          <TabsContent value="integrations">
            <div className="pt-4">
              <Integrations identity={identity} integrations={integrations} />
            </div>
          </TabsContent>
        )}
        {resources === undefined ? null : (
          <TabsContent value="resources">
            <div className="pt-4">
              <Later promise={resources}>
                {(declared) => (
                  <ResourceBindings
                    decides={decidesRequests(identity)}
                    page={declared}
                  />
                )}
              </Later>
            </div>
          </TabsContent>
        )}
        <TabsContent value="packages">
          <div className="pt-4">
            {packagesRead === undefined ? null : (
              <Packages packages={packagesRead} />
            )}
          </div>
        </TabsContent>
        <TabsContent value="settings">
          <div className="flex min-h-96 flex-col pt-4">
            <Await fallback={<LoadingLines />} promise={surfaces}>
              {(loaded) => {
                const surface = settingsOf(loaded);
                if (surface !== undefined) {
                  return <SettingsScreen engine={app.id} surface={surface} />;
                }
                // A domain without settings has no Settings tab: asked for
                // by its address, the page opens on its first tab instead.
                return loaded.state === "ready" ? null : (
                  <NotLoaded page={loaded} />
                );
              }}
            </Await>
          </div>
        </TabsContent>
        <TabsContent value="members">
          <div className="pt-4">
            <Members app={app} identity={identity} members={members} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

/**
 * The engine for someone core lets read nothing of it but its approved
 * packages: someone who may approve packages and isn't one of its
 * members. Only what `dependencies.approvals` answers, its name and its
 * approvals, and ending them; never its apps, workflows or members.
 */
const PackagesOnlyView = ({ listed }: { listed: DependencyApprovals }) => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Domains`, to: "/domains" },
          { label: listed.subject.name },
        ]}
      />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-2xl font-medium tracking-tight">
            {listed.subject.name}
          </h1>
          <p className="text-muted-foreground">
            <Trans>
              The packages approved for this domain. You see them because you
              may approve packages; the rest of the domain is for its members.
            </Trans>
          </p>
        </div>
        <section
          aria-labelledby="engine-packages"
          className="flex flex-col gap-3"
        >
          <h2 className="text-base font-medium" id="engine-packages">
            <Trans>Packages</Trans>
          </h2>
          <PackageApprovals key={listed.subject.id} listed={listed} />
        </section>
      </div>
    </>
  );
};

const EnginePageView = () => {
  const { page, packagesOnly } = Route.useLoaderData();
  const { t } = useLingui();
  if (page.state !== "ready") {
    const notLoaded = (
      <PageNotLoaded
        crumbs={[{ label: t`Domains`, to: "/domains" }, { label: t`Domain` }]}
        icon={CogIcon}
        notFound={t`Domain not found`}
        page={page}
      />
    );
    // Not a member: someone who may approve packages still gets those.
    return packagesOnly === undefined ? (
      notLoaded
    ) : (
      <Await fallback={<PageLoading />} promise={packagesOnly}>
        {(listed) =>
          listed.state === "ready" ? (
            <PackagesOnlyView listed={listed.data} />
          ) : (
            notLoaded
          )
        }
      </Await>
    );
  }
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Domains`, to: "/domains" },
          { label: page.data.app.name },
        ]}
      />
      <EngineView key={page.data.app.id} page={page.data} />
    </>
  );
};

export const Route = createFileRoute("/_shell/domains/$engine/")({
  pendingComponent: PageLoading,
  component: EnginePageView,
  // Which tab opens first: a navigation to the App's settings opens its own.
  // Any other `tab` (an old or hand-typed address) opens the page as without
  // one, never its error.
  // The router reads search values as JSON, so `?tab=1` comes as a number;
  // and `tab` is always set here, since the address's own would otherwise
  // pass through unchecked.
  validateSearch: (
    search: Record<string, unknown>
  ): { tab?: "settings" | undefined } => ({
    tab: search.tab === "settings" ? "settings" : undefined,
  }),
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
    // Where the App's surfaces go: its Settings tab, if it declares one.
    surfaces: loadFromCore(
      core,
      async (session) => await session.screens.surfaces(params.engine)
    ),
    // Only for who decides it: the organization's own admins.
    approval: decidesRequests(identity)
      ? loadFromCore(
          core,
          async (session) => await session.screenTrust.review(params.engine)
        )
      : undefined,
    // Only for who may abandon a store's failed change: the organization's
    // own admins, never Grasp staff.
    storeChanges: readStoreChanges(core, identity, params.engine),
    // For who reads them: admins, who decide them, and builders.
    resources: canBuild(identity.role)
      ? loadFromCore(
          core,
          async (session) =>
            await loadResources(
              session,
              params.engine,
              decidesRequests(identity)
            )
        )
      : undefined,
    integrations: canBuild(identity.role)
      ? loadFromCore(
          core,
          async (session) => await loadIntegrations(session, params.engine)
        )
      : undefined,
    // Last, so the reads above start first. The engine, and its packages
    // for whoever core lets read them: their tab, or the packages alone
    // for who isn't a member.
    ...(await loadEnginePage(
      engineReaders(core, params.engine),
      canBuild(identity.role)
    )),
  }),
});
