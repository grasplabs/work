import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { SectionCard } from "../grasp/section-card/index.ts";
import { Section, SectionHeader } from "../grasp/section-header/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A Settings card of rows with its title on the page's ground, directly
// above it, as Ruben has the Settings pattern: the library's Section and
// Section header over a Section card that carries no title of its own,
// named for a screen reader by the title's words. A stopgap until the
// library's grouped Section card lands, when this becomes one prop.
//
// - The header's start edge stands on the rows' start edge.
// - Section header has no info mark: a card that carries one (`info`)
//   keeps its title inside it, as before, until the grouped card lands.
// - The title is text-sm for now: Section header has no text-md size,
//   which Ruben chose (asked of the library).

const styles = stylex.create({
  // On the rows' start edge: they stand in by a table cell's room.
  edge: { marginInline: grasp.tableCellInline },
});

/** A titled Settings card: its title, count and actions above it on the page's ground; the card holds the rows. */
export const TitledCard = ({
  title,
  aside,
  actions,
  description,
  info,
  infoLabel,
  footer,
  flush = false,
  density = "compact",
  children,
}: {
  title: string;
  /** Beside the title: a count. */
  aside?: ReactNode;
  /** At the end of the title's row: the card's own buttons. */
  actions?: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  /** More behind an info mark: the card then keeps its title inside it. */
  info?: string;
  infoLabel?: string;
  footer?: ReactNode;
  flush?: boolean;
  density?: "comfortable" | "compact";
  children: ReactNode;
}) => {
  if (info !== undefined) {
    return (
      <SectionCard
        {...(actions === undefined ? {} : { actions })}
        {...(aside === undefined ? {} : { aside })}
        {...(description === undefined ? {} : { description })}
        {...(footer === undefined ? {} : { footer })}
        {...(infoLabel === undefined ? {} : { infoLabel })}
        density={density}
        flush={flush}
        info={info}
        title={title}
      >
        {children}
      </SectionCard>
    );
  }
  return (
    <Section>
      <SectionHeader
        {...(actions === undefined ? {} : { actions })}
        {...(aside === undefined ? {} : { aside })}
        {...(description === undefined ? {} : { description })}
        layout={styles.edge}
        size="sm"
        title={title}
      />
      <SectionCard
        {...(footer === undefined ? {} : { footer })}
        aria-label={title}
        density={density}
        flush={flush}
      >
        {children}
      </SectionCard>
    </Section>
  );
};
