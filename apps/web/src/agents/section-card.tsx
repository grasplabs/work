import { Card } from "@grasp-os/ui/components/card";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Separator } from "@grasp-os/ui/components/separator";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { InfoTip } from "../frame/info-tip.tsx";

// One group of a settings page, as #2503's agents pages draw it (the old
// library's grouped, compact section card): its title on the page's
// ground, a small step over the card that holds its rows alone, the
// title's words where the rows' start; one region named by the title.
// Untitled, it is the card alone, named by `aria-label`. Damsko folds the
// old section card into Card and puts a group's title in a SectionHeader
// over it (`variant="group"`), which this composes.

const styles = stylex.create({
  // The title over the card, a small step apart, read as one group.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space[2],
    minWidth: 0,
  },
  // Its words start where the rows' do: 16px in, or a table's first
  // column's when what it holds runs edge to edge.
  head: { paddingInline: space[4] },
  headFlush: { paddingInline: space.tableCellInline },
  // The info mark beside the title, no taller than the title's line.
  info: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
  },
  // What it holds: 16px round it, or nothing when it runs edge to edge.
  body: {
    paddingInline: space[4],
    paddingBlock: space[4],
  },
  flush: { minWidth: 0 },
  // The foot, under a hairline, in muted words.
  foot: {
    paddingInline: space[4],
    paddingBlock: space[3],
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  footFlush: { paddingInline: space.tableCellInline },
  inner: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" },
  // Boxed: the title in a header inside the card, 20px round it, and what
  // it holds 20px in under it, as a part of a page.
  boxedHead: { padding: space[5] },
  boxedBody: { paddingInline: space[5], paddingBlockEnd: space[5] },
});

/** One group of rows on a card, its title over it. */
export const SectionCard = ({
  title,
  description,
  info,
  aside,
  actions,
  flush = false,
  footer,
  level = 2,
  boxed = false,
  children,
  "aria-label": label,
}: {
  /** The title in a header inside the card, at a section's size: a part of a page, not a group of settings. */
  boxed?: boolean;
  /** The group's name, over its card; or `aria-label` alone, with no title. */
  title?: string;
  /** A sentence under the title. */
  description?: ReactNode;
  /** More about it, behind an info mark beside its title. */
  info?: string;
  /** Beside the title, after its info mark: a figure, a badge. */
  aside?: ReactNode;
  /** What it does, at the end of the title's row: xs buttons. */
  actions?: ReactNode;
  /** What it holds runs edge to edge: rows, a table, a list. */
  flush?: boolean;
  footer?: ReactNode;
  level?: 2 | 3 | 4;
  children?: ReactNode;
  "aria-label"?: string;
}) => {
  const id = useId();
  // One box inside the card, so its parts stand with no gap of the card's own.
  const inside = (
    <div {...stylex.props(styles.inner)}>
      <div {...stylex.props(flush ? styles.flush : styles.body)}>
        {children}
      </div>
      {footer === undefined || footer === null ? null : (
        <div>
          <Separator decorative />
          <div {...stylex.props(styles.foot, flush && styles.footFlush)}>
            {footer}
          </div>
        </div>
      )}
    </div>
  );
  if (title === undefined) {
    // A part of the page named by `aria-label`: a landmark of its own.
    return (
      <Card
        asChild
        padding="none"
        {...(label === undefined ? {} : { "aria-label": label })}
      >
        <section>{inside}</section>
      </Card>
    );
  }
  if (boxed) {
    return (
      <Card aria-labelledby={id} asChild padding="none">
        <section>
          <div {...stylex.props(styles.inner)}>
            <div {...stylex.props(styles.boxedHead)}>
              <SectionHeader
                actions={actions}
                badge={aside}
                description={description}
                headingLevel={level}
                id={id}
                title={title}
              />
            </div>
            <div {...stylex.props(styles.boxedBody)}>{children}</div>
          </div>
        </section>
      </Card>
    );
  }
  const card = <Card padding="none">{inside}</Card>;
  return (
    <section aria-labelledby={id} {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.head, flush && styles.headFlush)}>
        <SectionHeader
          actions={actions}
          badge={
            info === undefined && aside === undefined ? undefined : (
              <>
                {info === undefined ? null : (
                  <span {...stylex.props(styles.info)}>
                    <InfoTip>{info}</InfoTip>
                  </span>
                )}
                {aside}
              </>
            )
          }
          description={description}
          headingLevel={level}
          id={id}
          title={title}
          variant="group"
        />
      </div>
      {card}
    </section>
  );
};
