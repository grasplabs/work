import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonRecord } from "../grasp/blocks/page-skeleton-record/page-skeleton-record.tsx";
import { Card } from "../grasp/card/index.ts";
import { ItemGrid } from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The Integrations overview before it arrives: the page as it will stand,
// so nothing moves when it does. The header with its title waiting, the
// header card at its own height, then two runs of tiles, each tile as
// tall as a loaded one. The library has no tile-grid skeleton block, so
// it is made from the same parts the page shows.

const styles = stylex.create({
  lists: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
  },
  run: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  header: { height: "10rem" },
  heading: { width: "8rem" },
  // As tall as a loaded tile (the library's 56px app tile).
  tile: { height: `calc(${grasp.space12} + ${grasp.space2})` },
});

/** How many tiles each run shows while waiting. */
const tiles = 8;

/** A run of waiting tiles under a waiting heading. */
const Run = ({ label }: { label: string }) => (
  <div {...stylex.props(styles.run)}>
    <Skeleton layout={styles.heading} text="md" />
    <ItemGrid aria-label={label}>
      {Array.from({ length: tiles }, (_, index) => (
        <li key={index}>
          <Skeleton layout={styles.tile} pulse={false} variant="block" />
        </li>
      ))}
    </ItemGrid>
  </div>
);

/** The overview, waiting. */
export const IntegrationsSkeleton = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <Page>
        <PageHeader loading loadingLines={0} title="" />
        <div aria-busy="true" {...stylex.props(styles.lists)}>
          <Card padding="lg">
            <Skeleton layout={styles.header} variant="block" />
          </Card>
          <Run label={t`Connected`} />
          <Run label={t`Apps`} />
        </div>
      </Page>
    </>
  );
};

/** An app's own page, waiting: the library's record page, with no panel. */
export const IntegrationSkeleton = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations`, to: "/integrations" }]} />
      <Page>
        <PageSkeletonRecord descriptionLines={2} icons={false} rows={3} />
      </Page>
    </>
  );
};
