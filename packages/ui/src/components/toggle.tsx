// Toggle: a button that stays pressed,
// in StyleX, built on UI SDK's Toggle. 28px tall at its default
// `xs` size, its words muted until pressed; pressed lays a veil of ink deeper than hover's. Its
// icon is a child, as on Button; an icon alone makes it square and needs an `aria-label`, which it
// shows in a Tooltip of its own under a resting pointer and on keyboard focus.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Toggle aria-label="Bold"><Icon icon={TextBoldIcon} /></Toggle>
//   <Toggle defaultPressed>Show archived</Toggle>
//   <Toggle variant="outline">Show archived</Toggle>
"use client";

import * as stylex from "@stylexjs/stylex";
import { Toggle as TogglePrimitive } from "@ui-sdk/react/toggle";
import type { ToggleState } from "@ui-sdk/react/toggle";
import { isValidElement } from "react";
import type { ComponentProps, ReactNode } from "react";

import { Icon } from "../lib/icons";
import { focusRing } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { ControlTooltip } from "./tooltip";

/**
 * Button's ladder: `xs` 28 alone or in a toolbar; `sm` 32, `default` 36 and `lg` 44 level with a
 * field of that size in the same row.
 */
export type ToggleSize = "xs" | "sm" | "default" | "lg";

/**
 * `default` stands on the ground with nothing round it until pressed; `outline` draws a field's
 * hairline round it.
 */
export type ToggleVariant = "default" | "outline";

type TogglePrimitiveProps = ComponentProps<typeof TogglePrimitive>;

interface ToggleOwnProps {
  /** Its words, its icon (`<Icon icon={…} />`), or both. An icon alone needs an `aria-label`. */
  children?: ReactNode;
  /** Its name when it shows only an icon ("Bold"), shown in a tooltip on hover and keyboard focus. */
  "aria-label"?: string;
  /**
   * Its tooltip, under a resting pointer and on keyboard focus. Left out, one that is only an icon
   * shows its `aria-label`; `false` shows none; words or a node show those in its place. Inside a
   * Tooltip of your own it shows none.
   */
  tooltip?: ReactNode;
  /** Whether it is pressed now, for a toggle your code holds. */
  pressed?: boolean;
  /**
   * Whether it is pressed at first, when it holds its own state.
   * @default false
   */
  defaultPressed?: boolean;
  /** Runs when a press turns it on or off, with the new state. */
  onPressedChange?: TogglePrimitiveProps["onPressedChange"];
  /**
   * Button's ladder: `xs` 28 alone or in a toolbar; `sm` 32, `default` 36 and `lg` 44 level with a
   * field of that size in the same row.
   * @default "xs"
   */
  size?: ToggleSize;
  /**
   * `default` stands on the ground with nothing round it until pressed; `outline` draws a field's
   * hairline round it, for a toggle that must read as one at rest.
   * @default "default"
   */
  variant?: ToggleVariant;
  /**
   * Out of use: no press, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits: margins and alignment. The look belongs to the toggle. */
  style?: LayoutStyle;
}

/** Every prop a Toggle takes: the ones above, and the rest of UI SDK's Toggle. */
export type ToggleProps = ToggleOwnProps &
  Omit<
    TogglePrimitiveProps,
    keyof ToggleOwnProps | "className" | "render" | "value"
  >;

const HOVER = media.hover;
const FORCED = media.forcedColors;

const styles = stylex.create({
  toggle: {
    [iconVars.size]: sizes.toggleIcon,
    [iconVars.stroke]: sizes.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space[1],
    flexShrink: 0,
    boxSizing: "border-box",
    margin: 0,
    paddingBlock: 0,
    paddingInline: sizes.togglePadding,
    borderWidth: 0,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
    backgroundColor: "transparent",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color, background-color, box-shadow, transform",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
    transform: {
      default: "none",
      ":active": `scale(${sizes.buttonPressScale})`,
    },
  },
  xs: { height: sizes.toggleHeight, minWidth: sizes.toggleHeight },
  sm: { height: sizes.controlSm, minWidth: sizes.controlSm },
  default: { height: sizes.controlDefault, minWidth: sizes.controlDefault },
  lg: { height: sizes.controlLg, minWidth: sizes.controlLg },
  // A field's hairline round it, at rest and pressed; a real line in forced colours.
  outline: {
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    boxShadow: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
  },
  // An icon alone: square.
  square: { paddingInline: 0 },
  // Can be pressed: the words turn ink and a faint fill shows under a pointer.
  live: {
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
  },
  // Pressed: a veil of ink clearly deeper than hover's, the words ink; a pointer on it deepens it
  // one step more.
  pressed: {
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
    backgroundColor: {
      default: colors.toggleBgPressed,
      ":hover": { default: null, [HOVER]: colors.toggleBgPressedHover },
      [FORCED]: "Highlight",
    },
  },
  disabled: {
    opacity: sizes.opacityDisabled,
    cursor: "not-allowed",
    transform: "none",
  },
  // A finger needs 44px: an invisible area inside the toggle reaches past its edges on touch.
  target: {
    position: "absolute",
    insetInline: {
      default: 0,
      [media.pointerCoarse]: `min(0px, calc((100% - ${sizes.tapTarget}) / 2))`,
    },
    insetBlock: {
      default: 0,
      [media.pointerCoarse]: `calc((100% - ${sizes.tapTarget}) / 2)`,
    },
  },
});

/** A size's height, from the ladder. */
const sizeStyle = (size: ToggleSize) => {
  if (size === "sm") {
    return styles.sm;
  }
  if (size === "default") {
    return styles.default;
  }
  if (size === "lg") {
    return styles.lg;
  }
  return styles.xs;
};

/**
 * A toggle's look at rest, for an element that must look like one without being a Toggle (a
 * ToggleGroupItem): its shape, its words, its size's height and its variant's edge.
 */
export const toggleVariants = ({
  variant = "default",
  size = "xs",
}: {
  variant?: ToggleVariant;
  size?: ToggleSize;
} = {}): stylex.StyleXStyles => [
  styles.toggle,
  sizeStyle(size),
  variant === "outline" && styles.outline,
];

/** Whether a toggle is square: an Icon alone as its child, or no child. */
export const iconOnly = (children: ReactNode) =>
  children === undefined ||
  children === null ||
  (isValidElement(children) && children.type === Icon);

const Pressable = ({
  children,
  size = "xs",
  variant = "default",
  tooltip: _tooltip,
  style,
  ...rest
}: ToggleProps) => (
  <TogglePrimitive
    {...rest}
    data-slot="toggle"
    className={(state: ToggleState) =>
      className(
        toggleVariants({ variant, size }),
        iconOnly(children) && styles.square,
        !state.disabled && !state.pressed && styles.live,
        state.pressed && styles.pressed,
        state.disabled && styles.disabled,
        style,
        focusRing
      )
    }
  >
    <span aria-hidden="true" {...stylex.props(styles.target)} />
    {children}
  </TogglePrimitive>
);

export const Toggle = (props: ToggleProps) => (
  <ControlTooltip tooltip={props.tooltip} iconOnly={iconOnly(props.children)}>
    <Pressable {...props} />
  </ControlTooltip>
);
