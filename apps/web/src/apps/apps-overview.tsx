import type { AppOverview } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { toast } from "@grasp-os/ui/components/toast";
import {
  ArchiveIcon,
  Icon,
  Maximize2Icon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UndoIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { AppWindowIcon } from "../frame/sidebar-icons.ts";
import { useCoreAction } from "../use-core-action.ts";
import { ProcessTile } from "../workflows/business-process.tsx";
import { AppCard, AppCardGrid } from "./app-card/app-card.tsx";
import type { AppCardAction } from "./app-card/app-card.tsx";
import { appCardGroundOf } from "./app-card/ground.tsx";
import { reachOf } from "./app-reach.ts";
import type { AppReach } from "./app-reach.ts";
import { buildsApp } from "./app-role.ts";
import { ArchiveDialog, statusOf } from "./app-status.tsx";
import type { Transition } from "./app-status.tsx";

// The Apps page: every App the person can open, newest first, in three
// tabs by how they reach it (app-reach.ts): their own, shared with them,
// and the company's. Each is an App card (app-card/), four to a row on a
// desktop: its window on a ground of its own (kept by the App's ID), its
// mark and name, what it is for and where it stands; the card opens the
// App (/apps/$app), and its "…" opens it, opens it full page, leads to its
// settings and, for its builders, archives or restores it. A search over
// their names, and Build new app for who builds, which starts a chat to
// make one (the normal chat page, `/?make=app`).

const styles = stylex.create({
  // The tabs, with the search at the row's end.
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[4],
  },
  // The room between the bar and the cards: with the tab panel's own 16px,
  // the page gap (24px), as the Apps page's skeleton lays it.
  barRoom: { marginBlockEnd: space[2] },
  search: { width: "100%", maxWidth: "18rem" },
  // The page as wide as the pane, its sides and top the pane's room and its
  // foot clear of the chat's bar, as the reference's app shell gives every
  // page (one width through the product).
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space[6],
    width: "100%",
    boxSizing: "border-box",
    paddingInline: space[6],
    paddingTop: space[7],
    paddingBottom: space[24],
  },
});

/** Who looks at the Apps: what they may make and change follows from it. */
type Viewer = Pick<Identity, "role" | "staff" | "userId">;

/** One App: its card. */
const OneApp = ({
  overview: { app, contents },
  viewer,
}: {
  overview: AppOverview;
  viewer: Viewer;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  const [archiving, setArchiving] = useState(false);
  const { name } = app;
  const status = statusOf(app);
  const { scene, hue } = appCardGroundOf(app.id);
  const metaOf = {
    live: t`Your team uses it`,
    draft: t`Only you see this`,
    archived: t({ message: "Archived", context: "an App put away" }),
  };
  // Archives or restores it, then reads the Apps again; why not, in a toast.
  const move = (transition: Transition): void => {
    void run(
      async (session) => {
        await changeThenRefresh(
          async () => await session.apps[transition](app.id),
          async () => {
            await router.invalidate({ sync: true });
          }
        );
      },
      (reason) => {
        toast.error(reason);
      }
    );
  };
  // Only a live App with a page has one to run in its window.
  const runs = status === "live" && contents.pages;
  const full = `/apps/${app.id}/full`;
  const putAway: AppCardAction = app.archived
    ? {
        label: t`Restore`,
        icon: UndoIcon,
        disabled: busy,
        onSelect: () => {
          move("restore");
        },
      }
    : {
        label: t`Archive`,
        icon: ArchiveIcon,
        disabled: busy,
        onSelect: () => {
          setArchiving(true);
        },
      };
  const actions: AppCardAction[] = [
    {
      label: t`Open`,
      icon: AppWindowIcon,
      render: <Link params={{ app: app.id }} to="/apps/$app" />,
    },
    // Outside the shell: a document of its own.
    ...(runs
      ? [{ label: t`Open full page`, icon: Maximize2Icon, href: full }]
      : []),
    {
      label: t`Settings`,
      icon: SettingsIcon,
      // A link, so it also opens in a new tab.
      render: <Link params={{ app: app.id }} to="/apps/$app/settings" />,
    },
    ...(buildsApp(app, viewer) ? [putAway] : []),
  ];
  return (
    <>
      <AppCard
        actions={actions}
        app={app.id}
        description={app.description}
        hue={hue}
        mark={
          app.process === null ? (
            <IconTile icon={AppWindowIcon} size="sm" />
          ) : (
            <ProcessTile process={app.process} />
          )
        }
        meta={metaOf[status]}
        scene={scene}
        title={name}
      />
      <ArchiveDialog
        name={name}
        onArchive={() => {
          setArchiving(false);
          move("archive");
        }}
        onOpenChange={setArchiving}
        open={archiving}
      />
    </>
  );
};

/** The Apps, the newest first. */
const newestFirst = (apps: readonly AppOverview[]): AppOverview[] =>
  apps.toSorted((one, other) =>
    other.app.createdAt.localeCompare(one.app.createdAt)
  );

/** The tabs, in order: the first with Apps in it is shown first. */
const REACHES: readonly AppReach[] = ["mine", "shared", "company"];

/** Build new app: a chat to make one, on the normal chat page. */
const BuildNewApp = () => (
  <Button asChild variant="default">
    <Link search={{ make: "app" }} to="/">
      <Icon icon={PlusIcon} />
      <Trans>Build new app</Trans>
    </Link>
  </Button>
);

/** One tab's Apps, or why it has none. */
const AppsTab = ({
  apps,
  asked,
  reach,
  viewer,
}: {
  apps: readonly AppOverview[];
  asked: string;
  reach: AppReach;
  viewer: Viewer;
}) => {
  const { t } = useLingui();
  const none = {
    mine: t`Apps you build or answer for stand here.`,
    shared: t`No one has shared an App with you yet.`,
    company: t`Your company has no other Apps yet.`,
  };
  return (
    <AppCardGrid
      empty={
        asked === "" ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia illustration="nothing" />
              <EmptyDescription>{none[reach]}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia illustration="search" />
              <EmptyDescription>
                <Trans>No App is called “{asked}”</Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      }
    >
      {apps.map((overview) => (
        <OneApp key={overview.app.id} overview={overview} viewer={viewer} />
      ))}
    </AppCardGrid>
  );
};

/**
 * The Apps page's body: `listed`, as core lists them, for `viewer`, with
 * the Apps shared with them by name (`shared`); Build new app for who builds.
 */
export const AppsOverview = ({
  listed,
  shared,
  viewer,
}: {
  listed: readonly AppOverview[];
  shared: readonly string[];
  viewer: Viewer;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const builds = canBuild(viewer.role);
  const apps = newestFirst(listed);
  const sharedWithThem = new Set(shared);
  const reached = (reach: AppReach) =>
    apps.filter(
      ({ app }) => reachOf(app, viewer.userId, sharedWithThem) === reach
    );
  const [tab, setTab] = useState<AppReach>(
    () => REACHES.find((reach) => reached(reach).length > 0) ?? "mine"
  );
  const asked = query.trim();
  const needle = asked.toLocaleLowerCase();
  const found = (reach: AppReach) =>
    reached(reach).filter(
      ({ app }) =>
        needle === "" || app.name.toLocaleLowerCase().includes(needle)
    );
  const tabName = {
    mine: t`My apps`,
    shared: t`Shared apps`,
    company: t`Company apps`,
  };
  const build = <BuildNewApp />;
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        // One Build new app a page: with no Apps yet, the empty state's.
        actions={builds && apps.length > 0 ? build : undefined}
        title={<Trans>Apps</Trans>}
      />
      {apps.length === 0 ? (
        <Empty size="lg">
          <EmptyHeader>
            <EmptyMedia illustration="nothing" />
            <EmptyTitle>{t`No Apps yet`}</EmptyTitle>
            {/* Only who builds is told what to do. */}
            {builds ? (
              <EmptyDescription>
                <Trans>Say what you want to build, and Grasp builds it.</Trans>
              </EmptyDescription>
            ) : null}
          </EmptyHeader>
          {builds ? <EmptyContent>{build}</EmptyContent> : null}
        </Empty>
      ) : (
        <Tabs
          onValueChange={(value) => {
            const chosen = REACHES.find((reach) => reach === value);
            if (chosen !== undefined) {
              setTab(chosen);
            }
          }}
          value={tab}
        >
          <div {...stylex.props(styles.bar, styles.barRoom)}>
            <TabsList aria-label={t`Apps`} variant="line">
              {REACHES.map((reach) => (
                <TabsTrigger key={reach} value={reach}>
                  {tabName[reach]}
                </TabsTrigger>
              ))}
            </TabsList>
            <InputGroup style={styles.search}>
              <InputGroupAddon>
                <Icon icon={SearchIcon} />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t`Search the Apps`}
                onValueChange={(value: string) => {
                  setQuery(value);
                }}
                placeholder={t`Search`}
                value={query}
              />
            </InputGroup>
          </div>
          {REACHES.map((reach) => (
            <TabsContent key={reach} value={reach}>
              <AppsTab
                apps={found(reach)}
                asked={asked}
                reach={reach}
                viewer={viewer}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
};
