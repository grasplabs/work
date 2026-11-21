// Page skeleton, cards: a grid of cards (the Apps overview) before its apps arrive (a route's first
// paint), built from the parts the page will show: PageHeader's own `loading`, then the real
// AppCardGrid holding AppCards in their `loading` (each frame and window as it will stand, the
// window in its waiting look, the title, description and owner as quiet lines), so the grid's
// columns and rows do not move when the apps arrive.
//
//   <PageSkeletonCards cards={6} />
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { AppCard, AppCardGrid } from "../../app-card";
import type { AppCardGridProps } from "../../app-card";
import { PageHeader } from "../../page-header";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the grid, as the Apps page lays them.
  page: { display: "grid", gap: grasp.pageGap, minWidth: 0 },
});

export interface PageSkeletonCardsProps {
  /**
   * The page's own header (PageHeader's `loading`). `false` under a layout that already draws the
   * page's title (a settings section) or on a page with none (Inbox): the content starts at the top.
   * @default true
   */
  header?: boolean;
  /**
   * Between the header and the content: the page's tabs, search field or filters, as the loaded page
   * has them where they need no data, else a PageSkeletonToolbar of their kind, so the content
   * stands where it will.
   */
  toolbar?: ReactNode;
  /**
   * The page's actions in its header, as the loaded page has them (they need no data): drawn in
   * their place, so actions that wrap under the title on a phone take their room at once and the
   * content does not drop when the page arrives.
   */
  actions?: ReactNode;
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
  header = true,
  toolbar,
  actions,
}: PageSkeletonCardsProps) => (
  <div
    data-slot="page-skeleton-cards"
    aria-busy={header ? undefined : true}
    {...stylex.props(styles.page)}
  >
    {header ? (
      <PageHeader
        title=""
        description={descriptionLines > 0 ? "" : undefined}
        loadingLines={descriptionLines}
        actions={actions}
        loading
      />
    ) : null}
    {toolbar}
    <AppCardGrid density={density}>
      {Array.from({ length: cards }, (_, index) => (
        <AppCard key={index} title="" loading loadingLines={cardLines} />
      ))}
    </AppCardGrid>
  </div>
);
