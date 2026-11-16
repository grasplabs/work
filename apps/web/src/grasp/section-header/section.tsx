// Section: a part of a page, its header and what follows it, with the same room between each, as
// Palermo's Section.
//
//   <Section>
//     <SectionHeader title="Usage" />
//     <UsageTable />
//   </Section>
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
  /** Layout only: margins and alignment. */
  style?: SectionHeaderLayoutStyle;
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
  style,
}: SectionProps) => (
  <section
    aria-labelledby={labelledBy}
    data-slot="section"
    {...stylex.props(styles.section, style)}
  >
    {children}
  </section>
);
