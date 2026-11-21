// PanelView: an inspector panel's content (panel.tsx), one per view, or alone when the panel has
// none. Its sections stand {inspector-gap} apart, inset {inspector-pad} on one left edge, with
// room under the last so it never ends on the window's edge.
"use client";

import * as stylex from "@stylexjs/stylex";
import { TabsPanel as TabsPanelPrimitive } from "@ui-sdk/react/tabs";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { grasp } from "../tokens/tokens.stylex";
import { usePanel } from "./context";

/** Every prop a PanelView takes. */
export interface PanelViewProps {
  /** Its sections: PanelSection, then a Collapsible for the rarely changed, last. */
  children: ReactNode;
  /** The value of the view it shows, when the panel has views. */
  value?: string;
}

const styles = stylex.create({
  view: {
    display: "grid",
    alignContent: "start",
    rowGap: grasp.inspectorGap,
    flexShrink: 0,
    minWidth: 0,
    paddingBlockStart: grasp.inspectorPad,
    paddingBlockEnd: grasp.inspectorPadEnd,
    paddingInline: grasp.inspectorPad,
  },
});

/** The content of one view. */
export const PanelView = ({ children, value }: PanelViewProps) => {
  const { hasViews } = usePanel();
  if (hasViews && value !== undefined) {
    return (
      <TabsPanelPrimitive
        value={value}
        data-panel-view=""
        {...stylex.props(styles.view, focus.inside)}
      >
        {children}
      </TabsPanelPrimitive>
    );
  }
  return (
    <div
      data-slot="panel-view"
      data-panel-view=""
      {...stylex.props(styles.view)}
    >
      {children}
    </div>
  );
};
