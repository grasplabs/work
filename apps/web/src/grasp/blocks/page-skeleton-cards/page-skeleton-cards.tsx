// Page skeleton, cards: a grid of cards (the Apps overview) before its apps arrive (a route's first
// paint), built from the parts the page will show: PageHeader's own `loading`, then the real
// AppCardGrid holding AppCards in their `loading` (each frame and window as it will stand, the
// window in its waiting look, the title, description and owner as quiet lines), so the grid's
// columns and rows do not move when the apps arrive.
//
//   <PageSkeletonCards cards={6} />
import * as stylex from "@stylexjs/stylex";

import { AppCard, AppCardGrid } from "../../app-card";
import type { AppCardGridProps } from "../../app-card";
import { PageHeader } from "../../page-header";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the grid, as the Apps page lays them.
  page: { display: "grid", gap: grasp.space8, minWidth: 0 },
});

export interface PageSkeletonCardsProps {
  /** How many cards the grid holds at first. @default 6 */
  cards?: number;
  /** How many lines the page's description takes: 0 for none. @default 1 */
  descriptionLines?: number;
  /** How many lines each card's description takes: 0 for none. @default 2 */
  cardLines?: number;
  /** The grid's density, as the loaded page's. @default "comfortable" */
  density?: AppCardGridProps["density"];
}

/** A grid of cards before it arrives: the header's placeholders, then the grid of waiting cards. */
export const PageSkeletonCards = ({
  cards = 6,
  descriptionLines = 1,
  cardLines = 2,
  density,
}: PageSkeletonCardsProps) => (
  <div data-slot="page-skeleton-cards" {...stylex.props(styles.page)}>
    <PageHeader
      title=""
      description={descriptionLines > 0 ? "" : undefined}
      loadingLines={descriptionLines}
      loading
    />
    <AppCardGrid density={density}>
      {Array.from({ length: cards }, (_, index) => (
        <AppCard key={index} title="" loading loadingLines={cardLines} />
      ))}
    </AppCardGrid>
  </div>
);
