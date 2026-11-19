// Page skeleton, list with detail: an inbox's page before it arrives (a route's first paint), the
// list in the page and the chosen item beside it in App shell's `pagePanel`, built from the parts
// the page will show. Two parts: the list (PageSkeletonList's own: PageHeader's `loading`, then
// real RowList rows, each a mark's box and a quiet line where the name and the detail go), and the
// detail the host seats as `pagePanel` (a Panel whose PanelHeader waits in its own `loading`, its
// body the item's text as paragraphs of quiet lines). On a phone the shell keeps the panel as a
// closed sheet, so the list stands alone, as a loaded inbox does there.
//
//   <AppShell loading pagePanel={<PageSkeletonDetail aria-label="The request" />}>
//     <PageSkeletonListDetail rows={8} />
//   </AppShell>
import * as stylex from "@stylexjs/stylex";

import { Panel, PanelHeader, PanelView } from "../../panel";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";
import { PageSkeletonList } from "../page-skeleton-list/page-skeleton-list";

const styles = stylex.create({
  // The item's text at the panel's inset: paragraphs a step apart.
  body: {
    display: "grid",
    gap: grasp.space4,
    paddingInline: grasp.inspectorInset,
    paddingBlock: grasp.space4,
  },
  paragraph: { display: "grid" },
  // A paragraph's last line stops short, as a paragraph's does.
  last: { width: "60%" },
});

// Each paragraph's lines: a fixed run, so two loads draw the same shape.
const LINES = [3, 2, 4, 2];

export interface PageSkeletonListDetailProps {
  /** How many rows the list shows at first. @default 8 */
  rows?: number;
  /** How many lines the page's description takes: 0 for none. @default 1 */
  descriptionLines?: number;
  /** The rows lead with their kind's icon or a person's picture: each shows its box. @default true */
  icons?: boolean;
}

/** The list before it arrives: the page's header, then quiet rows in the rows' own boxes. */
export const PageSkeletonListDetail = ({
  rows = 8,
  descriptionLines = 1,
  icons = true,
}: PageSkeletonListDetailProps) => (
  <PageSkeletonList
    rows={rows}
    descriptionLines={descriptionLines}
    icons={icons}
  />
);

export interface PageSkeletonDetailProps {
  /** The detail's name for a screen reader, as the loaded one's. */
  "aria-label"?: string;
  /** How many paragraphs the item's text shows at first. @default 3 */
  paragraphs?: number;
}

/** The chosen item before it arrives: a Panel, its header waiting, its text as quiet lines. */
export const PageSkeletonDetail = ({
  "aria-label": label,
  paragraphs = 3,
}: PageSkeletonDetailProps) => (
  <Panel aria-label={label}>
    <PanelHeader title="" description="" loading />
    <PanelView>
      <div
        aria-hidden="true"
        data-slot="page-skeleton-detail-body"
        data-detail-body=""
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
    </PanelView>
  </Panel>
);
