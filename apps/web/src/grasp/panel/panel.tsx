// Panel: an inspector panel beside a page, after the right-hand panel of Profound's agent page,
// made Grasp's: on the high lift, the system's corner, one left edge for everything in it. It
// scrolls on its own; its header (PanelHeader) folds as it does: the bar stays and gains its
// hairline, and the views slide into the bar as icons. Its content is one PanelView per view, or
// a PanelView alone when it has none.
//
//   <Panel label="Agent" defaultView="settings">
//     <PanelHeader title="Weekly pipeline digest" views={[...]} actions={...} onClose={close} />
//     <PanelView value="settings">
//       <PanelSection label="Triggers" empty="Add trigger" />
//     </PanelView>
//   </Panel>
//
// Beside a page, put it in a Resizable or a grid column of {inspector-width}; on a phone, in a
// Sheet with `framed={false}`. Every value is a token (src/tokens). A caller may set layout only.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import { Tabs as TabsPrimitive } from "@ui-sdk/react/tabs";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { PanelContext } from "./context";

/** What a caller may style: where the panel sits and how tall it stands. Never its look. */
export type PanelLayoutStyle = LayoutStyle;

/** Every prop a Panel takes. */
export interface PanelProps {
  /** Its header, then its content: a PanelHeader, then a PanelView for each view. */
  children: ReactNode;
  /** What it is about, as a screen reader names the region ("Agent details"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The view shown at first, when it has views and holds its own. */
  defaultView?: string;
  /** The view shown now, when your code holds it. Pair it with `onViewChange`. */
  view?: string;
  /** Runs when a view is chosen, with its value. */
  onViewChange?: (view: string) => void;
  /**
   * Stand on its own: the raised ground, the high lift and the corner. Off inside a Sheet, which
   * draws its own.
   * @default true
   */
  framed?: boolean;
  /** @deprecated Use `layout`. */
  style?: PanelLayoutStyle;
  /** Layout only: width, height and where it sits. */
  layout?: PanelLayoutStyle;
}

const styles = stylex.create({
  panel: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
    overflow: "clip",
    fontFamily: grasp.fontSans,
    color: grasp.text,
    // Its own direction for what scrolls inside: a sticky bar and views, measured against it.
    containerType: "inline-size",
  },
  framed: {
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftHigh,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
  },
  scroller: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "auto",
  },
  tabs: { display: "contents" },
  // Folded views need room to reach the bar's line, however short the panel's content.
  scrollerFolded: { paddingBlockEnd: grasp.inspectorBar },
});

/** The inspector panel: a region that scrolls under its folding header. */
export const Panel = ({
  children,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  defaultView,
  view,
  onViewChange,
  framed = true,
  style: styleProp,
  layout,
}: PanelProps) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [folded, setFolded] = useState(false);
  const hasViews = defaultView !== undefined || view !== undefined;
  const state = {
    scrolled,
    folded,
    scroller,
    hasViews,
    setScrolled,
    setFolded,
  };
  const inner = (
    <div
      ref={scroller}
      data-slot="panel-scroller"
      {...stylex.props(
        styles.scroller,
        folded && styles.scrollerFolded,
        scroll.bar
      )}
    >
      {children}
    </div>
  );
  return (
    <PanelContext value={state}>
      <aside
        aria-label={label}
        data-slot="panel"
        {...stylex.props(
          styles.panel,
          framed && styles.framed,
          layout ?? styleProp
        )}
      >
        {hasViews ? (
          <TabsPrimitive
            defaultValue={defaultView}
            value={view}
            onValueChange={(next: string | null, _details: ChangeDetails) => {
              if (next !== null) {
                onViewChange?.(next);
              }
            }}
            {...stylex.props(styles.tabs)}
          >
            {inner}
          </TabsPrimitive>
        ) : (
          inner
        )}
      </aside>
    </PanelContext>
  );
};
