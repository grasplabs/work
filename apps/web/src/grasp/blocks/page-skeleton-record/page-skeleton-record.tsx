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

import { InspectorPanel } from "../../inspector-panel";
import { PageHeader } from "../../page-header";
import { RowList, RowListItem } from "../../row-list";
import { SectionCard } from "../../section-card";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the record's card, a section's gap apart: as the loaded page lays them.
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
  // A head action's place: a small button's height, a short word's width, standing still.
  action: { width: "4.5rem", height: grasp.controlSm },
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
   * How many actions the card's head holds (Edit, Share): each waits as a still small button in its
   * place, so a phone's head, where they wrap under the title, keeps its height when they arrive.
   * @default 0
   */
  actions?: number;
}

/** The record's page before it arrives: the header's placeholders, then its card's quiet rows. */
export const PageSkeletonRecord = ({
  rows = 4,
  descriptionLines = 1,
  icons = true,
  density = "comfortable",
  actions = 0,
}: PageSkeletonRecordProps) => (
  <div data-slot="page-skeleton-record" {...stylex.props(styles.page)}>
    <PageHeader
      title=""
      description={descriptionLines > 0 ? "" : undefined}
      loadingLines={descriptionLines}
      loading
    />
    <SectionCard
      title=""
      density={density}
      loading
      actions={
        actions > 0 ? (
          <span aria-hidden="true" {...stylex.props(styles.actions)}>
            {Array.from({ length: actions }, (_, index) => (
              <Skeleton key={index} variant="block" layout={styles.action} />
            ))}
          </span>
        ) : undefined
      }
    >
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
            />
          ))}
        </RowList>
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
