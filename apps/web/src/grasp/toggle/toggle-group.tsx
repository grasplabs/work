// ToggleGroup: toggles on one soft track, from shadcn's (registry/bases/base/ui/toggle-group.tsx,
// on Base UI), converted from Tailwind to StyleX and rebuilt on UI SDK's ToggleGroup: one tab stop,
// the arrow keys between toggles. Made as Palermo's: the track soft, the pressed toggle raised.
//
//   <ToggleGroup aria-label="View" defaultValue={["list"]}>
//     <Toggle value="list">List</Toggle>
//     <Toggle value="board">Board</Toggle>
//   </ToggleGroup>
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { ToggleGroup as ToggleGroupPrimitive } from "@ui-sdk/react/toggle";
import type { ComponentProps, ReactNode } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import type { ToggleLayoutStyle } from "./toggle";
import { ToggleGroupContext } from "./toggle-context";
import type { ToggleSize } from "./toggle-context";

type ToggleGroupPrimitiveProps = ComponentProps<
  typeof ToggleGroupPrimitive<string>
>;

/** Every prop a ToggleGroup takes. */
interface ToggleGroupOwnProps {
  /** The toggles. */
  children: ReactNode;
  /** What the toggles set, as a screen reader and an agent say it ("Text style"). */
  "aria-label"?: string;
  /** The pressed toggles' values now, for a group your code holds. */
  value?: string[];
  /** The pressed toggles' values at first, when the group holds its own. */
  defaultValue?: string[];
  /** Runs when a press changes which toggles are pressed, with their values. */
  onValueChange?: ToggleGroupPrimitiveProps["onValueChange"];
  /**
   * Several may be pressed at once. Otherwise pressing one lifts the others.
   * @default false
   */
  multiple?: boolean;
  /**
   * `md` beside other controls, `sm` in a dense toolbar. Every toggle in it takes this size.
   * @default "md"
   */
  size?: ToggleSize;
  /**
   * Every toggle out of use, still reachable by the keyboard. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: margins and alignment. The look belongs to the group. */
  style?: ToggleLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: ToggleLayoutStyle;
}

/** Every prop a ToggleGroup takes: the ones above, and the rest of UI SDK's ToggleGroup. */
export type ToggleGroupProps = ToggleGroupOwnProps &
  Omit<
    ToggleGroupPrimitiveProps,
    keyof ToggleGroupOwnProps | "className" | "render"
  >;

const styles = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.toggleGap,
    boxSizing: "border-box",
    maxWidth: "100%",
    // The same room on every side, so the pressed toggle stands evenly inside the track.
    padding: grasp.toggleTrackInset,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    // Forced colours drop the fill: a line keeps the track.
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  vertical: {
    flexDirection: "column",
    alignItems: "stretch",
  },
});

export const ToggleGroup = ({
  children,
  size = "md",
  style: styleProp,
  layout,
  ...rest
}: ToggleGroupProps) => (
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
  <ToggleGroupContext.Provider value={{ grouped: true, size }}>
    <ToggleGroupPrimitive
      {...rest}
      {...stylex.props(
        styles.group,
        rest.orientation === "vertical" && styles.vertical,
        layout ?? styleProp
      )}
    >
      {children}
    </ToggleGroupPrimitive>
  </ToggleGroupContext.Provider>
);
