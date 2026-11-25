// ButtonGroup: buttons that belong together on one surface, in StyleX, drawn as ToggleGroup is:
// one quiet surface with the system's bevel, and ghost Buttons of one size inside it. A plain
// `role="group"`, named by `aria-label`: UI SDK has no primitive for it, and it is not a toolbar, so
// Tab reaches every button.
//
//   <ButtonGroup aria-label="Text alignment">
//     <Button variant="ghost" size="icon" aria-label="Align left"><Icon icon={TextAlignStartIcon} /></Button>
//     <Button variant="ghost" size="icon" aria-label="Align centre"><Icon icon={TextAlignCenterIcon} /></Button>
//   </ButtonGroup>
//   <ButtonGroup aria-label="Merge">
//     <Button variant="ghost">Merge</Button>
//     <ButtonGroupSeparator />
//     <Button variant="ghost" size="icon" aria-label="More ways to merge"><Icon icon={ChevronDownIcon} /></Button>
//   </ButtonGroup>
//
// The buttons are plain Buttons: their corners follow the group's (Button's inGroup), and the
// group's corner follows their size. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, createElement, use } from "react";
import type { ReactNode } from "react";

import {
  colors,
  duration,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { slotProps } from "../lib/utils";
import type { LayoutStyle, Orientation } from "../lib/utils";
import { ringInsetMarker } from "../lib/vars.stylex";
import { Separator } from "./separator";

/** Every prop a ButtonGroup takes. */
export interface ButtonGroupProps {
  /** The Buttons, `ghost` and of one size, with a ButtonGroupSeparator where a pair needs one. */
  children: ReactNode;
  /** What the buttons are for, said to a screen reader and an agent ("Text alignment"). */
  "aria-label"?: string;
  /**
   * `horizontal` in a row; `vertical` stacks them, as wide as the widest.
   * @default "horizontal"
   */
  orientation?: Orientation;
  /** Layout only: margins and alignment. The look belongs to the group. */
  style?: LayoutStyle;
}

/** Every prop a ButtonGroupSeparator takes: it follows its group's direction. */
export interface ButtonGroupSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ButtonGroupText takes. */
export interface ButtonGroupTextProps {
  /** Words that stand in the group beside its buttons ("Page 2 of 5"); with `asChild`, the one element that holds them, such as a Label. */
  children: ReactNode;
  /**
   * Draws the one element given as the child in its place, with the text's look.
   * @default false
   */
  asChild?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

// The group's direction, read by its separator.
const GroupContext = createContext<Orientation>("horizontal");

// A button inside the group, by its size: the group's corner is the one corner, capped at half the
// buttons' height, as each Button's is.
const sized = (sizes: string) =>
  `:has(> :is(${sizes
    .split(" ")
    .map((each) => `[data-size=${each}]`)
    .join(", ")}))`;

// A button beside the line that shows a fill, as a ghost Button does: pressed or held on, and under
// a fine pointer.
const held =
  ":is(:active:not(:disabled, [aria-disabled=true]), [aria-pressed=true])";
const hovered = ":hover:not(:disabled, [aria-disabled=true])";

const styles = stylex.create({
  group: {
    display: "inline-flex",
    boxSizing: "border-box",
    maxWidth: "100%",
    padding: 0,
    // The outline button's surface and bevel, once, round all the buttons: its lift here, and its
    // edge drawn over the buttons (::after), so a chosen, open or pressed button's fill never covers
    // the group's edge. The buttons' corners follow the group's (Button, inGroup).
    position: "relative",
    backgroundColor: colors.control,
    boxShadow: shadow.inputShadow,
    borderRadius: {
      default: `min(${radius.xl}, calc(${size.controlDefault} / 2))`,
      [sized("xs icon-xs")]: `min(${radius.xl}, calc(${size.controlXs} / 2))`,
      [sized("sm icon-sm")]: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
      [sized("lg icon-lg")]: `min(${radius.xl}, calc(${size.controlLg} / 2))`,
    },
    cornerShape: radius.shape,
    "::after": {
      content: '""',
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
      boxShadow: `inset 0 0 0 1px ${colors.borderStrongColor}`,
      pointerEvents: "none",
    },
    // In forced colours the shadow is dropped, so an outline draws the surface there.
    outline: { default: "none", [media.forcedColors]: "1px solid CanvasText" },
    outlineOffset: -1,
  },
  horizontal: {
    flexDirection: "row",
    alignItems: "stretch",
    "--tap-room-inline": "0px",
  },
  // Edge to edge: each button's touch target stops at its own edge towards the next (tapTarget),
  // which a row gives by default and a column says.
  vertical: {
    flexDirection: "column",
    alignItems: "stretch",
    "--tap-room-inline": size.tapTarget,
    "--tap-room-block": "0px",
  },
  // The line's box: a child of the group, so it knows its neighbours. While either shows a fill the
  // line goes: the fill's own edge divides the two.
  line: {
    display: "flex",
    flexShrink: 0,
    alignSelf: "stretch",
    opacity: {
      default: 1,
      [`:is(${held} + *)`]: 0,
      [`:has(+ ${held})`]: 0,
      [`:is(${hovered} + *)`]: { default: null, [media.hover]: 0 },
      [`:has(+ ${hovered})`]: { default: null, [media.hover]: 0 },
    },
    transitionProperty: "opacity",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  lineHorizontal: { flexDirection: "row", marginBlock: space[2] },
  lineVertical: { flexDirection: "column", marginInline: space[2] },
  // Words in the group: as tall as its buttons, quiet, never pressed.
  text: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    boxSizing: "border-box",
    paddingInline: space[3],
    color: colors.mutedForeground,
    fontFamily: "inherit",
    fontSize: "inherit",
    whiteSpace: "nowrap",
  },
});

/** Buttons that belong together, on one quiet surface. */
export const ButtonGroup = ({
  children,
  "aria-label": ariaLabel,
  orientation = "horizontal",
  style,
}: ButtonGroupProps) => (
  <GroupContext value={orientation}>
    <div
      // A <fieldset> brings its own border, padding and min-width
      role="group"
      aria-label={ariaLabel}
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- screen readers read the direction of a group of buttons
      aria-orientation={orientation === "vertical" ? "vertical" : undefined}
      data-slot="button-group"
      {...stylex.props(
        styles.group,
        styles[orientation],
        ringInsetMarker,
        style
      )}
    >
      {children}
    </div>
  </GroupContext>
);

/** A hairline between two buttons of a group. Only a line: the buttons' names divide them. */
export const ButtonGroupSeparator = ({ style }: ButtonGroupSeparatorProps) => {
  const orientation = use(GroupContext);
  return (
    <span
      aria-hidden="true"
      data-slot="button-group-separator"
      {...stylex.props(
        styles.line,
        orientation === "vertical"
          ? styles.lineVertical
          : styles.lineHorizontal,
        style
      )}
    >
      <Separator
        decorative
        orientation={orientation === "horizontal" ? "vertical" : "horizontal"}
      />
    </span>
  );
};

/** Words in the group, beside its buttons. */
export const ButtonGroupText = ({
  children,
  asChild = false,
  style,
}: ButtonGroupTextProps) => {
  const slot = slotProps(asChild, children);
  if (slot.render === undefined) {
    return (
      <span data-slot="button-group-text" {...stylex.props(styles.text, style)}>
        {slot.children}
      </span>
    );
  }
  const { type, props } = slot.render;
  // The element given keeps its own props and takes the text's look over its own: an element by
  // its class, beside the one it has; a component (a Label) by its `style`, which it puts after its
  // own look, and before the layout it was given.
  if (typeof type === "string") {
    const own = stylex.props(styles.text, style);
    return createElement(type, {
      ...props,
      ...own,
      "data-slot": "button-group-text",
      className: [props.className, own.className].filter(Boolean).join(" "),
    });
  }
  const look = [styles.text, style, props.style];
  return createElement(type, {
    ...props,
    "data-slot": "button-group-text",
    style: look,
  });
};
