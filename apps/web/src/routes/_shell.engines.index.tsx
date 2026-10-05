import type { App, AppContents } from "@grasp-os/shared/apps";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CogIcon, LayoutGridIcon, TagIcon, WorkflowIcon } from "lucide-react";

import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { EngineIcon } from "../engines/engine-icon.tsx";
import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { openableApps } from "../workflows/reads.ts";

// Engines, as in the prototype (`routes/engines/index.tsx`): the engines
// (core's Apps) the person can open, as core lists them, each a card with
// what its current version holds, counted by core. No process bars, hours
// or "New engine": engines are made in chat.

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

/** One engine, as the prototype's card: its icon, name and what it is for, then what it holds. */
const EngineCard = ({ app, contents }: ListedApp) => (
  <li className="bg-card hover:border-ring/40 relative flex flex-col gap-4 rounded-xl border p-4 transition-colors">
    <div className="flex items-start gap-3">
      <EngineIcon />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          className="font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
          params={{ engine: app.id }}
          to="/engines/$engine"
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

/** No engine yet: engines are made in chat. */
const NoEngines = () => (
  <div className="bg-card rounded-xl border">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CogIcon />
        </EmptyMedia>
        <EmptyTitle>
          <Trans>No engines yet</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>
            There are no engines you can open yet. Engines are made in chat:
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

const Engines = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Engines` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Engines` }]} />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium tracking-tight">
            <Trans>Engines</Trans>
          </h1>
          <p className="text-muted-foreground">
            <Trans>
              Each engine runs one part of the business: its workflows, apps and
              connections.
            </Trans>
          </p>
        </div>
        {page.data.length === 0 ? (
          <NoEngines />
        ) : (
          <ul
            aria-label={t`Engines`}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {page.data.map((listed) => (
              <EngineCard key={listed.app.id} {...listed} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/engines/")({
  pendingComponent: PageLoading,
  component: Engines,
  loader: async ({ context: { core } }) => await loadFromCore(core, listApps),
});
