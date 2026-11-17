import type { AppOverview } from "@grasp-os/shared/apps";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { AppCard, AppCardGrid } from "../grasp/app-card/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Search, Settings } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { statusOf } from "./app-status.tsx";

// The Apps page: every App the person can open, newest first, as Grasp
// UI's App cards: its window (quiet, naming the App, until each version
// has a picture of its own), its name, what it is for and where it
// stands; the card opens the App (/apps/$app). A
// search over their names, and Make something for who builds, which
// starts a chat to make an App (make/make-link.tsx).

const styles = stylex.create({
  search: { maxWidth: "18rem" },
});

/**
 * App card links with a plain `<a href>`, which would load the whole
 * product again: a plain press on a card's link goes through the router
 * instead, and a press with a modifier (a new tab) stays the browser's.
 */
const useRoutedCardLinks = (): ((
  element: HTMLElement | null
) => () => void) => {
  const navigate = useNavigate();
  return (element) => {
    const onClick = (event: MouseEvent): void => {
      const modified =
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey;
      if (event.defaultPrevented || modified) {
        return;
      }
      const link =
        event.target instanceof Element
          ? event.target.closest("a[data-card-link]")
          : null;
      const href = link?.getAttribute("href");
      if (href === null || href === undefined) {
        return;
      }
      event.preventDefault();
      void navigate({ href });
    };
    element?.addEventListener("click", onClick);
    return () => {
      element?.removeEventListener("click", onClick);
    };
  };
};

/** One App: its card. */
const OneApp = ({ overview: { app } }: { overview: AppOverview }) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const status = statusOf(app);
  const metaOf = {
    live: t`Your team uses it`,
    draft: t`Only you see this`,
    archived: t({ message: "Archived", context: "an App put away" }),
  };
  return (
    <AppCard
      actions={[
        {
          label: t`Settings`,
          icon: Settings,
          onSelect: () => {
            void navigate({
              to: "/apps/$app/settings",
              params: { app: app.id },
            });
          },
        },
      ]}
      href={`/apps/${app.id}`}
      // Until each version has its picture, the window is quiet and
      // names the App.
      labels={{ more: t`More`, empty: app.name }}
      meta={metaOf[status]}
      title={app.name}
      {...(app.description === "" ? {} : { description: app.description })}
    />
  );
};

/** The Apps, the newest first. */
const newestFirst = (apps: readonly AppOverview[]): AppOverview[] =>
  apps.toSorted((one, other) =>
    other.app.createdAt.localeCompare(one.app.createdAt)
  );

/** The Apps page's body: `listed`, as core lists them; Make something for who `builds`. */
export const AppsOverview = ({
  listed,
  builds,
}: {
  listed: readonly AppOverview[];
  builds: boolean;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const room = useRoutedCardLinks();
  const apps = newestFirst(listed);
  const asked = query.trim();
  const needle = asked.toLocaleLowerCase();
  const shown = apps.filter(
    ({ app }) => needle === "" || app.name.toLocaleLowerCase().includes(needle)
  );
  return (
    <Page wide>
      <PageHeading
        // One Make something a page: with no Apps yet, the empty state's.
        action={
          builds && apps.length > 0 ? (
            <MakeSomethingLink kind="app" />
          ) : undefined
        }
        title={<Trans>Apps</Trans>}
      />
      {apps.length === 0 ? (
        <Empty size="page">
          <EmptyHeader>
            <EmptyMedia picture="nothing" />
            <EmptyTitle>{t`No Apps yet`}</EmptyTitle>
            <EmptyDescription>
              {builds ? (
                <Trans>Say what you want to build, and Grasp builds it.</Trans>
              ) : (
                <Trans>
                  The Apps your colleagues share with you show here.
                </Trans>
              )}
            </EmptyDescription>
          </EmptyHeader>
          {builds ? (
            <EmptyContent>
              <MakeSomethingLink kind="app" />
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
            <section aria-label={t`Apps`} ref={room}>
              <AppCardGrid>
                {shown.map((overview) => (
                  <OneApp key={overview.app.id} overview={overview} />
                ))}
              </AppCardGrid>
            </section>
          )}
        </>
      )}
    </Page>
  );
};
