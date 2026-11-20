// PageHeaderToolbar: the row under a page's header that holds what changes the list below, as the
// Grasp product lays out its outputs and blueprints; give it as the PageHeader's `toolbar`, under the
// title and the tabs. The way to browse (chips for the kinds of thing) stands at the start; what
// narrows it (a scope, a search) and the page's own actions at the end. When it is narrow the two
// stack, the start above the end, and the chips scroll sideways rather than wrap. It was Toolbar
// band, a component of its own (toolbar-band, now a wrapper over this).
//
//   <PageHeader title="Outputs" toolbar={<PageHeaderToolbar aria-label="Outputs" start={chips} end={search} />} />
//
// It narrows by its own width, not the window's, so it stacks in a side panel too. Leave it out when
// there is nothing to browse or narrow yet. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where it sits, how wide it is, and its padding at the sides. */
export type PageHeaderToolbarLayoutStyle = LayoutStyle;

/** Every prop a PageHeaderToolbar takes. */
export interface PageHeaderToolbarProps {
  /** The way to browse: chips for the kinds of thing, at the start. They scroll sideways when they do not fit. */
  start?: ReactNode;
  /** What narrows the list, and the page's actions: a scope, a search, a button, at the end. */
  end?: ReactNode;
  /** Its name for a screen reader, when the page has more than one band of controls: "Outputs". */
  "aria-label"?: string;
  /** Layout only: where it sits, and padding at the sides to line up with the page's header. */
  layout?: PageHeaderToolbarLayoutStyle;
}

// The width under which the start and end stack: the phone breakpoint, measured on the band itself.
const NARROW = "@container (width < 40rem)";

const styles = stylex.create({
  // The container the band measures; the band itself is laid out inside it.
  frame: {
    containerType: "inline-size",
    minWidth: 0,
  },
  band: {
    display: "flex",
    flexDirection: { default: "row", [NARROW]: "column" },
    alignItems: { default: "center", [NARROW]: "stretch" },
    justifyContent: "space-between",
    gap: grasp.space3,
    minWidth: 0,
    paddingBlockEnd: grasp.space3,
    fontFamily: grasp.fontSans,
  },
  // The chips: one line that scrolls, with room for their focus rings at the ends. A box that
  // scrolls clips what reaches past it, so on a touch screen it also makes room above and below
  // for each chip's 44px touch area, and takes that room back from the band so nothing moves.
  start: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    overflowX: "auto",
    scrollbarWidth: "none",
    marginInline: `calc(-1 * ${grasp.space1})`,
    paddingInline: grasp.space1,
    paddingBlock: {
      default: grasp.space1,
      [media.coarse]: `calc((${grasp.tap} - ${grasp.toggleHeightSm}) / 2)`,
    },
    marginBlock: {
      default: 0,
      [media.coarse]: `calc(${grasp.space1} - (${grasp.tap} - ${grasp.toggleHeightSm}) / 2)`,
    },
  },
  // The narrowing controls: the room the start leaves, beside it, and the row when stacked. Their
  // width is the band's, not their content's, so a field that gains its clear button as you type
  // moves nothing: a growing field (a search) takes the room, the rest keep their own width at the
  // end. Where even a row to themselves is too narrow for them whole, they take a line each, rather
  // than squeeze a label onto two lines or cut a field's hint. Beside the start its basis is 0, not
  // its content: a content basis grows with the clear button, and just above the stacking width the
  // chips would give way to it as you type. Its least width is its fields' own minimum, which no
  // query changes.
  end: {
    display: "flex",
    flexGrow: 1,
    flexBasis: { default: 0, [NARROW]: "auto" },
    justifyContent: "flex-end",
    flexWrap: { default: "nowrap", [NARROW]: "wrap" },
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    flexShrink: { default: 0, [NARROW]: 1 },
  },
});

/** Whether a slot is given: the same test as plain truthiness, written out. */
const shows = (node: ReactNode): boolean =>
  node !== undefined &&
  node !== null &&
  node !== false &&
  node !== "" &&
  node !== 0;

/** What changes the list under a page's header: the way to browse at the start, what narrows it at the end. */
export const PageHeaderToolbar = ({
  start,
  end,
  "aria-label": label,
  layout,
}: PageHeaderToolbarProps) => (
  <div {...stylex.props(styles.frame, layout)}>
    <div
      data-slot="page-header-toolbar"
      role={label !== undefined && label !== "" ? "group" : undefined}
      aria-label={label}
      {...stylex.props(styles.band)}
    >
      {shows(start) ? (
        <div {...stylex.props(styles.start)}>{start}</div>
      ) : (
        <span />
      )}
      {shows(end) ? <div {...stylex.props(styles.end)}>{end}</div> : null}
    </div>
  </div>
);
