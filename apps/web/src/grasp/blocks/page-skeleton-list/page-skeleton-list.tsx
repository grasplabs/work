// Page skeleton, list: a list page's pending state (a route's first paint, before its rows), built
// from the parts the page will show, so nothing moves when it arrives: PageHeader's own `loading`,
// then a RowList whose rows are real RowListItems (each its own 44px box, its hairline between)
// holding a quiet Skeleton line where the name and the detail go. The rows' widths are a fixed run,
// the same on every paint. The list is busy and its placeholders hidden from a reader: the page's
// header says it is loading.
//
//   <PageSkeletonList rows={6} />
import * as stylex from "@stylexjs/stylex";

import { PageHeader } from "../../page-header";
import { RowList, RowListItem } from "../../row-list";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the list, a section's gap apart: as the loaded page lays them.
  page: { display: "grid", gap: grasp.space6, minWidth: 0 },
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
  /** How many rows to hold room for: as many as the page shows at first. @default 6 */
  rows?: number;
  /**
   * How many lines the page's description takes, so the header keeps its height: 0 for a page with
   * none, 2 where it wraps (a phone, a long line). @default 1
   */
  descriptionLines?: number;
  /** The page's rows lead with their kind's icon: each placeholder shows the icon's box, then its line where the name will start. Without, the line starts where a name does. @default true */
  icons?: boolean;
}

/** A list page before its rows: the header's placeholders, then quiet rows in the rows' own boxes. */
export const PageSkeletonList = ({
  rows = 6,
  descriptionLines = 1,
  icons = true,
}: PageSkeletonListProps) => (
  <div
    data-slot="page-skeleton-list"
    aria-busy="true"
    {...stylex.props(styles.page)}
  >
    <PageHeader
      title=""
      description={descriptionLines > 0 ? "" : undefined}
      loadingLines={descriptionLines}
      loading
    />
    <div aria-hidden="true">
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
    </div>
  </div>
);
