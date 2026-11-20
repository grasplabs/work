// Page skeleton, toolbar: the row between a page's header and its content, still, at the real control's height.
// For a page skeleton's `toolbar` when the page's tabs, search field or filters wait for data (a
// count in a tab, filters read from the records). Where the control needs no data, give the real
// one instead, as the loaded page has it. Each kind stands in the control's own box:
//
//   <PageSkeletonList toolbar={<PageSkeletonToolbar variant="tabs" />} />     tabs on their hairline
//   <PageSkeletonList toolbar={<PageSkeletonToolbar variant="search" />} />   a search field's empty frame
//   <PageSkeletonList toolbar={<PageSkeletonToolbar variant="filters" />} />  a row of small filters
//
// A word waits as a quiet line; a control waits as its own empty frame. Hidden from a reader: the
// page's header says it is loading.
import * as stylex from "@stylexjs/stylex";

import { Icon, Search } from "../../icons";
import { iconVars } from "../../icons/icon.stylex";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // Tabs: a large control's height, the words a tab gap apart, on the list's hairline.
  tabs: {
    display: "flex",
    alignItems: "center",
    gap: grasp.tabGap,
    minHeight: grasp.controlLg,
    minWidth: 0,
    overflow: "hidden",
    boxShadow: `inset 0 -1px 0 ${grasp.line}`,
  },
  // A search field: the field's own empty frame at its default size (its height, corner and
  // hairline edge, no fill), as wide as the column lets it be, its icon at the start.
  search: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    height: grasp.controlMd,
    paddingInlineStart: grasp.space3,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
    color: grasp.muted,
  },
  // Filters: small controls in a row, a small gap apart.
  filters: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
    minWidth: 0,
  },
  // A small control's own empty frame: its height, corner and hairline edge, no fill.
  filter: {
    boxSizing: "border-box",
    height: grasp.controlSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
  w16: { width: "4rem" },
  w20: { width: "5rem" },
  w24: { width: "6rem" },
});

const TAB_WIDTHS = [styles.w20, styles.w16, styles.w24];
const FILTER_WIDTHS = [styles.w24, styles.w20, styles.w24];

/** Which control the row stands for. */
export type PageSkeletonToolbarVariant = "tabs" | "search" | "filters";

export interface PageSkeletonToolbarProps {
  /** `tabs` on their hairline, `search` a field, `filters` a row of small controls. */
  variant: PageSkeletonToolbarVariant;
  /** How many tabs or filters it holds. @default 3 */
  count?: number;
}

/** The row between a page's header and its content, waiting in the real control's box. */
export const PageSkeletonToolbar = ({
  variant,
  count = 3,
}: PageSkeletonToolbarProps) => {
  if (variant === "search") {
    return (
      <div
        aria-hidden="true"
        data-slot="page-skeleton-toolbar"
        {...stylex.props(styles.search)}
      >
        <Icon icon={Search} />
      </div>
    );
  }
  const tabs = variant === "tabs";
  const widths = tabs ? TAB_WIDTHS : FILTER_WIDTHS;
  return (
    <div
      aria-hidden="true"
      data-slot="page-skeleton-toolbar"
      {...stylex.props(tabs ? styles.tabs : styles.filters)}
    >
      {Array.from({ length: count }, (_, index) => {
        const width = widths[index % widths.length] ?? styles.w20;
        // A tab is its word, so it waits as a word's line; a filter is a control, so its empty frame.
        return tabs ? (
          <Skeleton key={index} layout={width} />
        ) : (
          <span key={index} {...stylex.props(styles.filter, width)} />
        );
      })}
    </div>
  );
};
