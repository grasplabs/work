// Page skeleton, settings: a settings page's pending state (a route's first paint, before its
// values), built from the parts the page will show, so nothing moves when it arrives: PageHeader's
// own `loading`, then a grouped SectionCard per section in its own `loading` (its title a
// placeholder), each holding SettingRows in their `loading` (the name's and the help's lines quiet,
// each in its own line) with a placeholder as tall as a small control in the control's place.
//
//   <PageSkeletonSettings sections={[3, 2]} />
import * as stylex from "@stylexjs/stylex";

import { PageHeader } from "../../page-header";
import { SectionCard } from "../../section-card";
import { SettingRow, SettingsRows } from "../../setting-row";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the sections, a section's gap apart: as the loaded settings page lays them.
  page: { display: "grid", gap: grasp.sectionGap, minWidth: 0 },
  // A small control's box (an Input or a Select at size sm), across the control's column.
  control: { width: "100%", height: grasp.controlSm },
});

export interface PageSkeletonSettingsProps {
  /** How many settings each section holds, top to bottom. @default [3, 2] */
  sections?: readonly number[];
}

const twoSections = [3, 2] as const;

/** A settings page before its values: the header's placeholder, then each section's quiet rows. */
export const PageSkeletonSettings = ({
  sections = twoSections,
}: PageSkeletonSettingsProps) => (
  <div data-slot="page-skeleton-settings" {...stylex.props(styles.page)}>
    <PageHeader size="md" title="" loading />
    {sections.map((rows, section) => (
      <SectionCard
        key={section}
        variant="grouped"
        flush
        density="compact"
        title=""
        loading
      >
        <SettingsRows>
          {Array.from({ length: rows }, (_, row) => (
            <SettingRow key={row} label="" help="" loading>
              <Skeleton variant="block" layout={styles.control} />
            </SettingRow>
          ))}
        </SettingsRows>
      </SectionCard>
    ))}
  </div>
);
