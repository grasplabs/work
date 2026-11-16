// ResizableHandle: the hairline between two panels of a Resizable. It drags; the arrow keys move
// it a step (with Shift, ten); Home and End take it to its ends; Enter folds a collapsible panel.
"use client";

import * as stylex from "@stylexjs/stylex";
import { ResizableHandle as ResizableHandlePrimitive } from "@ui-sdk/react/resizable";

import { focus } from "../focus/focus";
import { focusMarker } from "../focus/focus.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/** Every prop a ResizableHandle takes. */
export interface ResizableHandleProps {
  /** What it resizes, as a screen reader and an agent say it ("Resize the file list"). */
  "aria-label"?: string;
  /**
   * A grip on the line, for a handle people may not find by its line alone.
   * @default false
   */
  grip?: boolean;
  /**
   * Still: no drag, no keys, out of the tab order.
   * @default false
   */
  disabled?: boolean;
}

// The shared ring's line (src/focus), drawn here on a part inside the handle.
const ring = `${grasp.ringWidth} solid ${grasp.ring}`;
const forcedRing = `calc(2 * ${grasp.ringWidth}) solid Highlight`;

const styles = stylex.create({
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
      default: grasp.resizableLine,
      [stylex.when.ancestor(
        ":is([data-hovering], [data-dragging], :focus-visible)",
        focusMarker
      )]: grasp.resizableLineActive,
      [media.forced]: "CanvasText",
    },
    transitionProperty: "background-color",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  // A horizontal group's handle runs down between the panels; a vertical group's runs across.
  across: {
    width: grasp.hairline,
    cursor: "col-resize",
  },
  down: {
    height: grasp.hairline,
    cursor: "row-resize",
  },
  still: {
    cursor: "default",
  },
  // A finger needs 44px: an invisible strip either side of the line, on touch.
  target: {
    position: "absolute",
    inset: 0,
  },
  targetAcross: {
    insetInline: {
      default: 0,
      [media.coarse]: `calc((${grasp.hairline} - ${grasp.tap}) / 2)`,
    },
  },
  targetDown: {
    insetBlock: {
      default: 0,
      [media.coarse]: `calc((${grasp.hairline} - ${grasp.tap}) / 2)`,
    },
  },
  // The keyboard's focus: a ring round the line, standing off it by ring-offset-mark and stopping
  // a step short of each end, so it closes inside the group. On the 1px line itself it was two
  // hairlines, its ends cut by the group's edge (B-resizable-01). The handle draws none of its own.
  ring: {
    position: "absolute",
    zIndex: 1,
    borderRadius: grasp.cornerPill,
    pointerEvents: "none",
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", focusMarker)]: {
        default: ring,
        [media.forced]: forcedRing,
      },
    },
    outlineOffset: 0,
  },
  ringAcross: {
    insetBlock: grasp.space2,
    insetInline: `calc(-1 * ${grasp.ringOffsetMark})`,
  },
  ringDown: {
    insetInline: grasp.space2,
    insetBlock: `calc(-1 * ${grasp.ringOffsetMark})`,
  },
  grip: {
    position: "relative",
    flexShrink: 0,
    borderRadius: grasp.cornerPill,
    // The line's darker colour, so it reads on any panel.
    backgroundColor: {
      default: grasp.resizableLineActive,
      [media.forced]: "CanvasText",
    },
    // With a grip the ring goes round the grip, a mark with a fill of its own: off its edge by
    // ring-offset-mark, so it follows the pill and centres on it (B-resizable-02).
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", focusMarker)]: {
        default: ring,
        [media.forced]: forcedRing,
      },
    },
    outlineOffset: grasp.ringOffsetMark,
  },
  gripAcross: {
    width: grasp.resizableGripWidth,
    height: grasp.resizableGripLength,
  },
  gripDown: {
    width: grasp.resizableGripLength,
    height: grasp.resizableGripWidth,
  },
});

interface HandleState {
  orientation: "horizontal" | "vertical";
  disabled: boolean;
}

export const ResizableHandle = ({
  grip = false,
  ...rest
}: ResizableHandleProps) => (
  <ResizableHandlePrimitive
    {...rest}
    // The separator runs across the group: a horizontal group's is upright.
    className={(state: HandleState) =>
      stylex.props(
        styles.handle,
        state.orientation === "horizontal" ? styles.across : styles.down,
        state.disabled && styles.still,
        focusMarker,
        focus.carrier
      ).className
    }
  >
    {(state: HandleState) => (
      <>
        <span aria-hidden="true" {...stylex.props(styles.line)} />
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.target,
            state.orientation === "horizontal"
              ? styles.targetAcross
              : styles.targetDown
          )}
        />
        {!grip && (
          <span
            aria-hidden="true"
            data-slot="resizable-handle-ring"
            {...stylex.props(
              styles.ring,
              state.orientation === "horizontal"
                ? styles.ringAcross
                : styles.ringDown
            )}
          />
        )}
        {grip && (
          <span
            aria-hidden="true"
            {...stylex.props(
              styles.grip,
              state.orientation === "horizontal"
                ? styles.gripAcross
                : styles.gripDown
            )}
          />
        )}
      </>
    )}
  </ResizableHandlePrimitive>
);
