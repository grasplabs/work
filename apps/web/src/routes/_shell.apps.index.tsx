import type { AppStatus, ListedScreen } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
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
import type { Painting, Pattern } from "@grasp-os/ui/components/painted-field";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import {
  Tile,
  TileActions,
  TileContent,
  TileField,
  TileMeta,
  TileSheet,
  TileSheetBar,
  TileTitle,
} from "@grasp-os/ui/components/tile";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CogIcon,
  EllipsisIcon,
  GlobeIcon,
  LayoutGridIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useState } from "react";

import { buildsApp } from "../engines/app-role.ts";
import { statusLabel, useStatusMove } from "../engines/app-status.tsx";
import type { Transition } from "../engines/app-status.tsx";
import { ErrorText } from "../error-text.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Apps page (grasplabs/prototype `components/apps/apps-overview.tsx`):
// the apps of every domain the person can open, each a tile on a painted
// field that opens the app on its App's page (/apps/$app), as the
// prototype's tile does. An app is what people read for one of a domain's
// screens; the domains themselves are the Domains page's. The newest
// domain's apps come first. Split by where their domain stands
// (published, draft, archived) only when more than one holds apps, and
// searchable once there are enough to need it; the tabs count what the
// search leaves. New app starts one in the chat, for who builds.
//
// A tile's "…" menu, for who builds its domain, holds what core does to
// the domain the app belongs to: its settings (the domain's page), and
// archiving or restoring it, which takes all of its apps along.
//
// Two reads: `apps.screens` lists the apps, core reading each domain's
// screens from its current version's row; `apps.list` says which domains
// the person builds.
//
// Not as the prototype: a tile shows the app's bar, not a picture of its
// screen (screens are built and run sandboxed when opened), and has no
// owner or time edited, nor a rename, which core keeps per domain, not
// per app (GRA-1251).

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

/** One app: a screen of a domain, and whether the person builds that domain. */
interface DomainApp {
  domain: ListedScreen["app"];
  screen: string;
  builds: boolean;
  /** How many apps its domain has, this one included: archiving it takes them all. */
  apps: number;
}

/** The screens core lists, in its order (the newest domain's first). */
const appsOf = (
  screens: readonly ListedScreen[],
  built: ReadonlySet<string>
): DomainApp[] => {
  const counts = new Map<string, number>();
  for (const { app } of screens) {
    counts.set(app.id, (counts.get(app.id) ?? 0) + 1);
  }
  return screens.map(({ app, screen }) => ({
    domain: app,
    screen,
    builds: built.has(app.id),
    apps: counts.get(app.id) ?? 1,
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

/**
 * A tile's "…" menu: what core does to the app's domain, for who builds
 * it. Settings opens the domain's page; Archive asks first, as archiving
 * takes every app of the domain offline; Restore takes it back as a draft.
 */
const TileMenu = ({
  app: { domain, screen, apps },
  busy,
  move,
}: {
  app: DomainApp;
  busy: boolean;
  move: (transition: Transition) => void;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [archiving, setArchiving] = useState(false);
  return (
    <TileActions>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          render={
            <Button
              aria-label={t`More for ${screen}`}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => {
              void navigate({
                to: "/domains/$engine",
                params: { engine: domain.id },
              });
            }}
          >
            <SettingsIcon />
            <Trans>Settings</Trans>
          </DropdownMenuItem>
          {domain.status === "archived" ? (
            <DropdownMenuItem
              onClick={() => {
                move("restore");
              }}
            >
              <ArchiveRestoreIcon />
              <Trans>Restore domain</Trans>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => {
                setArchiving(true);
              }}
            >
              <ArchiveIcon />
              <Trans>Archive domain</Trans>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ArchiveDomainDialog
        apps={apps}
        domain={domain.name}
        onArchive={() => {
          setArchiving(false);
          move("archive");
        }}
        onOpenChange={setArchiving}
        open={archiving}
      />
    </TileActions>
  );
};

/**
 * Asks before archiving a tile's domain, naming it and saying that all
 * its apps (`apps` of them) go with it, not only the tile's.
 */
const ArchiveDomainDialog = ({
  domain,
  apps,
  open,
  onOpenChange,
  onArchive,
}: {
  domain: string;
  apps: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: () => void;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Archive {domain}?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Plural
            one="Its # app is archived with it."
            other="Its # apps are archived with it."
            value={apps}
          />
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onArchive} variant="destructive">
          <Trans>Archive</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/** One app: its bar on a painted field, then its name, which opens it, and its domain. */
const AppTile = ({
  app,
  field,
}: {
  app: DomainApp;
  field: (typeof fields)[number];
}) => {
  const { domain, screen, builds } = app;
  const { busy, failure, move } = useStatusMove(domain.id);
  return (
    <Tile>
      <TileField painting={field.painting} pattern={field.pattern}>
        {domain.status === "published" ? (
          <Badge variant="passed">
            <GlobeIcon data-icon="inline-start" />
            {statusLabel(domain.status)}
          </Badge>
        ) : null}
        {domain.status === "archived" ? (
          <Badge>{statusLabel(domain.status)}</Badge>
        ) : null}
        <TileSheet>
          <TileSheetBar icon={<LayoutGridIcon />}>{screen}</TileSheetBar>
        </TileSheet>
      </TileField>
      <div className="flex items-start gap-3">
        <TileContent className="flex-1">
          <TileTitle
            render={
              <Link
                params={{ app: domain.id }}
                search={{ screen }}
                to="/apps/$app"
              />
            }
          >
            {screen}
          </TileTitle>
          <TileMeta>
            <CogIcon aria-hidden="true" />
            <span className="truncate">{domain.name}</span>
          </TileMeta>
        </TileContent>
        {builds ? <TileMenu app={app} busy={busy} move={move} /> : null}
      </div>
      <ErrorText>{failure}</ErrorText>
    </Tile>
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
  const apps = appsOf(page.data.screens, page.data.built);
  const builds = canBuild(identity.role);
  const holding = statuses.filter((status) =>
    apps.some(({ domain }) => domain.status === status)
  );
  const choosing = holding.length > 1;
  const searching = apps.length >= searchFrom;
  const asked = searching ? query.trim() : "";
  const needle = asked.toLocaleLowerCase();
  // What the search leaves, which the tabs count.
  const found = apps.filter(
    ({ domain, screen }) =>
      needle === "" ||
      screen.toLocaleLowerCase().includes(needle) ||
      domain.name.toLocaleLowerCase().includes(needle)
  );
  const countOf = (status: Shown): number =>
    status === everyApp
      ? found.length
      : found.filter(({ domain }) => domain.status === status).length;
  const shownApps =
    shown === everyApp || !choosing
      ? found
      : found.filter(({ domain }) => domain.status === shown);
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Apps` }]} />
      <Page wide>
        <PageHeading
          // With no app yet the field below asks for the first one instead.
          action={builds && apps.length > 0 ? <NewAppLink /> : undefined}
          description={
            <Trans>
              Screens made for a team or one person, standing on your workflows.
            </Trans>
          }
          title={<Trans>Apps</Trans>}
        />
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
                      {countOf(everyApp)}
                    </span>
                  </TabsTrigger>
                  {holding.map((status) => (
                    <TabsTrigger key={status} value={status}>
                      {statusLabel(status)}
                      <span className="text-muted-foreground tabular-nums">
                        {countOf(status)}
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
        {apps.length === 0 ? <FirstApp builds={builds} /> : null}
        {shownApps.length > 0 ? (
          <ul
            aria-label={t`Apps`}
            className="grid grid-cols-1 gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3"
          >
            {shownApps.map((app, index) => (
              <li className="min-w-0" key={`${app.domain.id}/${app.screen}`}>
                <AppTile
                  app={app}
                  field={fields[index % fields.length] ?? fields[0]}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {apps.length > 0 && shownApps.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                <Trans>No app is called “{asked}”</Trans>
              </EmptyTitle>
              <EmptyDescription>
                <Trans>
                  Search for another name, or look under another tab.
                </Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/")({
  pendingComponent: PageLoading,
  component: AppsOverview,
  loader: async ({ context: { core, identity } }) =>
    await loadFromCore(core, async (session) => {
      const [screens, domains] = await Promise.all([
        session.apps.screens(),
        session.apps.list(),
      ]);
      // The domains the person may change: by their role in each, never
      // Grasp staff's (app-role.ts).
      const built = new Set<string>(
        domains.flatMap((domain) =>
          buildsApp(domain, identity) ? [domain.id] : []
        )
      );
      return { screens, built };
    }),
});
