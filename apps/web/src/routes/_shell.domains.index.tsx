import type { App, AppContents, AppStatus } from "@grasp-os/shared/apps";
import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { PaintedField } from "@grasp-os/ui/components/painted-field";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  GlobeIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  SearchIcon,
  TagIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { listedOrNone, readPeople } from "../directory.ts";
import { statusLabel } from "../engines/app-status.tsx";
import {
  allStatuses,
  fieldAt,
  heldStatuses,
  nameMatches,
  searchFrom,
} from "../engines/domain-tiles.ts";
import type { Field, ShownStatus } from "../engines/domain-tiles.ts";
import { EngineIcon } from "../engines/engine-icon.tsx";
import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Owner } from "../landscape/owner.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { openableApps } from "../workflows/reads.ts";

// Domains, as the prototype's Apps page (`components/apps/apps-overview.tsx`):
// the domains (core's Apps) the person can open, as core lists them, each
// a tile on a painted field, the fields in turn (engines/domain-tiles.ts).
// On the field a white card runs off its foot, as the brand shows the
// product; it holds what the domain's current version holds, counted by
// core, where the prototype has the app's screen (core draws no picture
// of a domain yet). A published one says so on its field. Under the field
// its name, what it is for, and who answers for it, with whom it is for.
// No process bars, hours or "New domain": domains are made in chat. Its
// builders also see the drafts and the archived ones: then, a tab for
// each status that holds one, beside All, and from seven domains on a
// search.

interface ListedApp {
  app: App;
  /** Undefined when core didn't answer for this App. */
  contents?: AppContents;
}

/** The domains, and the names of who answers for them and whom they are for. */
interface DomainsPage {
  listed: ListedApp[];
  /** People's names by ID, as far as the person may list them. */
  people: ReadonlyMap<string, string>;
  /** Teams' names by ID, as far as the person may list them. */
  teams: ReadonlyMap<string, string>;
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

/**
 * The page's reads: the domains, and beside them, only for names, the
 * people and the teams. Either list may be refused (only admins and
 * builders list teams) or slow: a tile then leaves out the name it lacks.
 */
const loadDomains = async (session: Session): Promise<DomainsPage> => {
  const [listed, people, teams] = await Promise.all([
    listApps(session),
    readPeople(session),
    listedOrNone(session.workflows.teams()),
  ]);
  return {
    listed,
    people,
    teams: new Map(teams.map(({ id, name }) => [id, name])),
  };
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

/** Whom a domain is for, by name, if a builder said and the name can be read. */
const audienceName = (
  app: App,
  { people, teams }: DomainsPage
): string | undefined => {
  const { audience } = app;
  if (audience === null) {
    return undefined;
  }
  return audience.type === "team"
    ? teams.get(audience.id)
    : people.get(audience.id);
};

/** Who answers for the domain, and for whom it is: "For Finance", or else their name. */
const MadeFor = ({ app, page }: { app: App; page: DomainsPage }) => {
  const { t } = useLingui();
  const owner = page.people.get(app.responsible);
  const audience = audienceName(app, page);
  if (owner === undefined && audience === undefined) {
    return null;
  }
  return (
    <span className="text-muted-foreground mt-1 flex min-w-0 items-center gap-2 text-xs">
      {owner === undefined ? null : <Owner compact name={owner} />}
      <span className="truncate">
        {audience === undefined ? owner : t`For ${audience}`}
      </span>
    </span>
  );
};

/**
 * One domain, as the prototype's app tile: its painted field, with a
 * white card running off the field's foot that holds what it holds, and
 * whether it is published; then its name, what it is for, and for whom.
 * The name is the link, its press area stretched over the whole tile;
 * the owner's portrait stands above it, for who they are on hover.
 */
const DomainTile = ({
  listed: { app, contents },
  field,
  page,
}: {
  listed: ListedApp;
  field: Field;
  page: DomainsPage;
}) => (
  <li className="min-w-0">
    <article className="group/domain relative flex flex-col gap-3.5">
      <PaintedField
        className="aspect-video rounded-xl px-6 pt-6"
        painting={field.painting}
        pattern={field.pattern}
      >
        <div className="bg-card text-card-foreground shadow-on-field flex h-full flex-col gap-3 rounded-t-lg p-4 transition-transform duration-150 group-hover/domain:-translate-y-1 motion-reduce:transition-none">
          <EngineIcon />
          <Counts contents={contents} />
        </div>
        {app.status === "published" ? (
          <Badge className="absolute top-3 left-3" variant="passed">
            <GlobeIcon data-icon="inline-start" />
            {statusLabel("published")}
          </Badge>
        ) : null}
      </PaintedField>
      <div className="flex min-w-0 flex-col gap-1 px-0.5">
        <Link
          className="focus-visible:after:ring-ring/50 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3"
          params={{ engine: app.id }}
          to="/domains/$engine"
        >
          {app.name}
        </Link>
        {app.description === "" ? null : (
          <p className="text-muted-foreground line-clamp-2 text-pretty">
            {app.description}
          </p>
        )}
        <MadeFor app={app} page={page} />
      </div>
    </article>
  </li>
);

/**
 * No domain yet: Grasp's own question on a painted field, as the
 * prototype's first app, and the way to answer it, the page's one action:
 * domains are made in chat.
 */
const NoEngines = () => (
  <PaintedField
    className="flex min-h-72 flex-col items-center justify-center gap-6 rounded-xl px-6 py-14 text-center"
    painting="sage"
    pattern="horizon"
  >
    <h2 className="type-display max-w-xl">
      <Trans>Which part of your work should a domain run?</Trans>
    </h2>
    <p className="text-muted-foreground max-w-md">
      <Trans>
        There are no domains you can open yet. Domains are made in chat:
        describe a part of your work, and Grasp builds its workflows and apps.
      </Trans>
    </p>
    <Link
      className={buttonVariants({ size: "lg", variant: "highlight" })}
      search={{}}
      to="/"
    >
      <MessageSquareIcon data-icon="inline-start" />
      <Trans>Open Chat</Trans>
    </Link>
  </PaintedField>
);

/** The domains as tiles, in a grid, each on the next field. */
const DomainGrid = ({
  listed,
  page,
}: {
  listed: ListedApp[];
  page: DomainsPage;
}) => {
  const { t } = useLingui();
  return (
    <ul
      aria-label={t`Domains`}
      className="grid grid-cols-1 gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3"
    >
      {listed.map((each, index) => (
        <DomainTile
          field={fieldAt(index)}
          key={each.app.id}
          listed={each}
          page={page}
        />
      ))}
    </ul>
  );
};

/** How many a tab holds, after its name. */
const Count = ({ count }: { count: number }) => (
  <span className="text-muted-foreground tabular-nums">{count}</span>
);

/**
 * The domains, all at once as the page opens, split by status in tabs
 * only when more than one status holds a domain (only builders see
 * drafts and archived ones), and with a search from `searchFrom` on.
 */
const ByStatus = ({ page }: { page: DomainsPage }) => {
  const { t } = useLingui();
  const [shown, setShown] = useState<ShownStatus>(allStatuses);
  const [query, setQuery] = useState("");
  const { listed } = page;
  const held = heldStatuses(listed.map(({ app }) => app.status));
  const choosing = held.length > 1;
  const searching = listed.length >= searchFrom;
  const asked = searching ? query.trim() : "";
  // A tab whose status no longer holds a domain (read again since) is gone:
  // then all of them again.
  const tab =
    shown !== allStatuses && choosing && held.includes(shown)
      ? shown
      : allStatuses;
  const inTab =
    tab === allStatuses
      ? listed
      : listed.filter(({ app }) => app.status === tab);
  const found = inTab.filter(({ app }) => nameMatches(app.name, asked));
  const countOf = (status: AppStatus): number =>
    listed.filter(({ app }) => app.status === status).length;
  return (
    <div className="flex flex-col gap-6">
      {choosing || searching ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {choosing ? (
            <Tabs
              className="min-w-0"
              onValueChange={(value: ShownStatus) => {
                setShown(value);
              }}
              value={tab}
            >
              <TabsList variant="line">
                <TabsTrigger value={allStatuses}>
                  <Trans context="filter: every domain">All</Trans>
                  <Count count={listed.length} />
                </TabsTrigger>
                {held.map((each) => (
                  <TabsTrigger key={each} value={each}>
                    {statusLabel(each)}
                    <Count count={countOf(each)} />
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
          {searching ? (
            <div className="ml-auto w-full sm:w-60">
              <InputGroup>
                <InputGroupInput
                  aria-label={t`Search the domains`}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder={t`Search`}
                  value={query}
                />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
            </div>
          ) : null}
        </div>
      ) : null}
      {found.length === 0 ? (
        // Only a search leaves a tab empty: a tab is there for a status
        // that holds a domain.
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <Trans>No domain is called “{asked}”</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>Search for another name, or look under another tab.</Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DomainGrid listed={found} page={page} />
      )}
    </div>
  );
};

const Engines = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Domains` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Domains` }]} />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <div className="flex flex-col gap-1">
          <h1 className="type-title">
            <Trans>Domains</Trans>
          </h1>
          <p className="text-muted-foreground">
            <Trans>
              Each domain runs one part of the business: its workflows, apps and
              connections.
            </Trans>
          </p>
        </div>
        {page.data.listed.length === 0 ? (
          <NoEngines />
        ) : (
          <ByStatus page={page.data} />
        )}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/domains/")({
  pendingComponent: PageLoading,
  component: Engines,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, loadDomains),
});
