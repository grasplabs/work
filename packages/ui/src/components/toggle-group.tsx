// ToggleGroup: toggles on one soft track, from shadcn's (registry/bases/base/ui/toggle-group.tsx,
// on Base UI), converted from Tailwind to StyleX and built on UI SDK's ToggleGroup: one tab stop,
// the arrow keys between toggles. The track soft, the pressed item raised out of it.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <ToggleGroup aria-label="View" defaultValue={["list"]}>
//     <ToggleGroupItem value="list">List</ToggleGroupItem>
//     <ToggleGroupItem value="board">Board</ToggleGroupItem>
//   </ToggleGroup>
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  ToggleGroup as ToggleGroupPrimitive,
  Toggle as TogglePrimitive,
} from "@ui-sdk/react/toggle";
import type { ToggleState } from "@ui-sdk/react/toggle";
import { createContext, useContext } from "react";
import type { ComponentProps, ReactNode } from "react";

import { focusRing, segmentedStyles } from "../lib/styles";
import {
  colors,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { ringInsetMarker } from "../lib/vars.stylex";
import { iconOnly, toggleVariants } from "./toggle";
import type { ToggleSize } from "./toggle";
import { ControlTooltip } from "./tooltip";

type ToggleGroupPrimitiveProps = ComponentProps<
  typeof ToggleGroupPrimitive<string>
>;

interface ToggleGroupOwnProps {
  /** Its ToggleGroupItems. */
  children: ReactNode;
  /** What the toggles set, as a screen reader and an agent say it ("Text style"). */
  "aria-label"?: string;
  /** The pressed items' values now, for a group your code holds. */
  value?: string[];
  /** The pressed items' values at first, when the group holds its own. */
  defaultValue?: string[];
  /** Runs when a press changes which items are pressed, with their values. */
  onValueChange?: ToggleGroupPrimitiveProps["onValueChange"];
  /**
   * Several may be pressed at once. Otherwise pressing one lifts the others.
   * @default false
   */
  multiple?: boolean;
  /**
   * Toggle's ladder: `xs` 28 alone or in a toolbar; `sm` 32, `default` 36 and `lg` 44, the track
   * level with a field of that size in the same row. Every item in it takes this size.
   * @default "xs"
   */
  size?: ToggleSize;
  /**
   * Every item out of use, still reachable by the keyboard. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * The track takes the whole width of the box it stands in, and its items share that width: each
   * grows from its words' width by the same amount, and where the width is short each gives some
   * up, its words ending in an ellipsis; nothing runs past the track. Across a panel or a settings
   * row. Side by side only: an upright group keeps its items' own widths.
   * @default false
   */
  fullWidth?: boolean;
  /** Where it sits: margins and alignment. The look belongs to the group. */
  style?: LayoutStyle;
}

/** Every prop a ToggleGroup takes: the ones above, and the rest of UI SDK's ToggleGroup. */
export type ToggleGroupProps = ToggleGroupOwnProps &
  Omit<
    ToggleGroupPrimitiveProps,
    keyof ToggleGroupOwnProps | "className" | "render"
  >;

type TogglePrimitiveProps = ComponentProps<typeof TogglePrimitive>;

interface ToggleGroupItemOwnProps {
  /** Its name in the group: the group's value lists the pressed items by it. */
  value: string;
  /** Its words, its icon (`<Icon icon={…} />`), or both. An icon alone needs an `aria-label`. */
  children?: ReactNode;
  /** Its name when it shows only an icon ("Bold"). */
  "aria-label"?: string;
  /**
   * Its tooltip, under a resting pointer and on keyboard focus. Left out, one that is only an icon
   * shows its `aria-label`; `false` shows none; words or a node show those in its place. Inside a
   * Tooltip of your own it shows none.
   */
  tooltip?: ReactNode;
  /**
   * Out of use: no press, half strength.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop a ToggleGroupItem takes: the ones above, and the rest of UI SDK's Toggle. */
export type ToggleGroupItemProps = ToggleGroupItemOwnProps &
  Omit<
    TogglePrimitiveProps,
    | keyof ToggleGroupItemOwnProps
    | "className"
    | "render"
    | "pressed"
    | "defaultPressed"
    | "onPressedChange"
  >;

const HOVER = media.hover;

const styles = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: sizes.toggleGap,
    boxSizing: "border-box",
    maxWidth: "100%",
  },
  vertical: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  // Across its box (fullWidth). Its items share the width, each growing from its own words' width,
  // so every word shows while they fit (equal parts would cut "Extra high" beside "Low"), and each
  // giving up room, down to an ellipsis, where they do not.
  fullWidth: { display: "flex", width: "100%", minWidth: 0 },
  shared: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  // An item's words in its share: one line, an ellipsis where they do not fit.
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A step shorter than the size, inside a track that leaves the same room on every side, so the
  // track itself stands at the size's height.
  xs: {
    height: `calc(${sizes.toggleHeight} - 2 * ${sizes.toggleGap})`,
    minWidth: `calc(${sizes.toggleHeight} - 2 * ${sizes.toggleGap})`,
  },
  sm: {
    height: `calc(${sizes.controlSm} - 2 * ${space.toggleTrackPadding})`,
    minWidth: `calc(${sizes.controlSm} - 2 * ${space.toggleTrackPadding})`,
  },
  default: {
    height: `calc(${sizes.controlDefault} - 2 * ${space.toggleTrackPadding})`,
    minWidth: `calc(${sizes.controlDefault} - 2 * ${space.toggleTrackPadding})`,
  },
  lg: {
    height: `calc(${sizes.controlLg} - 2 * ${space.toggleTrackPadding})`,
    minWidth: `calc(${sizes.controlLg} - 2 * ${space.toggleTrackPadding})`,
  },
  item: {
    borderRadius: `calc(${radius.base} - ${space.toggleTrackPadding})`,
  },
  // An icon alone: square.
  square: { paddingInline: 0 },
  // Can be pressed: the word alone turns ink under a pointer, with no fill, so it never reads as the
  // choice beside the raised one.
  live: {
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    backgroundColor: "transparent",
  },
  disabled: {
    opacity: sizes.opacityDisabled,
    cursor: "not-allowed",
    transform: "none",
  },
  // A finger needs 44px: an invisible area inside the item reaches past its top and bottom on
  // touch. Never past its sides, where it would lie over its neighbour and take that one's press.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [media.pointerCoarse]: `calc((100% - ${sizes.tapTarget}) / 2)`,
    },
  },
});

/** An item's height in the track, by the group's size. */
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

// The group's size, which every item in it takes.
const GroupSize = createContext<ToggleSize>("xs");
// Whether the items share the group's full width (fullWidth, side by side).
const GroupShared = createContext(false);

export const ToggleGroup = ({
  children,
  size = "xs",
  fullWidth = false,
  style,
  ...rest
}: ToggleGroupProps) => {
  const upright = rest.orientation === "vertical";
  return (
    <GroupSize value={size}>
      <GroupShared value={fullWidth && !upright}>
        <ToggleGroupPrimitive
          {...rest}
          data-slot="toggle-group"
          {...stylex.props(
            segmentedStyles.track,
            styles.group,
            fullWidth && styles.fullWidth,
            upright && styles.vertical,
            ringInsetMarker,
            style
          )}
        >
          {children}
        </ToggleGroupPrimitive>
      </GroupShared>
    </GroupSize>
  );
};

/** One toggle in a ToggleGroup: pressed when the group's value lists it. */
const Item = ({
  children,
  tooltip: _tooltip,
  style,
  ...rest
}: ToggleGroupItemProps) => {
  const size = useContext(GroupSize);
  const shared = useContext(GroupShared);
  const icon = iconOnly(children);
  return (
    <TogglePrimitive
      {...rest}
      data-slot="toggle-group-item"
      className={(state: ToggleState) =>
        className(
          toggleVariants({ size }),
          sizeStyle(size),
          styles.item,
          icon && styles.square,
          shared && styles.shared,
          !state.disabled && !state.pressed && styles.live,
          state.pressed && segmentedStyles.chosen,
          state.disabled && styles.disabled,
          style,
          focusRing
        )
      }
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {shared && !icon ? (
        <span {...stylex.props(styles.words)}>{children}</span>
      ) : (
        children
      )}
    </TogglePrimitive>
  );
};

export const ToggleGroupItem = (props: ToggleGroupItemProps) => (
  <ControlTooltip tooltip={props.tooltip} iconOnly={iconOnly(props.children)}>
    <Item {...props} />
  </ControlTooltip>
);
