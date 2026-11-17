// TooltipPanel: the tooltip itself (tooltip.tsx), UI SDK's TooltipContent in Grasp's look. It stands
// a little off its trigger, above it by default, flips to the other side when there is no room,
// and shifts to stay inside the window, clear of its edges by the gutter.
"use client";

import * as stylex from "@stylexjs/stylex";
import { TooltipContent as ContentPrimitive } from "@ui-sdk/react/tooltip";
import type { ComponentProps, ReactNode } from "react";

import { popup } from "../tokens/tokens.values";
import { useStill } from "./still-context";
import { tooltipStyles as styles } from "./styles";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a TooltipPanel takes: these, and the rest of UI SDK's TooltipContent. */
export interface TooltipContentProps extends Omit<
  ContentPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "sideOffset"
  | "collisionPadding"
  | "arrowPadding"
> {
  /** A few words that add to the trigger, and a `TooltipShortcut` if it has keys. Nothing to press. */
  children: ReactNode;
  /**
   * The side of the trigger it opens on.
   * @default "top"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with a trigger narrower than itself.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
}

/** The tooltip: a dark capsule beside its trigger, never wider than tooltip-width. */
export const TooltipContent = ({ children, ...rest }: TooltipContentProps) => {
  const still = useStill();
  if (still) {
    if (still.phase === "closed") {
      return null;
    }
    return (
      <div
        data-slot="tooltip-content"
        {...stylex.props(styles.panel, still.look.panel)}
      >
        <span {...stylex.props(styles.words)}>{children}</span>
      </div>
    );
  }
  // The gap and the gutter reach UI SDK as numbers, generated from tooltip-gap and popup-gutter
  // (src/tokens/tokens.values.ts), the same tokens the panel's width is drawn with (styles.ts).
  return (
    <ContentPrimitive
      {...rest}
      data-slot="tooltip-content"
      sideOffset={popup.tooltipGap}
      collisionPadding={popup.gutter}
      {...stylex.props(styles.panel, styles.placed, styles.motion)}
    >
      <span {...stylex.props(styles.words)}>{children}</span>
    </ContentPrimitive>
  );
};

/** @deprecated Use `TooltipContent`. */
export const TooltipPanel = TooltipContent;
/** @deprecated Use `TooltipContentProps`. */
export type TooltipPanelProps = TooltipContentProps;
