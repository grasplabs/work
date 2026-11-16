// SectionCard: one part of a page on a card, its header at the top: a title, a sentence and the
// part's own buttons, then what it holds, and a foot when it has one. The product's own part, made
// of the finished ones: Card (src/components/card), SectionHeader (src/components/section-header)
// and Separator. Palermo has no section card; it takes Palermo's Card and Section Header as they are.
//
//   <SectionCard title="Usage" description="Seats and storage this month." actions={<Button>Export</Button>}>
//     …
//   </SectionCard>
//   <SectionCard title="Members" flush footer="12 people">
//     <Table …/>                                   a table or a list runs edge to edge
//   </SectionCard>
//
// Every value is a token (src/tokens). A caller may set layout and width only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { Card } from "../card";
import type { CardLayoutStyle } from "../card";
import { SectionHeader } from "../section-header";
import { Separator } from "../separator";
import { tableVars } from "../table/table.stylex";
import { grasp } from "../tokens/tokens.stylex";

/** Every prop a SectionCard takes. */
export interface SectionCardProps {
  /** The part's name, in sentence case ("Usage"). */
  title: ReactNode;
  /** One sentence under the title: what the part holds. */
  description?: ReactNode;
  /** Beside the title: a badge that says it is new, a count. */
  aside?: ReactNode;
  /** At the end of the header's row: the part's own buttons. */
  actions?: ReactNode;
  /** What the part holds. */
  children: ReactNode;
  /** A line at the foot, under a hairline: a total, when it was last updated, a link to all. */
  footer?: ReactNode;
  /**
   * What it holds runs edge to edge, under a hairline: a Table, a list of Items. Without it the
   * card's room surrounds it.
   * @default false
   */
  flush?: boolean;
  /**
   * The title's heading level, so the page's outline stays in order.
   * @default 2
   */
  level?: 2 | 3 | 4;
  /** Placeholders where the title and the sentence will be, while they load. @default false */
  loading?: boolean;
  /** Layout only: margins, alignment and width. The look belongs to the card. */
  style?: CardLayoutStyle;
}

const styles = stylex.create({
  card: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" },
  head: { padding: grasp.space5 },
  body: { paddingInline: grasp.space5, paddingBlockEnd: grasp.space5 },
  // A table flush under the hairline stands square (Table's corner set to 0): its box, frame and
  // ring meet the card's edges, so nothing clips the soft head's ground at its corners
  // (B-section-card-02: two white notches).
  flush: { minWidth: 0, [tableVars.corner]: 0 },
  // Flush, the title and the foot line up with the words in a table's first column.
  edgeFlush: { paddingInline: grasp.tableCellInline },
  foot: {
    paddingInline: grasp.space5,
    paddingBlock: grasp.space3,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

/** One part of a page on a card: its header, what it holds, and a foot. */
export const SectionCard = ({
  title,
  description,
  aside,
  actions,
  children,
  footer,
  flush = false,
  level = 2,
  loading = false,
  style,
}: SectionCardProps) => {
  const id = useId();
  return (
    <Card element="section" padding="none" style={style}>
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.head, flush && styles.edgeFlush)}>
          <SectionHeader
            id={id}
            title={title}
            description={description}
            aside={aside}
            actions={actions}
            level={level}
            loading={loading}
          />
        </div>
        {flush && <Separator decorative />}
        <div {...stylex.props(flush ? styles.flush : styles.body)}>
          {children}
        </div>
        {footer !== undefined && footer !== null && footer !== false && (
          <>
            <Separator decorative />
            <div {...stylex.props(styles.foot, flush && styles.edgeFlush)}>
              {footer}
            </div>
          </>
        )}
      </div>
    </Card>
  );
};
