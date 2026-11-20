// Page skeleton, settings: a settings page's pending state (a route's first paint, before its
// values), built from the parts the page will show, so nothing moves when it arrives: PageHeader's
// own `loading`, then a grouped SectionCard per section in its own `loading` (its title a
// placeholder), each holding SettingRows in their `loading` (the name's and the help's lines quiet,
// each in its own line) with the small control's own empty frame in the control's place.
//
//   <PageSkeletonSettings sections={[3, 2]} />
//   <PageSkeletonSettings header={false} help={false} sections={[{ rows: 2, title: false }, 3]} />
//
// A card the page draws with no title over it (an organization's own settings at the top) waits
// as its rows alone, so the next card's title stands where it will; rows whose help sits behind
// the name's info mark are one line each (`help={false}`).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { PageHeader } from "../../page-header";
import { SectionCard } from "../../section-card";
import { SettingRow, SettingsRows } from "../../setting-row";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the sections, a section's gap apart: as the loaded settings page lays them.
  page: { display: "grid", gap: grasp.sectionGap, minWidth: 0 },
  // A small control's own empty frame (an Input or a Select at size sm), across the control's
  // column: its height, its corner and its hairline edge, with no fill and nothing in it, so the
  // field is already there when its value arrives.
  control: {
    boxSizing: "border-box",
    width: "100%",
    height: grasp.controlSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
});

export interface PageSkeletonSettingsProps {
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
  /**
   * Each section, top to bottom: how many settings it holds (a card with its title over it), or
   * `{ rows, title: false }` for a card the page draws with no title. @default [3, 2]
   */
  sections?: readonly (number | PageSkeletonSettingsSection)[];
  /**
   * Each row has a help line under its name. `false` where the help sits behind the name's info
   * mark, so each row is one line. @default true
   */
  help?: boolean;
}

/** A section given in full: its rows, and whether a title stands over it. */
export interface PageSkeletonSettingsSection {
  /** How many settings it holds. */
  rows: number;
  /** A title over the card. @default true */
  title?: boolean;
}

/** The rows of a card waiting: each a SettingRow in its `loading`, a small control's box in its place. */
const Rows = ({ rows, help }: { rows: number; help: boolean }) => (
  <SettingsRows>
    {Array.from({ length: rows }, (_, row) => (
      <SettingRow key={row} label="" {...(help ? { help: "" } : {})} loading>
        <span data-slot="field-frame" {...stylex.props(styles.control)} />
      </SettingRow>
    ))}
  </SettingsRows>
);

/** One section waiting: its title's placeholder over it, or the rows alone (hidden from a reader). */
const Section = ({
  section,
  help,
}: {
  section: number | PageSkeletonSettingsSection;
  help: boolean;
}) => {
  const rows = typeof section === "number" ? section : section.rows;
  if (typeof section !== "number" && section.title === false) {
    return (
      <div aria-hidden="true">
        <SectionCard aria-label="" flush density="compact">
          <Rows rows={rows} help={help} />
        </SectionCard>
      </div>
    );
  }
  return (
    <SectionCard variant="grouped" flush density="compact" title="" loading>
      <Rows rows={rows} help={help} />
    </SectionCard>
  );
};

const twoSections = [3, 2] as const;

/** A settings page before its values: the header's placeholder, then each section's quiet rows. */
export const PageSkeletonSettings = ({
  sections = twoSections,
  help = true,
  header = true,
  toolbar,
  actions,
}: PageSkeletonSettingsProps) => (
  <div
    data-slot="page-skeleton-settings"
    aria-busy={header ? undefined : true}
    {...stylex.props(styles.page)}
  >
    {header ? (
      <PageHeader size="md" title="" actions={actions} loading />
    ) : null}
    {toolbar}
    {sections.map((section, index) => (
      <Section key={index} section={section} help={help} />
    ))}
  </div>
);
