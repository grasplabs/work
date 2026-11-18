// ButtonGroup: buttons that belong together on one surface, from shadcn's (registry/bases/base/ui/
// button-group.tsx), converted from Tailwind to StyleX and drawn after Palermo's Toggle Group: one
// quiet surface with the system's bevel, and ghost buttons of the same height inside it. Grasp's
// own: our colours, our corner and Geist. A plain `role="group"`, named by `label`: UI SDK has no
// primitive for it, and it is not a toolbar, so Tab reaches every button.
//
//   <ButtonGroup label="Text alignment">
//     <ButtonGroupButton icon={AlignLeft} label="Align left" />
//     <ButtonGroupButton icon={AlignCentre} label="Align centre" />
//   </ButtonGroup>
//   <ButtonGroup label="Merge">
//     <ButtonGroupButton>Merge</ButtonGroupButton>
//     <ButtonGroupSeparator />
//     <ButtonGroupButton icon={ChevronDown} label="More ways to merge" />
//   </ButtonGroup>
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { ButtonSize } from "../button";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { GroupContext } from "./context";
import type { ButtonGroupOrientation } from "./context";

/** What a caller may style: where the group sits. Never its look. */
export type ButtonGroupLayoutStyle = LayoutStyle;

/** Every prop a ButtonGroup takes. */
export interface ButtonGroupProps {
  /** The buttons, ButtonGroupButton each, with a ButtonGroupSeparator where a pair needs one. */
  children: ReactNode;
  /** What the buttons are for, said to a screen reader and an agent ("Text alignment"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * The height of every button in it, Button's: `xs` 28px, `sm` 32px, `md` 36px, `lg` 44px.
   * @default "md"
   */
  size?: ButtonSize;
  /**
   * `horizontal` in a row; `vertical` stacks them, as wide as the widest.
   * @default "horizontal"
   */
  orientation?: ButtonGroupOrientation;
  /** @deprecated Use `layout`. */
  style?: ButtonGroupLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the group. */
  layout?: ButtonGroupLayoutStyle;
}

const styles = stylex.create({
  group: {
    display: "inline-flex",
    boxSizing: "border-box",
    maxWidth: "100%",
    padding: 0,
    // The quiet button's surface and bevel, once, round all the buttons: its lift here, and its
    // edge drawn over the buttons (::after), so a chosen, open or pressed button's fill never covers
    // the group's edge (A3-actions-01). The buttons' corners follow the group's (Button, inGroup).
    position: "relative",
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.fieldLift,
    cornerShape: grasp.cornerShape,
    "::after": {
      content: '""',
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
      boxShadow: `inset 0 0 0 1px ${grasp.edgeTone}`,
      pointerEvents: "none",
    },
    // In forced colours the shadow is dropped, so an outline draws the surface there.
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: -1,
  },
  horizontal: { flexDirection: "row", alignItems: "stretch" },
  vertical: { flexDirection: "column", alignItems: "stretch" },
  xs: { borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))` },
  sm: { borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))` },
  md: { borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))` },
  lg: { borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))` },
});

/** Buttons that belong together, on one quiet surface. */
export const ButtonGroup = ({
  children,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  size = "md",
  orientation = "horizontal",
  style: styleProp,
  layout,
}: ButtonGroupProps) => (
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
  <GroupContext.Provider value={{ size, orientation }}>
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> brings its own border, padding and min-width
      role="group"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- screen readers read the direction of a group of buttons
      aria-orientation={orientation === "vertical" ? "vertical" : undefined}
      data-slot="button-group"
      {...stylex.props(
        styles.group,
        styles[orientation],
        styles[size],
        layout ?? styleProp
      )}
    >
      {children}
    </div>
  </GroupContext.Provider>
);
