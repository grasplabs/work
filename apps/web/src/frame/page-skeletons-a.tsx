import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A settings section's pending state: the library's page-skeleton-settings
// block less its PageHeader. Settings' layout (routes/_shell.settings.tsx)
// already stands the section's own header, with its real name, above every
// section's page, so the block's whole page would put a second, empty one
// under it. These are the block's own sections, built as the block builds
// them (each a grouped SectionCard in its `loading`, its rows SettingRows in
// theirs, one line each as work's rows are), dropped into the layout's page
// as the loaded cards are, so each stands where its card will. Asked of
// the library: the block without its header (and a card without a title),
// which this becomes once it has them.

const styles = stylex.create({
  // A small control's box (an Input or a Select at size sm), across the
  // control's column: the block's own.
  control: { width: "100%", height: grasp.controlSm },
});

/** The rows of a settings card waiting: each a SettingRow in its `loading`. */
const Rows = ({ rows }: { rows: number }) => (
  <SettingsRows>
    {Array.from({ length: rows }, (_, row) => (
      // No help line: work's rows put their help behind the name's info mark, so each is one line.
      <SettingRow key={row} label="" loading>
        <Skeleton variant="block" layout={styles.control} />
      </SettingRow>
    ))}
  </SettingsRows>
);

/** One settings card waiting: its title's placeholder, then its rows'. */
export const SettingsCardSkeleton = ({
  rows = 0,
  children,
}: {
  /** How many settings it holds. @default 0 */
  rows?: number;
  /** In place of the rows: what the card holds while it waits, such as a table in its `loading`. */
  children?: ReactNode;
}) => (
  <SectionCard variant="grouped" flush density="compact" title="" loading>
    {children ?? <Rows rows={rows} />}
  </SectionCard>
);

/**
 * A settings card the page draws without a title over it (Workspace's
 * organization card and its settings, Billing's details), waiting: only
 * its rows, so the next card's title stands where it will. Its rows say
 * nothing, so the card is hidden from a reader as the block's rows are.
 */
const UntitledCardSkeleton = ({ rows }: { rows: number }) => (
  <div aria-hidden="true">
    <SectionCard aria-label="" flush density="compact">
      <Rows rows={rows} />
    </SectionCard>
  </div>
);

/** One card of a settings page: how many rows it holds, and whether a title stands over it. */
export type SettingsSkeletonSection = number | { rows: number; titled: false };

/**
 * A settings section's page while it loads: each card, top to bottom, by
 * how many settings it holds (a number for a card with its title over it).
 */
export const SettingsSkeleton = ({
  sections,
}: {
  sections: readonly SettingsSkeletonSection[];
}) => (
  // In the layout's page, as the loaded cards stand: its gap between them.
  <>
    {sections.map((section, index) =>
      typeof section === "number" ? (
        <SettingsCardSkeleton key={index} rows={section} />
      ) : (
        <UntitledCardSkeleton key={index} rows={section.rows} />
      )
    )}
  </>
);
