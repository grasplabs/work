import type { AppOverview } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { Page, PageHeading } from "../frame/page.tsx";
import {
  AppCard,
  AppCardGrid,
  appCardGroundOf,
} from "../grasp/app-card/index.ts";
import type { AppCardAction } from "../grasp/app-card/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { IconTile } from "../grasp/icon-tile/index.ts";
import {
  AppWindow,
  Archive,
  Expand,
  Search,
  Settings,
  Undo,
} from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { ProcessTile } from "../workflows/business-process.tsx";
import { reachOf } from "./app-reach.ts";
import type { AppReach } from "./app-reach.ts";
import { buildsApp } from "./app-role.ts";
import { ArchiveDialog, statusOf } from "./app-status.tsx";
import type { Transition } from "./app-status.tsx";

// The Apps page: every App the person can open, newest first, in three
// tabs by how they reach it (app-reach.ts): their own, shared with them,
// and the company's. Each is one of Grasp UI's App cards, four to a row on
// a desktop: its window, which is the App's own first page running in it
// at a desktop's width while the card is in view (the card's own doing),
// on a ground of its own (the card's, kept by the App's ID), its mark and name, what it is
// for and where it stands; the card opens the App (/apps/$app), and its
// "…" opens it, opens it full page, leads to its settings and, for its
// builders, archives or restores it. A search over their names, and Build
// new app for who builds, which starts a chat to make one
// (make/make-link.tsx).

const styles = stylex.create({
  // The tabs, with the search at the row's end.
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space4,
    marginBlockEnd: grasp.space6,
  },
  search: { maxWidth: "18rem" },
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
  const ground = appCardGroundOf(app.id);
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
        icon: Undo,
        disabled: busy,
        onSelect: () => {
          move("restore");
        },
      }
    : {
        label: t`Archive`,
        icon: Archive,
        disabled: busy,
        onSelect: () => {
          setArchiving(true);
        },
      };
  const actions: AppCardAction[] = [
    {
      label: t`Open`,
      icon: AppWindow,
      render: <Link params={{ app: app.id }} to="/apps/$app" />,
    },
    // Outside the shell: a document of its own.
    ...(runs ? [{ label: t`Open full page`, icon: Expand, href: full }] : []),
    {
      label: t`Settings`,
      icon: Settings,
      // A link, so it also opens in a new tab.
      render: <Link params={{ app: app.id }} to="/apps/$app/settings" />,
    },
    ...(buildsApp(app, viewer) ? [putAway] : []),
  ];
  return (
    <>
      <AppCard
        actions={actions}
        // A ground of its own, kept by its ID.
        ground={ground.ground}
        {...(ground.groundHue === undefined
          ? {}
          : { groundHue: ground.groundHue })}
        labels={{ more: t`More`, empty: t`No preview yet` }}
        mark={
          app.process === null ? (
            <IconTile icon={AppWindow} size="sm" />
          ) : (
            <ProcessTile process={app.process} />
          )
        }
        meta={metaOf[status]}
        render={<Link params={{ app: app.id }} to="/apps/$app" />}
        title={name}
        // Its window: the App itself, running while the card is in view. An
        // App with no page to run keeps a quiet window.
        {...(runs
          ? {
              preview: {
                kind: "live" as const,
                src: full,
                // Our own site's pages: in the page's process, so sharp.
                sandbox: "allow-scripts allow-same-origin",
                // Grasp's page loads before the App draws in it: the
                // window waits for the App's own word (apps.$app.full.tsx).
                ready: "message" as const,
              },
            }
          : {})}
        {...(app.description === "" ? {} : { description: app.description })}
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
      density="dense"
      empty={
        asked === "" ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia picture="nothing" />
              <EmptyDescription>{none[reach]}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia picture="search" />
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
  const build = (
    <MakeSomethingLink kind="app" label={t`Build new app`} variant="ink" />
  );
  return (
    <Page>
      <PageHeading
        // One Build new app a page: with no Apps yet, the empty state's.
        action={builds && apps.length > 0 ? build : undefined}
        title={<Trans>Apps</Trans>}
      />
      {apps.length === 0 ? (
        <Empty size="lg">
          <EmptyHeader>
            <EmptyMedia picture="nothing" />
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
          <div {...stylex.props(styles.bar)}>
            <TabsList aria-label={t`Apps`}>
              {REACHES.map((reach) => (
                <TabsTrigger key={reach} value={reach}>
                  {tabName[reach]}
                </TabsTrigger>
              ))}
            </TabsList>
            <InputGroup layout={styles.search}>
              <InputGroupText icon={Search} />
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
    </Page>
  );
};
