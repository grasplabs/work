// Page skeleton, list: a list page's pending state (a route's first paint, before its rows), built
// from the parts the page will show, so nothing moves when it arrives: PageHeader's own `loading`,
// then a RowList whose rows are real RowListItems (each its own 44px box, its hairline between)
// holding a quiet Skeleton line where the name and the detail go. The rows' widths are a fixed run,
// the same on every paint. The list is busy and its placeholders hidden from a reader: the page's
// header says it is loading.
//
//   <PageSkeletonList rows={6} />
//   <PageSkeletonList variant="items" rows={6} />   two-line rows with an icon: Items in their `loading`
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../item";
import { PageHeader } from "../../page-header";
import { RowList, RowListItem } from "../../row-list";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the list, a section's gap apart: as the loaded page lays them.
  page: { display: "grid", gap: grasp.pageGap, minWidth: 0 },
  // A row's placeholder, in the row's mark slot after an empty name: pulled back over the row's own
  // gap, so its first box stands where the row's first box will (the kind's icon, or the name), and
  // its line, a gap on, where the name's words will start.
  lead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    marginInlineStart: `calc(-1 * ${grasp.space2})`,
  },
  // The kind's icon's box, as the Sidebar's loading rows show theirs.
  icon: { flexShrink: 0, width: grasp.iconSm, height: grasp.iconSm },
  // A name's width: as long as a few words, short enough that the detail still fits a phone's row.
  w40: { width: "6rem" },
  w48: { width: "8rem" },
  w56: { width: "10rem" },
  w64: { width: "7rem" },
  detail: { width: "4rem" },
});

const WIDTHS = [
  styles.w56,
  styles.w40,
  styles.w64,
  styles.w48,
  styles.w56,
  styles.w40,
  styles.w48,
  styles.w64,
];

export interface PageSkeletonListProps {
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
  /** How many rows to hold room for: as many as the page shows at first. @default 6 */
  rows?: number;
  /**
   * How many lines the page's description takes, so the header keeps its height: 0 for a page with
   * none, 2 where it wraps (a phone, a long line). @default 1
   */
  descriptionLines?: number;
  /**
   * What the page's rows are: `rows`, RowList's one-line rows (44px); `items`, an ItemGroup of
   * Items two lines high with an icon in its square, each an Item in its own `loading`.
   * @default "rows"
   */
  variant?: "rows" | "items";
  /** With `variant="items"`: a hairline between the rows, as the page's ItemGroup has. @default true */
  separated?: boolean;
  /** With `variant="items"`: the Items' size, as the page's rows have it (`xs` among setting rows and in an inbox, `sm` dense). @default "md" */
  size?: "xs" | "sm" | "md";
  /** With `variant="items"`: how each row's icon stands, `square` in its box or `inline`, the bare icon on the title's line. @default "square" */
  iconLook?: "square" | "inline";
  /** The page's rows lead with their kind's icon: each placeholder shows the icon's box, then its line where the name will start. Without, the line starts where a name does. @default true */
  icons?: boolean;
}

/** A list page before its rows: the header's placeholders, then quiet rows in the rows' own boxes. */
export const PageSkeletonList = ({
  rows = 6,
  descriptionLines = 1,
  icons = true,
  variant = "rows",
  separated = true,
  size = "md",
  iconLook = "square",
  header = true,
  toolbar,
  actions,
}: PageSkeletonListProps) => (
  <div
    data-slot="page-skeleton-list"
    aria-busy="true"
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
    <div aria-hidden="true">
      {variant === "items" ? (
        <ItemGroup separated={separated}>
          {Array.from({ length: rows }, (_, index) => (
            <Item key={index} size={size} loading>
              {icons ? <ItemMedia iconLook={iconLook} /> : null}
              <ItemContent>
                <ItemTitle />
                <ItemDescription />
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <RowList>
          {Array.from({ length: rows }, (_, index) => (
            <RowListItem
              key={index}
              name=""
              mark={
                <span {...stylex.props(styles.lead)}>
                  {icons ? (
                    <Skeleton variant="block" layout={styles.icon} />
                  ) : null}
                  <Skeleton
                    text="sm"
                    layout={WIDTHS[index % WIDTHS.length] ?? styles.w48}
                  />
                </span>
              }
              detail={<Skeleton text="sm" layout={styles.detail} />}
            />
          ))}
        </RowList>
      )}
    </div>
  </div>
);
