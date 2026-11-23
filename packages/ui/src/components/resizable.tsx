// Resizable: panels side by side or stacked, with a handle between each two that drags,
// in StyleX, built on UI SDK's Resizable.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <ResizablePanelGroup aria-label="Editor">
//     <ResizablePanel defaultSize={30} minSize={20}>…</ResizablePanel>
//     <ResizableHandle aria-label="Resize the file list" />
//     <ResizablePanel>…</ResizablePanel>
//   </ResizablePanelGroup>
//
// Each handle is a focusable separator (the WAI-ARIA window splitter) whose value is the size of the
// panel before it, in percent: the arrow keys along the group move it a step (with Shift, ten), Home
// and End take it as far as the panels allow, and Enter folds a collapsible panel beside it. The
// handle is a hairline, as a separator, that darkens under a pointer or while dragged. The group
// draws no frame: the box it sits in does. UI SDK names the panels' and the handles' data-slot;
// the group's is set here. Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Resizable as ResizablePrimitive,
  ResizableHandle as ResizableHandlePrimitive,
  ResizablePanel as ResizablePanelPrimitive,
} from "@ui-sdk/react/resizable";
import type { ResizableSize } from "@ui-sdk/react/resizable";
import type { ComponentProps, ReactNode } from "react";

import { focusCarrier, scrollbarHidden, tapTarget } from "../lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { focusMarker, motionVars } from "../lib/vars.stylex";

type ResizablePrimitiveProps = ComponentProps<typeof ResizablePrimitive>;

/** The props a ResizablePanelGroup names itself. */
interface ResizablePanelGroupOwnProps {
  /** The panels, with a ResizableHandle between each two. */
  children: ReactNode;
  /** What the panels are, as a screen reader and an agent say it ("Editor"). */
  "aria-label"?: string;
  /**
   * `horizontal` for panels side by side, `vertical` for panels stacked.
   * @default "horizontal"
   */
  orientation?: "horizontal" | "vertical";
  /** Each panel's size in percent, in panel order, for panels whose sizes you hold. */
  layout?: ResizablePrimitiveProps["layout"];
  /** Each panel's size in percent at first, when you do not hold them. */
  defaultLayout?: ResizablePrimitiveProps["defaultLayout"];
  /** Runs on every step of a drag or a key, with each panel's size in percent. */
  onLayoutChange?: ResizablePrimitiveProps["onLayoutChange"];
  /** Runs once a drag or a key press ends, with each panel's size in percent: for saving. */
  onLayoutChanged?: ResizablePrimitiveProps["onLayoutCommit"];
  /** Keeps the layout for the next visit under this name, in the browser's storage. */
  autoSaveId?: string;
  /**
   * Every handle still: no drag, no keys, out of the tab order.
   * @default false
   */
  disabled?: boolean;
  /** Its size and where it sits. */
  style?: LayoutStyle;
}

/** Every prop a ResizablePanelGroup takes: the ones above, and the rest of UI SDK's Resizable. */
export type ResizablePanelGroupProps = ResizablePanelGroupOwnProps &
  Omit<
    ResizablePrimitiveProps,
    | keyof ResizablePanelGroupOwnProps
    | "className"
    | "render"
    | "onLayoutCommit"
  >;

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
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a ResizableHandle takes. */
export interface ResizableHandleProps {
  /** What it resizes, as a screen reader and an agent say it ("Resize the file list"). */
  "aria-label"?: string;
  /**
   * A grip on the line, for a handle people may not find by its line alone.
   * @default false
   */
  withHandle?: boolean;
  /**
   * Still: no drag, no keys, out of the tab order.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

// The shared ring's line, drawn here on a part inside the handle.
const ring = `${size.ringWidth} solid ${colors.ring}`;
const forcedRing = `calc(2 * ${size.lineStrong}) solid Highlight`;
const FORCED = media.forcedColors;

const styles = stylex.create({
  group: {
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
  },
  // Its content scrolls, with no bar, when the panel is smaller than it.
  panel: {
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
  },
  handle: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  // The line itself, a part of its own: the handle has no fill, so the ring round the line stands
  // on the panels' ground, not on the line's colour. Darker under a pointer, while dragged, and
  // while the keyboard is on it.
  line: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundColor: {
      default: colors.resizableLine,
      [stylex.when.ancestor(
        ":is([data-hovering], [data-dragging], :focus-visible)",
        focusMarker
      )]: colors.resizableLineActive,
      [FORCED]: "CanvasText",
    },
    transitionProperty: "background-color",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  // A horizontal group's handle runs down between the panels; a vertical group's runs across.
  across: {
    width: size.hairline,
    cursor: "col-resize",
  },
  down: {
    height: size.hairline,
    cursor: "row-resize",
  },
  still: {
    cursor: "default",
  },
  // The keyboard's focus: a ring round the line, standing off it by ring-offset-mark and stopping
  // a step short of each end, so it closes inside the group. On the 1px line itself it was two
  // hairlines, its ends cut by the group's edge. The handle draws none of its own.
  ring: {
    position: "absolute",
    zIndex: 1,
    borderRadius: radius.full,
    pointerEvents: "none",
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", focusMarker)]: {
        default: ring,
        [FORCED]: forcedRing,
      },
    },
    outlineOffset: 0,
  },
  ringAcross: {
    insetBlock: space["2"],
    insetInline: `calc(-1 * ${size.ringOffsetMark})`,
  },
  ringDown: {
    insetInline: space["2"],
    insetBlock: `calc(-1 * ${size.ringOffsetMark})`,
  },
  grip: {
    position: "relative",
    flexShrink: 0,
    borderRadius: radius.full,
    // The line's darker colour, so it reads on any panel.
    backgroundColor: {
      default: colors.resizableLineActive,
      [FORCED]: "CanvasText",
    },
    // With a grip the ring goes round the grip, a mark with a fill of its own: off its edge by
    // ring-offset-mark, so it follows the pill and centres on it.
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", focusMarker)]: {
        default: ring,
        [FORCED]: forcedRing,
      },
    },
    outlineOffset: size.ringOffsetMark,
  },
  gripAcross: {
    width: size.resizableHandleWidth,
    height: size.resizableHandleLength,
  },
  gripDown: {
    width: size.resizableHandleLength,
    height: size.resizableHandleWidth,
  },
});

/** Panels side by side or stacked, with a ResizableHandle between each two. */
export const ResizablePanelGroup = ({
  children,
  onLayoutChanged,
  style,
  ...rest
}: ResizablePanelGroupProps) => (
  <ResizablePrimitive
    // The slot is set on the element drawn: UI SDK keeps a part's own data-slot over a prop.
    render={<div data-slot="resizable-panel-group" />}
    {...rest}
    onLayoutCommit={onLayoutChanged}
    {...stylex.props(styles.group, style)}
  >
    {children}
  </ResizablePrimitive>
);

/** One panel of a group. Its content scrolls when the panel is smaller than it. */
export const ResizablePanel = ({
  children,
  style,
  ...rest
}: ResizablePanelProps) => (
  <ResizablePanelPrimitive
    {...rest}
    {...stylex.props(styles.panel, scrollbarHidden, style)}
  >
    {children}
  </ResizablePanelPrimitive>
);

interface HandleState {
  orientation: "horizontal" | "vertical";
  disabled: boolean;
}

/** The hairline between two panels, a focusable separator that drags and takes the arrow keys. */
export const ResizableHandle = ({
  withHandle = false,
  style,
  ...rest
}: ResizableHandleProps) => (
  <ResizableHandlePrimitive
    {...rest}
    // The separator runs across the group: a horizontal group's is upright.
    className={(state: HandleState) =>
      className(
        styles.handle,
        state.orientation === "horizontal" ? styles.across : styles.down,
        state.disabled && styles.still,
        focusMarker,
        focusCarrier,
        style
      )
    }
  >
    {(state: HandleState) => (
      <>
        <span aria-hidden="true" {...stylex.props(styles.line)} />
        {/* A finger needs 44px: an unseen strip either side of the line, on touch. */}
        <span aria-hidden="true" {...stylex.props(tapTarget)} />
        {withHandle ? (
          <span
            aria-hidden="true"
            {...stylex.props(
              styles.grip,
              state.orientation === "horizontal"
                ? styles.gripAcross
                : styles.gripDown
            )}
          />
        ) : (
          <span
            aria-hidden="true"
            data-slot="resizable-handle-focus-ring"
            {...stylex.props(
              styles.ring,
              state.orientation === "horizontal"
                ? styles.ringAcross
                : styles.ringDown
            )}
          />
        )}
      </>
    )}
  </ResizableHandlePrimitive>
);
