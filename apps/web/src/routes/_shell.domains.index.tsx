import type { App, AppContents, AppStatus } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  CogIcon,
  LayoutGridIcon,
  PlusIcon,
  TagIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { statusLabel } from "../engines/app-status.tsx";
import { EngineIcon } from "../engines/engine-icon.tsx";
import { NewDomainDialog } from "../engines/new-domain-dialog.tsx";
import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { processNames } from "../workflows/business-process.tsx";
import { openableApps } from "../workflows/reads.ts";

// Domains, as in the prototype (`routes/domains/index.tsx`): the domains
// (core's Apps) the person can open, as core lists them, each a card with
// the business process it serves, if any, and what its current version
// holds, counted by core. No hours or process bars: core counts no hours
// for a domain. Who builds makes one with New domain, as in the
// prototype; Grasp also makes them in chat. Its builders also see the
// drafts and the archived ones: then, as the prototype's Apps page
// (`components/apps/apps-overview.tsx`), a tab for each status, with how
// many each holds.

interface ListedApp {
  app: App;
  /** Undefined when core didn't answer for this App. */
  contents?: AppContents;
}

/**
 * How long one App's contents may take: half the page's own limit, so an
 * App whose read hangs costs only its row, never the whole list.
 */
const contentsTimeoutMs = timeoutMs / 2;

const listApps = async (session: Session): Promise<ListedApp[]> => {
  const apps = await openableApps(session);
  // One App whose contents can't be read (a damaged version, a read that
  // hangs) still leaves the others, and its own row.
  const contents = await Promise.allSettled(
    apps.map(
      async (app) =>
        await withTimeout(session.apps.contents(app.id), contentsTimeoutMs)
    )
  );
  return apps.map((app, index) => {
    const read = contents[index];
    return read?.status === "fulfilled"
      ? { app, contents: read.value }
      : { app };
  });
};

/** What an engine's current version holds: its workflows and apps, or that it has no version yet. */
const Counts = ({ contents }: { contents: AppContents | undefined }) => {
  if (contents === undefined) {
    return (
      <span className="text-muted-foreground">
        <Trans>Its contents couldn&apos;t be read.</Trans>
      </span>
    );
  }
  const workflows = contents.workflows.length;
  const apps = contents.screens.length;
  const { version } = contents;
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <WorkflowIcon aria-hidden="true" className="size-3.5" />
        {workflows === 0 ? (
          <Trans>No workflows yet</Trans>
        ) : (
          <Plural one="# workflow" other="# workflows" value={workflows} />
        )}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <LayoutGridIcon aria-hidden="true" className="size-3.5" />
        {apps === 0 ? (
          <Trans>No apps yet</Trans>
        ) : (
          <Plural one="# app" other="# apps" value={apps} />
        )}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <TagIcon aria-hidden="true" className="size-3.5" />
        {version === null ? (
          <Trans>Not released</Trans>
        ) : (
          <Trans>Version {version}</Trans>
        )}
      </span>
    </div>
  );
};

/**
 * One domain, as the prototype's card: its icon, the standard name of the
 * process it serves over its own name, what it is for, then what it holds.
 */
const EngineCard = ({ app, contents }: ListedApp) => {
  const { i18n } = useLingui();
  return (
    <li className="bg-card hover:border-faint relative flex flex-col gap-4 rounded-xl border p-4 transition-colors">
      <div className="flex items-start gap-3">
        <EngineIcon process={app.process} />
        <div className="flex min-w-0 flex-col gap-0.5">
          {app.process === null ? null : (
            <span className="text-muted-foreground text-xs">
              {i18n._(processNames[app.process])}
            </span>
          )}
          <Link
            className="font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
            params={{ engine: app.id }}
            to="/domains/$engine"
          >
            {app.name}
          </Link>
          {app.description === "" ? null : (
            <p className="text-muted-foreground line-clamp-2">
              {app.description}
            </p>
          )}
        </div>
      </div>
      <Counts contents={contents} />
    </li>
  );
};

/** No engine yet: engines are made in chat. */
const NoEngines = () => (
  <div className="bg-card rounded-xl border">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CogIcon />
        </EmptyMedia>
        <EmptyTitle>
          <Trans>No domains yet</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>
            There are no domains you can open yet. Domains are made in chat:
            describe a part of your work, and Grasp builds its workflows and
            apps.
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

/** The tabs, in the prototype's order. */
const statuses = [
  "published",
  "draft",
  "archived",
] as const satisfies readonly AppStatus[];

/** The engines as cards, in a grid. */
const EngineGrid = ({ listed }: { listed: ListedApp[] }) => {
  const { t } = useLingui();
  return (
    <ul
      aria-label={t`Domains`}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {listed.map((each) => (
        <EngineCard key={each.app.id} {...each} />
      ))}
    </ul>
  );
};

/**
 * The engines by status, a tab each, once any isn't published: only its
 * builders see those. It opens where there is something to see: the
 * published ones, or else the drafts.
 */
const ByStatus = ({ listed }: { listed: ListedApp[] }) => {
  const [status, setStatus] = useState<AppStatus>(() =>
    listed.some(({ app }) => app.status === "published") ? "published" : "draft"
  );
  if (listed.every(({ app }) => app.status === "published")) {
    return <EngineGrid listed={listed} />;
  }
  const shown = listed.filter(({ app }) => app.status === status);
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        onValueChange={(value: AppStatus) => {
          setStatus(value);
        }}
        value={status}
      >
        <TabsList variant="line">
          {statuses.map((each) => (
            <TabsTrigger key={each} value={each}>
              {statusLabel(each)}
              <span className="text-muted-foreground tabular-nums">
                {listed.filter(({ app }) => app.status === each).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">
          {status === "published" ? (
            <Trans>
              No domain is published yet: publish one from its page, and the
              people it is shared with can open it.
            </Trans>
          ) : null}
          {status === "draft" ? <Trans>No drafts.</Trans> : null}
          {status === "archived" ? <Trans>Nothing archived.</Trans> : null}
        </p>
      ) : (
        <EngineGrid listed={shown} />
      )}
    </div>
  );
};

const Engines = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate();
  const [making, setMaking] = useState(false);
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Domains` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Domains` }]} />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>
              <Trans>Domains</Trans>
            </PageHeaderTitle>
            <PageHeaderDescription>
              <Trans>
                Each domain is one part of the business: its workflows, apps and
                connections.
              </Trans>
            </PageHeaderDescription>
          </PageHeaderContent>
          {canBuild(identity.role) ? (
            <PageHeaderActions>
              <Button
                onClick={() => {
                  setMaking(true);
                }}
              >
                <PlusIcon data-icon="inline-start" />
                <Trans>New domain</Trans>
              </Button>
            </PageHeaderActions>
          ) : null}
        </PageHeader>
        {page.data.length === 0 ? (
          <NoEngines />
        ) : (
          <ByStatus listed={page.data} />
        )}
      </div>
      <NewDomainDialog
        onMade={(engine) => {
          void navigate({ to: "/domains/$engine", params: { engine } });
        }}
        onOpenChange={setMaking}
        open={making}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/domains/")({
  pendingComponent: PageLoading,
  component: Engines,
  loader: async ({ context: { core } }) => await loadFromCore(core, listApps),
});
