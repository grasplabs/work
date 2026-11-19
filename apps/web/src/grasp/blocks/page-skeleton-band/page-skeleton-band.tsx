// Page skeleton, band: a note's or a record's page whose head is a band (PageHeader
// variant="band"), before the page arrives (a route's first paint), built from the parts the page
// will show. The band stands as it will (flush under the bar, its texture and its hairline), its
// title and description quiet lines, the host's actions in their place; under it, the note's text
// as paragraphs of quiet lines at the note's measure.
//
//   <AppShell loading crumbs={[]}>
//     <PageSkeletonBand paragraphs={3} actions={<Button size="sm" variant="ghost">Details</Button>} />
//   </AppShell>
//
// The text's lines are the body's shape, not its words: a note's paragraphs differ, so only the
// band and where the text starts keep their boxes to a pixel.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { PageHeader } from "../../page-header";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // In flow, as the loaded page stands in the page's room: the band's room under it and the text's
  // own top margin meet as they do there (a grid would add them).
  page: { display: "block", minWidth: 0 },
  // The note's text: paragraphs a step apart at the note's measure, a section's room under the band.
  body: {
    display: "grid",
    gap: grasp.space4,
    maxWidth: "42rem",
    marginBlockStart: grasp.space6,
  },
  paragraph: { display: "grid" },
  // A paragraph's last line stops short, as a paragraph's does.
  last: { width: "60%" },
});

// Each paragraph's lines: a fixed run, so two loads draw the same shape.
const LINES = [3, 2, 3, 2];

export interface PageSkeletonBandProps {
  /** How many paragraphs the note's text shows at first. @default 3 */
  paragraphs?: number;
  /** How many lines the band's description takes: 0 for none. @default 1 */
  descriptionLines?: number;
  /** The band's actions, as the loaded page has them (they need no data): drawn in their place. */
  actions?: ReactNode;
}

/** A band page before it arrives: the band in its own `loading`, then the text's quiet lines. */
export const PageSkeletonBand = ({
  paragraphs = 3,
  descriptionLines = 1,
  actions,
}: PageSkeletonBandProps) => (
  <div data-slot="page-skeleton-band" {...stylex.props(styles.page)}>
    <PageHeader
      variant="band"
      title=""
      description={descriptionLines > 0 ? "" : undefined}
      loadingLines={descriptionLines}
      actions={actions}
      loading
    />
    <div
      aria-hidden="true"
      data-slot="page-skeleton-band-body"
      {...stylex.props(styles.body)}
    >
      {Array.from({ length: paragraphs }, (_, index) => {
        const lines = LINES[index % LINES.length] ?? 2;
        return (
          <div key={index} {...stylex.props(styles.paragraph)}>
            {Array.from({ length: lines }, (__, line) => (
              <Skeleton
                key={line}
                layout={line === lines - 1 ? styles.last : undefined}
              />
            ))}
          </div>
        );
      })}
    </div>
  </div>
);
