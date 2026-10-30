import type { App, AppStatus } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
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
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { PaintedField } from "@grasp-os/ui/components/painted-field";
import type { Painting, Pattern } from "@grasp-os/ui/components/painted-field";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GlobeIcon, LayoutGridIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import type { Session } from "../core.ts";
import { readPeople } from "../directory.ts";
import { statusLabel } from "../engines/app-status.tsx";
import { formatDate } from "../format.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { OwnerAvatar } from "../landscape/owner.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { openableApps } from "../workflows/reads.ts";

// The Apps page (grasplabs/prototype `components/apps/apps-overview.tsx`):
// every App the person can open, as an app, each on a painted field, the
// newest first; a tile opens the App's own page. The same Apps are the
// Domains page's domains: there each is a part of the business, here what
// people work in. Split by where they stand (published, draft, archived)
// only when more than one of those holds any, and searchable once there
// are enough to need it. New app starts one in the chat, for who builds.
//
// Not as the prototype: a tile shows its App's bar, not a picture of its
// screen (our screens are built and run sandboxed when opened); it says
// when the App was made, as core keeps no time it was last edited; and it
// has no menu of its own, as the App's page has the same actions.

/** From this many apps on the page it offers a search: with fewer, every name is in view anyway. */
const searchFrom = 7;

/**
 * The fields the tiles lie on, in turn: a painting and a pattern each,
 * so no two side by side are alike.
 */
const fields = [
  { painting: "dawn", pattern: "columns" },
  { painting: "sand", pattern: "rings" },
  { painting: "blush", pattern: "grid" },
  { painting: "mist", pattern: "horizon" },
  { painting: "sage", pattern: "mosaic" },
  { painting: "stone", pattern: "rows" },
] as const satisfies readonly { painting: Painting; pattern: Pattern }[];

/** The tabs after All, in the prototype's order. */
const statuses = [
  "published",
  "draft",
  "archived",
] as const satisfies readonly AppStatus[];

/** Every app at once, as the page opens. */
const everyApp = "all";
type Shown = AppStatus | typeof everyApp;

interface ListedApp {
  app: App;
  /** Who answers for it, by name; their ID when it isn't known. */
  responsible: string;
}

/** The person's Apps, the newest first, each with who answers for it. */
const listApps = async (session: Session): Promise<ListedApp[]> => {
  const [apps, people] = await Promise.all([
    openableApps(session),
    readPeople(session),
  ]);
  return apps
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((app) => ({
      app,
      responsible: people.get(app.responsible) ?? app.responsible,
    }));
};

/** New app, in lime: the page's one action. */
const NewAppLink = ({ size }: { size?: "lg" }) => (
  <Link
    className={buttonVariants({ variant: "highlight", size })}
    to="/apps/new"
  >
    <PlusIcon data-icon="inline-start" />
    <Trans>New app</Trans>
  </Link>
);

/** No app yet: the studio's question on a painted field, and the way to answer it. */
const FirstApp = ({ builds }: { builds: boolean }) => (
  <PaintedField
    className="flex min-h-72 flex-col items-center justify-center gap-6 rounded-xl px-6 py-14 text-center"
    painting="sage"
    pattern="horizon"
  >
    <h2 className="type-display max-w-xl">
      <Trans>What should the app show, and for whom?</Trans>
    </h2>
    {builds ? (
      <NewAppLink size="lg" />
    ) : (
      <p className="text-muted-foreground max-w-md">
        <Trans>The apps your colleagues are making show here.</Trans>
      </p>
    )}
  </PaintedField>
);

/** What a tab with nothing in it says: what would stand there. */
const EmptyTab = ({ status }: { status: AppStatus }) => {
  if (status === "published") {
    return (
      <>
        <EmptyTitle>
          <Trans>No published apps yet</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>
            Publish one from its page, and the people it is shared with can open
            it.
          </Trans>
        </EmptyDescription>
      </>
    );
  }
  if (status === "archived") {
    return (
      <EmptyTitle>
        <Trans>Nothing archived.</Trans>
      </EmptyTitle>
    );
  }
  return (
    <EmptyTitle>
      <Trans>No drafts.</Trans>
    </EmptyTitle>
  );
};

/**
 * One app: its bar on a painted field, the sheet running off the field's
 * foot as the brand shows the product, then its name, what it is for,
 * who answers for it and when it was made. The whole tile opens it.
 */
const AppTile = ({
  listed: { app, responsible },
  field,
}: {
  listed: ListedApp;
  field: (typeof fields)[number];
}) => {
  const made = formatDate(app.createdAt);
  return (
    <article className="group/app relative flex flex-col gap-3.5">
      <PaintedField
        className="aspect-video rounded-xl px-6 pt-6"
        painting={field.painting}
        pattern={field.pattern}
      >
        <span
          aria-hidden="true"
          className="bg-background shadow-lifted flex h-full flex-col rounded-t-lg transition-transform motion-safe:group-hover/app:-translate-y-1"
        >
          {app.currentVersion === null ? (
            <span className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-xs">
              <LayoutGridIcon className="size-5" />
              <Trans>No design yet</Trans>
            </span>
          ) : (
            <span className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
              <span className="bg-muted inline-flex size-5 flex-none items-center justify-center rounded-md">
                <LayoutGridIcon className="size-3" />
              </span>
              <span className="truncate">{app.name}</span>
            </span>
          )}
        </span>
        {app.status === "draft" ? null : (
          <Badge
            className="absolute top-3 left-3"
            variant={app.status === "published" ? "passed" : "default"}
          >
            {app.status === "published" ? (
              <GlobeIcon data-icon="inline-start" />
            ) : null}
            {statusLabel(app.status)}
          </Badge>
        )}
      </PaintedField>
      <div className="flex min-w-0 flex-col gap-1 px-0.5">
        <Link
          className="focus-visible:after:ring-ring/50 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3"
          params={{ app: app.id }}
          to="/apps/$app"
        >
          {app.name}
        </Link>
        {app.description === "" ? null : (
          <span className="text-muted-foreground line-clamp-2 text-pretty">
            {app.description}
          </span>
        )}
        <span className="text-muted-foreground mt-1 flex min-w-0 items-center gap-2 text-xs">
          <OwnerAvatar name={responsible} />
          <span className="truncate">
            <Trans>
              {responsible} · Made on {made}
            </Trans>
          </span>
        </span>
      </div>
    </article>
  );
};

const AppsOverview = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const [shown, setShown] = useState<Shown>(everyApp);
  const [query, setQuery] = useState("");
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Apps` }]} page={page} />;
  }
  const listed = page.data;
  const builds = canBuild(identity.role);
  const holding = statuses.filter((status) =>
    listed.some(({ app }) => app.status === status)
  );
  const choosing = holding.length > 1;
  const searching = listed.length >= searchFrom;
  const asked = searching ? query.trim() : "";
  const needle = asked.toLocaleLowerCase();
  const shownApps = listed.filter(
    ({ app }) =>
      (shown === everyApp || !choosing || app.status === shown) &&
      (needle === "" || app.name.toLocaleLowerCase().includes(needle))
  );
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Apps` }]} />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>
              <Trans>Apps</Trans>
            </PageHeaderTitle>
            <PageHeaderDescription>
              <Trans>
                Screens made for a team or one person, standing on your
                workflows.
              </Trans>
            </PageHeaderDescription>
          </PageHeaderContent>
          {/* With no app yet the field below asks for the first one instead. */}
          {builds && listed.length > 0 ? (
            <PageHeaderActions>
              <NewAppLink />
            </PageHeaderActions>
          ) : null}
        </PageHeader>
        {choosing || searching ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {choosing ? (
              <Tabs
                className="min-w-0"
                onValueChange={(value: Shown) => {
                  setShown(value);
                }}
                value={shown}
              >
                <TabsList variant="line">
                  <TabsTrigger value={everyApp}>
                    <Trans context="filter: every app">All</Trans>
                    <span className="text-muted-foreground tabular-nums">
                      {listed.length}
                    </span>
                  </TabsTrigger>
                  {holding.map((status) => (
                    <TabsTrigger key={status} value={status}>
                      {statusLabel(status)}
                      <span className="text-muted-foreground tabular-nums">
                        {
                          listed.filter(({ app }) => app.status === status)
                            .length
                        }
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : null}
            {searching ? (
              <div className="ml-auto w-full sm:w-60">
                <InputGroup>
                  <InputGroupInput
                    aria-label={t`Search the apps`}
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
        {listed.length === 0 ? <FirstApp builds={builds} /> : null}
        {listed.length > 0 && shownApps.length > 0 ? (
          <ul
            aria-label={t`Apps`}
            className="grid grid-cols-1 gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3"
          >
            {shownApps.map((each, index) => (
              <li className="min-w-0" key={each.app.id}>
                <AppTile
                  field={fields[index % fields.length] ?? fields[0]}
                  listed={each}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {listed.length > 0 && shownApps.length === 0 ? (
          <Empty>
            <EmptyHeader>
              {asked === "" && shown !== everyApp ? (
                <EmptyTab status={shown} />
              ) : (
                <>
                  <EmptyTitle>
                    <Trans>No app is called “{asked}”</Trans>
                  </EmptyTitle>
                  <EmptyDescription>
                    <Trans>
                      Search for another name, or look under another tab.
                    </Trans>
                  </EmptyDescription>
                </>
              )}
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/")({
  pendingComponent: PageLoading,
  component: AppsOverview,
  loader: async ({ context: { core } }) => await loadFromCore(core, listApps),
});
