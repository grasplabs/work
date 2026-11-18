import type { AppOverview } from "@grasp-os/shared/apps";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { AppCard } from "../grasp/app-card/index.ts";
import type { AppCardAction } from "../grasp/app-card/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
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
import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { buildsApp } from "./app-role.ts";
import {
  ArchiveDialog,
  StatusBadge,
  statusOf,
  useStatusMove,
} from "./app-status.tsx";
import { useInView } from "./in-view.ts";

// The Apps page: every App the person can open, newest first, as Grasp
// UI's App cards, three to a row on a desktop: its window, which is the
// App's own first page running in it while the card is on screen
// (in-view.ts), its name, what it is for and where it stands; the card
// opens the App (/apps/$app), and its "…" opens it, opens it full page,
// leads to its settings and, for its builders, archives or restores it. A
// search over their names, and Make something for who builds, which
// starts a chat to make an App (make/make-link.tsx).

// The narrowest a card stands: three fit a desktop's page beside the
// sidebar, one a phone. Grasp UI's own grid goes to three only from 96rem
// of room.
const CARD_MIN = "18rem";

const styles = stylex.create({
  search: { maxWidth: "18rem" },
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(min(${CARD_MIN}, 100%), 1fr))`,
    columnGap: grasp.space6,
    rowGap: grasp.space8,
  },
  // A card, and under it where it stands, starting where the card's words do.
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space2,
    minWidth: 0,
  },
  whole: { width: "100%" },
  state: { paddingInline: grasp.space1 },
  // Fills the window, as the App's page will.
  waiting: { width: "100%", height: "100%" },
});

/** Who looks at the Apps: what they may make and change follows from it. */
type Viewer = Pick<Identity, "role" | "staff">;

/** One App: its card, and where it stands. */
const OneApp = ({
  overview: { app, contents },
  viewer,
}: {
  overview: AppOverview;
  viewer: Viewer;
}) => {
  const { t } = useLingui();
  const { watch, inView } = useInView();
  const { busy, failure, move } = useStatusMove(app.id);
  const [archiving, setArchiving] = useState(false);
  const { name } = app;
  // Only a live App with a page has one to run in its window.
  const runs = statusOf(app) === "live" && contents.pages;
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
  // Its window: the App running while the card is on screen, a skeleton
  // before and after; an App with no page to run keeps a quiet window.
  const running = {
    kind: "live" as const,
    src: full,
    // The App's pages are our own site's: in the page's process, so sharp.
    sandbox: "allow-scripts allow-same-origin",
  };
  const waiting = <Skeleton layout={styles.waiting} variant="block" />;
  const window = inView ? running : waiting;
  return (
    <div ref={watch} {...stylex.props(styles.card)}>
      <AppCard
        actions={actions}
        labels={{ more: t`More`, empty: t`No preview yet` }}
        layout={styles.whole}
        render={<Link params={{ app: app.id }} to="/apps/$app" />}
        title={name}
        {...(runs ? { preview: window } : {})}
        {...(app.description === "" ? {} : { description: app.description })}
      />
      <span {...stylex.props(styles.state)}>
        <StatusBadge app={app} />
      </span>
      {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
      <ArchiveDialog
        name={name}
        onArchive={() => {
          setArchiving(false);
          move("archive");
        }}
        onOpenChange={setArchiving}
        open={archiving}
      />
    </div>
  );
};

/** The Apps, the newest first. */
const newestFirst = (apps: readonly AppOverview[]): AppOverview[] =>
  apps.toSorted((one, other) =>
    other.app.createdAt.localeCompare(one.app.createdAt)
  );

/** The Apps page's body: `listed`, as core lists them, for `viewer`; Make something for who builds. */
export const AppsOverview = ({
  listed,
  viewer,
}: {
  listed: readonly AppOverview[];
  viewer: Viewer;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const builds = canBuild(viewer.role);
  const apps = newestFirst(listed);
  const asked = query.trim();
  const needle = asked.toLocaleLowerCase();
  const shown = apps.filter(
    ({ app }) => needle === "" || app.name.toLocaleLowerCase().includes(needle)
  );
  return (
    <Page>
      <PageHeading
        // One Make something a page: with no Apps yet, the empty state's.
        action={
          builds && apps.length > 0 ? (
            <MakeSomethingLink kind="app" variant="ink" />
          ) : undefined
        }
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
          {builds ? (
            <EmptyContent>
              <MakeSomethingLink kind="app" variant="ink" />
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <>
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
          {shown.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia picture="search" />
                <EmptyDescription>
                  <Trans>No App is called “{asked}”</Trans>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <section aria-label={t`Apps`} {...stylex.props(styles.grid)}>
              {shown.map((overview) => (
                <OneApp
                  key={overview.app.id}
                  overview={overview}
                  viewer={viewer}
                />
              ))}
            </section>
          )}
        </>
      )}
    </Page>
  );
};
