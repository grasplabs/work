import type { AppOverview, AppStatus } from "@grasp-os/shared/apps";
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
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  GlobeIcon,
  LayoutGridIcon,
  CopyIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { statusLabel } from "./app-status.tsx";

// The Apps page (grasplabs/prototype `components/apps/apps-overview.tsx`):
// every App the person can open, each one tile on a painted field that
// opens it on its own page (/apps/$app). Each app people see is one App,
// with its own data, sharing and versions; its screens are its pages,
// which its tile counts, never apps of their own. The newest App comes
// first. Split by where each stands (published, draft, archived) only when
// more than one status holds Apps, archived ones under their own tab only,
// and searchable once there are enough to need it; the tabs count what the
// search leaves. New App starts one in the chat, for who builds.
//
// Not as the prototype: a tile shows the App's bar, not a picture of its
// page (pages are built and run sandboxed when opened).

/** From this many Apps on the page it offers a search: with fewer, every name is in view anyway. */
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

/** Every App that isn't archived, as the page opens. */
const everyApp = "all";
type Shown = AppStatus | typeof everyApp;

/** Whether `status` is shown under `shown`: All leaves out the archived. */
const shownUnder = (shown: Shown, status: AppStatus): boolean =>
  shown === everyApp ? status !== "archived" : status === shown;

/** The Apps, the newest first. */
const newestFirst = (apps: readonly AppOverview[]): AppOverview[] =>
  apps.toSorted((one, other) =>
    other.app.createdAt.localeCompare(one.app.createdAt)
  );

/** New App, in lime: the page's one action. */
const NewAppLink = ({ size }: { size?: "lg" }) => (
  <Link
    className={buttonVariants({ variant: "highlight", size })}
    to="/apps/new"
  >
    <PlusIcon data-icon="inline-start" />
    <Trans>New App</Trans>
  </Link>
);

/** No App yet: the studio's question on a painted field, and the way to answer it. */
const FirstApp = ({ builds }: { builds: boolean }) => (
  <PaintedField
    className="flex min-h-72 flex-col items-center justify-center gap-6 rounded-xl px-6 py-14 text-center"
    painting="sage"
    pattern="horizon"
  >
    <h2 className="type-display max-w-xl">
      <Trans>What should the App show, and for whom?</Trans>
    </h2>
    {builds ? (
      <NewAppLink size="lg" />
    ) : (
      <p className="text-muted-foreground max-w-md">
        <Trans>The Apps your colleagues are making show here.</Trans>
      </p>
    )}
  </PaintedField>
);

/** How many pages an App's current version has. */
const PageCount = ({ pages }: { pages: number }) =>
  pages === 0 ? (
    <Trans>No pages yet</Trans>
  ) : (
    <Plural one="# page" other="# pages" value={pages} />
  );

/** One App: its bar on a painted field, then its name, which opens it, and how many pages it has. */
const AppTile = ({
  overview: { app, contents },
  field,
}: {
  overview: AppOverview;
  field: (typeof fields)[number];
}) => (
  <Tile>
    <TileField painting={field.painting} pattern={field.pattern}>
      {app.status === "published" ? (
        <Badge variant="passed">
          <GlobeIcon data-icon="inline-start" />
          {statusLabel(app.status)}
        </Badge>
      ) : null}
      <TileSheet>
        <TileSheetBar icon={<LayoutGridIcon />}>{app.name}</TileSheetBar>
      </TileSheet>
    </TileField>
    <TileContent>
      <TileTitle render={<Link params={{ app: app.id }} to="/apps/$app" />}>
        {app.name}
      </TileTitle>
      <TileMeta>
        <CopyIcon aria-hidden="true" />
        <span className="truncate">
          <PageCount pages={contents.screens.length} />
        </span>
      </TileMeta>
    </TileContent>
  </Tile>
);

/** The Apps page's body: `listed`, as core lists them; New App for who `builds`. */
export const AppsOverview = ({
  listed,
  builds,
}: {
  listed: readonly AppOverview[];
  builds: boolean;
}) => {
  const { t } = useLingui();
  const [picked, setPicked] = useState<Shown>(everyApp);
  const [query, setQuery] = useState("");
  const apps = newestFirst(listed);
  const holding = statuses.filter((status) =>
    apps.some(({ app }) => app.status === status)
  );
  // Archived Apps are always under a tab of their own, even when no other
  // status holds any: never shown as if they were in use.
  const choosing = holding.length > 1 || holding.includes("archived");
  // The tab picked, while it is there: once its status holds no App (after
  // a refresh, say), All.
  const shown =
    choosing && (picked === everyApp || holding.includes(picked))
      ? picked
      : everyApp;
  const searching = apps.length >= searchFrom;
  const asked = searching ? query.trim() : "";
  const needle = asked.toLocaleLowerCase();
  // What the search leaves, which the tabs count.
  const found = apps.filter(
    ({ app }) => needle === "" || app.name.toLocaleLowerCase().includes(needle)
  );
  const countOf = (status: Shown): number =>
    found.filter(({ app }) => shownUnder(status, app.status)).length;
  // Without tabs the one status is a published or draft one, all under All.
  const shownApps = found.filter(({ app }) => shownUnder(shown, app.status));
  return (
    <Page wide>
      <PageHeading
        // With no App yet the field below asks for the first one instead.
        action={builds && apps.length > 0 ? <NewAppLink /> : undefined}
        description={
          <Trans>
            Made for a team or one person, each with its own pages, data and
            people, standing on your workflows.
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
                setPicked(value);
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
                  aria-label={t`Search the Apps`}
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
          {shownApps.map((overview, index) => (
            <li className="min-w-0" key={overview.app.id}>
              <AppTile
                field={fields[index % fields.length] ?? fields[0]}
                overview={overview}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {apps.length > 0 && shownApps.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {asked === "" ? (
                <Trans>No App here</Trans>
              ) : (
                <Trans>No App is called “{asked}”</Trans>
              )}
            </EmptyTitle>
            <EmptyDescription>
              <Trans>Search for another name, or look under another tab.</Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </Page>
  );
};
