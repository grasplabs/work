// Resizable: panels side by side or stacked, with a handle between each two that drags, from
// shadcn's (registry/bases/base/ui/resizable.tsx, on react-resizable-panels), converted from
// Tailwind to StyleX and rebuilt on UI SDK's Resizable: each handle is a focusable separator the
// arrow keys move, Enter collapses, and an agent can read. Palermo has none: the handle is a
// hairline, as a separator, that darkens under a pointer or while dragged.
//
//   <Resizable aria-label="Editor">
//     <ResizablePanel defaultSize={30} minSize={20}>…</ResizablePanel>
//     <ResizableHandle aria-label="Resize the file list" />
//     <ResizablePanel>…</ResizablePanel>
//   </Resizable>
//
// It draws no frame: the box it sits in does. Every value is a token (src/tokens). A caller sets
// its size and layout (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { Resizable as ResizablePrimitive } from "@ui-sdk/react/resizable";
import type { ComponentProps, ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";

/** What a caller may style: its size and where it sits. */
export type ResizableLayoutStyle = LayoutStyle;

type ResizablePrimitiveProps = ComponentProps<typeof ResizablePrimitive>;

/** Every prop a Resizable takes. */
interface ResizableOwnProps {
  /** The panels, with a ResizableHandle between each two. */
  children: ReactNode;
  /**
   * `horizontal` for panels side by side, `vertical` for panels stacked.
   * @default "horizontal"
   */
  orientation?: "horizontal" | "vertical";
  /** Runs on every step of a drag or a key, with each panel's size in percent. */
  onLayoutChange?: ResizablePrimitiveProps["onLayoutChange"];
  /** Runs once a drag or a key press ends, with each panel's size in percent. */
  onLayoutCommit?: ResizablePrimitiveProps["onLayoutCommit"];
  /** Keeps the layout for the next visit under this name, in the browser's storage. */
  autoSaveId?: string;
  /**
   * Every handle still: no drag, no keys.
   * @default false
   */
  disabled?: boolean;
  /** Its size and where it sits. */
  style?: ResizableLayoutStyle;
}

/** Every prop a Resizable takes: the ones above, and the rest of UI SDK's Resizable. */
export type ResizableProps = ResizableOwnProps &
  Omit<
    ResizablePrimitiveProps,
    keyof ResizableOwnProps | "className" | "render"
  >;

const styles = stylex.create({
  group: {
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    borderRadius: "inherit",
  },
});

export const Resizable = ({ children, style, ...rest }: ResizableProps) => (
  <ResizablePrimitive {...rest} {...stylex.props(styles.group, style)}>
    {children}
  </ResizablePrimitive>
);
