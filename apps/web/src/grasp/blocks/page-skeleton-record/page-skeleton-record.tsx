// Page skeleton, record: a record's page with its panel, before the record arrives (a route's first
// paint), built from the parts the page will show, so nothing moves when it does. Two parts: the
// page (PageHeader's own `loading`, then a SectionCard in its `loading` holding real RowList rows
// with a quiet line where each name goes), and the panel the host seats as App shell's
// `pagePanel` (an InspectorPanel in its `loading`: its title and line placeholders, its sections as
// they will stand, the host's own fact names, each value Key value's own pending value).
//
//   <AppShell pagePanel={<PageSkeletonRecordPanel sections={[{ id: "about", label: "About", facts: ["Owner", "Updated"] }]} />}>
//     <PageSkeletonRecord rows={4} />
//   </AppShell>
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { InspectorPanel } from "../../inspector-panel";
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
import { SectionCard } from "../../section-card";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the record's card, a section's gap apart: as the loaded page lays them.
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
  // A head action's own empty frame: a small button's height and corner, a short word's width, its
  // hairline edge and no fill, standing still.
  action: {
    boxSizing: "border-box",
    width: "4.5rem",
    height: grasp.controlSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
  actions: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

const WIDTHS = [
  styles.w56,
  styles.w40,
  styles.w64,
  styles.w48,
  styles.w56,
  styles.w40,
];

export interface PageSkeletonRecordProps {
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
   * The page's actions in its header (`actions` is the card's head here), as the loaded page has them (they need no data): drawn in
   * their place, so actions that wrap under the title on a phone take their room at once and the
   * content does not drop when the page arrives.
   */
  headerActions?: ReactNode;
  /** How many rows the record's card holds at first. @default 4 */
  rows?: number;
  /**
   * How many lines the page's description takes, so the header keeps its height: 0 for a page with
   * none, 2 where it wraps (a phone, a long line). @default 1
   */
  descriptionLines?: number;
  /** The card's rows lead with their kind's icon: each placeholder shows the icon's box, then its line where the name will start. Without, the line starts where a name does. @default true */
  icons?: boolean;
  /**
   * The card's density, as the loaded card's: `compact` for a dense page (a settings card, a
   * record in a narrow column), SectionCard's own.
   * @default "comfortable"
   */
  density?: "comfortable" | "compact";
  /**
   * How many actions the card's head holds (Edit, Share): each waits as a small button's empty frame
   * in its place, so a phone's head, where they wrap under the title, keeps its height when they arrive.
   * @default 0
   */
  actions?: number;
  /**
   * What the card's rows are: `rows`, RowList's one-line rows (44px); `items`, an ItemGroup of Items
   * two lines high, each in its own `loading` (a project's Apps).
   * @default "rows"
   */
  variant?: "rows" | "items";
  /** With `items`: their size, as the loaded card's rows have it. @default "md" */
  size?: "xs" | "sm" | "md";
  /** With `items`: the icon in its square, or `inline`, the bare icon on the title's line. @default "square" */
  iconLook?: "square" | "inline";
}

/** The card's rows waiting: RowList's one-line rows, or two-line Items in their `loading`. */
const Rows = ({
  rows,
  icons,
  variant,
  size,
  iconLook,
}: {
  rows: number;
  icons: boolean;
  variant: "rows" | "items";
  size: "xs" | "sm" | "md";
  iconLook: "square" | "inline";
}) =>
  variant === "items" ? (
    <ItemGroup separated>
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
              {icons ? <Skeleton variant="block" layout={styles.icon} /> : null}
              <Skeleton
                text="sm"
                layout={WIDTHS[index % WIDTHS.length] ?? styles.w48}
              />
            </span>
          }
        />
      ))}
    </RowList>
  );

/** The record's page before it arrives: the header's placeholders, then its card's quiet rows. */
export const PageSkeletonRecord = ({
  rows = 4,
  descriptionLines = 1,
  icons = true,
  density = "comfortable",
  actions = 0,
  variant = "rows",
  size = "md",
  iconLook = "square",
  header = true,
  toolbar,
  headerActions,
}: PageSkeletonRecordProps) => (
  <div
    data-slot="page-skeleton-record"
    aria-busy={header ? undefined : true}
    {...stylex.props(styles.page)}
  >
    {header ? (
      <PageHeader
        title=""
        description={descriptionLines > 0 ? "" : undefined}
        loadingLines={descriptionLines}
        actions={headerActions}
        loading
      />
    ) : null}
    {toolbar}
    <SectionCard
      title=""
      density={density}
      loading
      actions={
        actions > 0 ? (
          <span aria-hidden="true" {...stylex.props(styles.actions)}>
            {Array.from({ length: actions }, (_, index) => (
              <span key={index} {...stylex.props(styles.action)} />
            ))}
          </span>
        ) : undefined
      }
    >
      <div aria-hidden="true">
        <Rows
          rows={rows}
          icons={icons}
          variant={variant}
          size={size}
          iconLook={iconLook}
        />
      </div>
    </SectionCard>
  </div>
);

/** One of the panel's sections as it will stand: its label and its facts' names, the host's words. */
export interface PageSkeletonRecordSection {
  id: string;
  label: string;
  facts: readonly string[];
}

export interface PageSkeletonRecordPanelProps {
  /** The panel's sections as the record's panel will show them. */
  sections: readonly PageSkeletonRecordSection[];
  /** The panel's name for a screen reader, as the loaded panel's. */
  "aria-label"?: string;
}

/** The record's panel before it arrives: an InspectorPanel waiting in its own form. */
export const PageSkeletonRecordPanel = ({
  sections,
  "aria-label": label,
}: PageSkeletonRecordPanelProps) => (
  <InspectorPanel
    aria-label={label}
    title=""
    description=""
    loading
    sections={sections.map((section) => ({
      id: section.id,
      label: section.label,
      // Each value waits as Key value's own pending value, at a short line's width.
      facts: section.facts.map((key) => ({ key, value: "", pending: true })),
    }))}
  />
);
