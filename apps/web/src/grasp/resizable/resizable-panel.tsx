// ResizablePanel: one panel of a Resizable. Its content scrolls when the panel is smaller than it.
"use client";

import * as stylex from "@stylexjs/stylex";
import { ResizablePanel as ResizablePanelPrimitive } from "@ui-sdk/react/resizable";
import type { ResizableSize } from "@ui-sdk/react/resizable";
import type { ReactNode } from "react";

/** Every prop a ResizablePanel takes. */
export interface ResizablePanelProps {
  /** What the panel holds. */
  children?: ReactNode;
  /** Its name for a saved layout and for the handle that moves it. Made up when left out. */
  id?: string;
  /** Its size at first: a percentage (`30`) or a length (`"240px"`). Panels without one share the rest. */
  defaultSize?: ResizableSize;
  /**
   * The smallest it gets while open.
   * @default 0
   */
  minSize?: ResizableSize;
  /**
   * The largest it gets.
   * @default 100
   */
  maxSize?: ResizableSize;
  /**
   * Can fold away past its smallest: by dragging on, with Enter on its handle, or a double click.
   * @default false
   */
  collapsible?: boolean;
  /**
   * The size it folds to. At 0, its content leaves the tab order and the screen reader.
   * @default 0
   */
  collapsedSize?: ResizableSize;
}

const styles = stylex.create({
  panel: {
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
  },
});

export const ResizablePanel = ({ children, ...rest }: ResizablePanelProps) => (
  <ResizablePanelPrimitive {...rest} {...stylex.props(styles.panel)}>
    {children}
  </ResizablePanelPrimitive>
);
