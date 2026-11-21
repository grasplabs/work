// Section: a part of a page, its header and what follows it, with the same room between each, as
// Palermo's Section.
//
//   <Section>
//     <SectionHeader title="Usage" />
//     <UsageTable />
//   </Section>
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";
import type { SectionHeaderLayoutStyle } from "./section-header";

/** Every prop a Section takes. */
export interface SectionProps {
  /** A SectionHeader, then the section's parts. */
  children: ReactNode;
  /** What the section is, when its header does not name it: a screen reader lists it as a region. */
  "aria-labelledby"?: string;
  /** @deprecated Use `layout`. */
  style?: SectionHeaderLayoutStyle;
  /** Layout only: margins and alignment. */
  layout?: SectionHeaderLayoutStyle;
}

const styles = stylex.create({
  section: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.sectionGap,
    minWidth: 0,
  },
});

export const Section = ({
  children,
  "aria-labelledby": labelledBy,
  style: styleProp,
  layout,
}: SectionProps) => (
  <section
    aria-labelledby={labelledBy}
    data-slot="section"
    {...stylex.props(styles.section, layout ?? styleProp)}
  >
    {children}
  </section>
);
