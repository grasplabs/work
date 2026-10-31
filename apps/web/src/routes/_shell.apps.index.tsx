import type { AppStatus, ListedScreen } from "@grasp-os/shared/apps";
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
import { PaintedField } from "@grasp-os/ui/components/painted-field";
import type { Painting, Pattern } from "@grasp-os/ui/components/painted-field";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import {
  Tile,
  TileContent,
  TileField,
  TileMeta,
  TileSheet,
  TileSheetBar,
  TileTitle,
} from "@grasp-os/ui/components/tile";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CogIcon,
  GlobeIcon,
  LayoutGridIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";

import { statusLabel } from "../engines/app-status.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Apps page (grasplabs/prototype `components/apps/apps-overview.tsx`):
// the apps of every domain the person can open, each a tile on a painted
// field that opens the app in its domain (/domains/$engine/apps/$screen).
// An app is what people read for one of a domain's screens; the domains
// themselves are the Domains page's. The newest domain's apps come first.
// Split by where their domain stands (published, draft) only when both
// hold apps, and searchable once there are enough to need it; the tabs
// count what the search leaves. An archived domain's apps aren't listed:
// nobody works in them until it is restored. New app starts one in the
// chat, for who builds.
//
// One read lists them all (`apps.screens`): core finds the domains as it
// lists them and reads each one's screens from its current version's row.
//
// Not as the prototype: a tile shows the app's bar, not a picture of its
// screen (screens are built and run sandboxed when opened), and has no
// menu, owner or time edited, which core keeps per domain, not per app.

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

/** The tabs after All, in the prototype's order; an archived domain's apps aren't listed. */
const statuses = ["published", "draft"] as const satisfies readonly AppStatus[];
type Listed = (typeof statuses)[number];

/** Every app at once, as the page opens. */
const everyApp = "all";
type Shown = Listed | typeof everyApp;

/** One app: a screen of a domain that isn't archived. */
interface DomainApp {
  domain: ListedScreen["app"] & { status: Listed };
  screen: string;
}

const isListed = (
  domain: ListedScreen["app"]
): domain is ListedScreen["app"] & { status: Listed } =>
  domain.status !== "archived";

/** The screens core lists, in its order (the newest domain's first), but an archived domain's. */
const appsOf = (screens: readonly ListedScreen[]): DomainApp[] =>
  screens.flatMap(({ app, screen }) =>
    isListed(app) ? [{ domain: app, screen }] : []
  );

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

/** One app: its bar on a painted field, then its name, which opens it, and its domain. */
const AppTile = ({
  app: { domain, screen },
  field,
}: {
  app: DomainApp;
  field: (typeof fields)[number];
}) => (
  <Tile>
    <TileField painting={field.painting} pattern={field.pattern}>
      {domain.status === "published" ? (
        <Badge variant="passed">
          <GlobeIcon data-icon="inline-start" />
          {statusLabel(domain.status)}
        </Badge>
      ) : null}
      <TileSheet>
        <TileSheetBar icon={<LayoutGridIcon />}>{screen}</TileSheetBar>
      </TileSheet>
    </TileField>
    <TileContent>
      <TileTitle
        render={
          <Link
            params={{ engine: domain.id, screen }}
            to="/domains/$engine/apps/$screen"
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
  </Tile>
);

const AppsOverview = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const [shown, setShown] = useState<Shown>(everyApp);
  const [query, setQuery] = useState("");
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Apps` }]} page={page} />;
  }
  const apps = appsOf(page.data);
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
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => await session.apps.screens()),
});
