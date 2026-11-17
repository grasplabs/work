import type { AppOverview } from "@grasp-os/shared/apps";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { formatDate } from "../format.ts";
import { Page, PageHeading } from "../frame/page.tsx";
import { Card, CardDescription, CardTitle } from "../grasp/card/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Search } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { StatusBadge } from "./app-status.tsx";

// The Apps page: every App the person can open, newest first, as a grid of
// cards (its name, what it is for, where it stands and when it was made),
// each opening the App (/apps/$app). A search over their names, and Make
// something for who builds, which starts a chat to make an App
// (make/make-link.tsx).

// How wide a card grows before the grid adds a column: Grasp UI has no
// token for a card's measure.
const CARD_MIN = "16rem";

const styles = stylex.create({
  search: { maxWidth: "18rem" },
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(min(${CARD_MIN}, 100%), 1fr))`,
    gap: grasp.space4,
    margin: 0,
    padding: 0,
  },
  card: { position: "relative" },
  // The name's link covers the whole card, so the card opens the App.
  open: {
    color: "inherit",
    textDecoration: "none",
    outline: "none",
    "::after": { content: '""', position: "absolute", inset: 0 },
  },
  meta: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    marginTop: grasp.space3,
  },
});

/** One App: its card, whose name opens it. */
const AppCard = ({ overview: { app } }: { overview: AppOverview }) => {
  const made = formatDate(app.createdAt);
  return (
    <Card element="li" layout={styles.card}>
      <CardTitle>
        <Link
          params={{ app: app.id }}
          to="/apps/$app"
          {...stylex.props(styles.open)}
        >
          {app.name}
        </Link>
      </CardTitle>
      {app.description === "" ? null : (
        <CardDescription>{app.description}</CardDescription>
      )}
      <div {...stylex.props(styles.meta)}>
        <StatusBadge app={app} />
        <Text element="span" size="xs" tone="muted">
          <Trans>Made {made}</Trans>
        </Text>
      </div>
    </Card>
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
        <Empty
          action={builds ? <MakeSomethingLink kind="app" /> : undefined}
          picture="nothing"
          size="page"
          title={t`No Apps yet`}
        >
          {builds ? (
            <Trans>Say what you want to build, and Grasp builds it.</Trans>
          ) : (
            <Trans>The Apps your colleagues share with you show here.</Trans>
          )}
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
            <Empty picture="search">
              <Trans>No App is called “{asked}”</Trans>
            </Empty>
          ) : (
            <ul aria-label={t`Apps`} {...stylex.props(styles.grid)}>
              {shown.map((overview) => (
                <AppCard key={overview.app.id} overview={overview} />
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
};
