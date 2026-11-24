import { Card } from "@grasp-os/ui/components/card";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Separator } from "@grasp-os/ui/components/separator";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { InfoTip } from "../frame/info-tip.tsx";

// One part of the Integrations pages on a card, as #2503's library
// SectionCard drew it, composed from Damsko's Card, SectionHeader and
// Separator (Damsko folds the section card into Card and leaves its
// header-with-a-count to the product):
//
//   boxed     the title in a header inside the card, its count and actions
//             on its row; `flush`, what it holds runs edge to edge under a
//             hairline (a list), the title on the rows' start; else in the
//             card's room. Without a title, named by `aria-label` alone.
//   grouped   the title on the page's ground just over the card, which
//             holds the rows alone (a group of a settings page).
//
// Always the dense form: the head's title and sentence at text-sm, 12px
// above and below them and 16px at the sides.

const styles = stylex.create({
  card: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" },
  head: {
    paddingBlock: space["3"],
    paddingInline: space["4"],
    containerType: "inline-size",
    containerName: "section-card-head",
  },
  // Flush, the title lines up with the words in a list's first column.
  edgeFlush: { paddingInline: space.tableCellInline },
  // The info mark beside the title, in a box no taller than the title's line.
  info: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
  },
  body: {
    paddingInline: space["4"],
    paddingBlockEnd: space["4"],
  },
  // With no header, the room over what it holds is the room at its sides.
  bodyTop: { paddingBlockStart: space["4"] },
  flush: { minWidth: 0 },
  // Grouped: the title over the card, on the page's ground, a small step over it.
  grouped: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space["2"],
    minWidth: 0,
  },
  // Its words where the rows' start; an xs button on its line rises to it (SectionHeader's group).
  groupedHead: {
    paddingInline: space.tableCellInline,
    containerType: "inline-size",
    containerName: "section-card-head",
  },
});

/** Every prop a SectionCard takes. */
export interface SectionCardProps {
  /** The part's name ("Access"); left out, `aria-label` names the card and it has no header. */
  title?: string;
  "aria-label"?: string;
  /** One sentence under the title. */
  description?: ReactNode;
  /** Beside the title: a count. */
  aside?: ReactNode;
  /** More about it behind an info mark beside its title. */
  info?: string;
  /** The info mark's name for a screen reader. */
  infoLabel?: string;
  /** The title's heading level, so the page's outline stays in order. @default 2 */
  headingLevel?: 2 | 3 | 4;
  /** At the end of the header's row: the part's own buttons. */
  actions?: ReactNode;
  /** What it holds runs edge to edge under a hairline. @default false */
  flush?: boolean;
  /** The title over the card rather than in it. @default "boxed" */
  variant?: "boxed" | "grouped";
  children: ReactNode;
}

/** The title's neighbours: its info mark, then its count. */
const Beside = ({
  info,
  infoLabel,
  aside,
}: {
  info: string | undefined;
  infoLabel: string | undefined;
  aside: ReactNode;
}): ReactNode =>
  info === undefined ? (
    aside
  ) : (
    <>
      <span {...stylex.props(styles.info)}>
        <InfoTip {...(infoLabel === undefined ? {} : { label: infoLabel })}>
          {info}
        </InfoTip>
      </span>
      {aside}
    </>
  );

/** One part of a page on a card: its title (in its header, or over it), and what it holds. */
export const SectionCard = ({
  title,
  "aria-label": label,
  description,
  aside,
  info,
  infoLabel,
  headingLevel = 2,
  actions,
  flush = false,
  variant = "boxed",
  children,
}: SectionCardProps) => {
  const id = useId();
  const badge =
    info === undefined && aside === undefined ? undefined : (
      <Beside aside={aside} info={info} infoLabel={infoLabel} />
    );
  if (variant === "grouped" && title !== undefined) {
    return (
      <section
        aria-label={label}
        aria-labelledby={label === undefined ? id : undefined}
        data-slot="section-card"
        {...stylex.props(styles.grouped)}
      >
        <div {...stylex.props(styles.groupedHead)}>
          <SectionHeader
            actions={actions}
            badge={badge}
            description={description}
            headingLevel={headingLevel}
            id={id}
            title={title}
            variant="group"
          />
        </div>
        <Card padding="none">
          <div {...stylex.props(styles.card)}>
            <div
              {...stylex.props(
                flush ? styles.flush : [styles.body, styles.bodyTop]
              )}
            >
              {children}
            </div>
          </div>
        </Card>
      </section>
    );
  }
  const titled = title !== undefined;
  // Named by `aria-label` where given, else by its title.
  const named = label === undefined && titled ? { "aria-labelledby": id } : {};
  return (
    <Card
      asChild
      padding="none"
      {...(label === undefined ? named : { "aria-label": label })}
    >
      <section>
        <div {...stylex.props(styles.card)}>
          {titled ? (
            <div {...stylex.props(styles.head, flush && styles.edgeFlush)}>
              <SectionHeader
                actions={actions}
                badge={badge}
                description={description}
                headingLevel={headingLevel}
                id={id}
                size="sm"
                title={title}
              />
            </div>
          ) : null}
          {titled && flush ? <Separator /> : null}
          <div
            {...stylex.props(
              flush ? styles.flush : [styles.body, !titled && styles.bodyTop]
            )}
          >
            {children}
          </div>
        </div>
      </section>
    </Card>
  );
};
