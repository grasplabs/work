// Toggle: a button that stays pressed, from shadcn's (registry/bases/base/ui/toggle.tsx, on Base
// UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Toggle. Palermo has no lone
// toggle; it takes the values of Palermo's toggle group: 28px tall, 6px at each end, the words
// muted until pressed. Alone, pressed lays a veil of ink deeper than hover's; in a ToggleGroup,
// pressed raises it out of the track, as Palermo's. A small toggle takes a smaller icon.
//
//   <Toggle icon={Bold} aria-label="Bold" />
//   <Toggle defaultPressed>Show archived</Toggle>
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Toggle as TogglePrimitive } from "@ui-sdk/react/toggle";
import type { ToggleState } from "@ui-sdk/react/toggle";
import { useContext } from "react";
import type { ComponentProps, ReactNode } from "react";

import { focus } from "../focus/focus";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { ToggleGroupContext } from "./toggle-context";
import type { ToggleSize } from "./toggle-context";

/** What a caller may style: where the toggle sits. Never its look. */
export type ToggleLayoutStyle = LayoutStyle;

type TogglePrimitiveProps = ComponentProps<typeof TogglePrimitive>;

/** Every prop a Toggle takes. */
interface ToggleOwnProps {
  /** Its words: what it turns on, in sentence case ("Show archived"). Leave out for an icon alone. */
  children?: ReactNode;
  /** An icon before the words, from the icons entry (`@/components/grasp/icons`). Alone, give the toggle an `aria-label`. */
  icon?: IconData;
  /** Its name when it shows only an icon ("Bold"). */
  "aria-label"?: string;
  /** Whether it is pressed now, for a toggle your code holds. In a group, the group decides. */
  pressed?: boolean;
  /**
   * Whether it is pressed at first, when it holds its own state.
   * @default false
   */
  defaultPressed?: boolean;
  /** Runs when a press turns it on or off, with the new state. */
  onPressedChange?: TogglePrimitiveProps["onPressedChange"];
  /** Its name inside a ToggleGroup: the group's value lists the pressed toggles by it. */
  value?: string;
  /**
   * `md` beside other controls, `sm` in a dense toolbar. In a group, the group's size.
   * @default "md"
   */
  size?: ToggleSize;
  /**
   * Out of use: no press, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** @deprecated Use `layout`. */
  style?: ToggleLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the toggle. */
  layout?: ToggleLayoutStyle;
}

/** Every prop a Toggle takes: the ones above, and the rest of UI SDK's Toggle. */
export type ToggleProps = ToggleOwnProps &
  Omit<TogglePrimitiveProps, keyof ToggleOwnProps | "className" | "render">;

const HOVER = media.hover;
const FORCED = media.forced;

const styles = stylex.create({
  toggle: {
    [iconVars.size]: grasp.toggleIcon,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space1,
    flexShrink: 0,
    boxSizing: "border-box",
    margin: 0,
    paddingBlock: 0,
    paddingInline: grasp.toggleInset,
    borderWidth: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    color: grasp.muted,
    backgroundColor: "transparent",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color, background-color, box-shadow, transform",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
    transform: { default: "none", ":active": `scale(${grasp.pressScale})` },
  },
  md: { height: grasp.toggleHeight, minWidth: grasp.toggleHeight },
  sm: { height: grasp.toggleHeightSm, minWidth: grasp.toggleHeightSm },
  // Small: the icon shrinks with the toggle, so it keeps its room.
  iconSm: { [iconVars.size]: grasp.toggleIconSm },
  // In a group: a step shorter, inside a track that leaves the same room on every side.
  groupedMd: {
    height: `calc(${grasp.toggleHeight} - 2 * ${grasp.toggleGap})`,
    minWidth: `calc(${grasp.toggleHeight} - 2 * ${grasp.toggleGap})`,
  },
  groupedSm: {
    height: `calc(${grasp.toggleHeightSm} - 2 * ${grasp.toggleGap})`,
    minWidth: `calc(${grasp.toggleHeightSm} - 2 * ${grasp.toggleGap})`,
  },
  grouped: {
    borderRadius: `calc(${grasp.corner} - ${grasp.toggleTrackInset})`,
  },
  // An icon alone: square.
  square: { paddingInline: 0 },
  // Can be pressed: the words turn ink and a faint fill shows under a pointer.
  live: {
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
    },
  },
  // Can be pressed, in a group: the word alone turns ink under a pointer, with no fill, as Theme
  // switch's segments do; a fill read as the choice beside the raised pill (A3-actions-02).
  liveGrouped: {
    backgroundColor: "transparent",
  },
  // Pressed, alone: a veil of ink clearly deeper than hover's, the words ink; a pointer on it
  // deepens it one step more.
  pressed: {
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
    backgroundColor: {
      default: grasp.toggleFillPressed,
      ":hover": { default: null, [HOVER]: grasp.toggleFillPressedHover },
      [FORCED]: "Highlight",
    },
  },
  // Pressed, in a group: raised out of the track with the low lift, so the choice is a shape and
  // not a colour alone.
  raised: {
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
    backgroundColor: { default: grasp.tabFillChosen, [FORCED]: "Highlight" },
    // In dark the chosen fill is barely off the track; the same veil a chosen segmented tab wears
    // there lifts it as clearly (A3-actions-03; tabs.tsx segmentChosen, A-nav-24).
    backgroundImage: {
      default: `linear-gradient(light-dark(transparent, ${grasp.ghostFillPress}), light-dark(transparent, ${grasp.ghostFillPress}))`,
      [FORCED]: "none",
    },
    boxShadow: grasp.liftLow,
  },
  disabled: {
    opacity: grasp.dim,
    cursor: "not-allowed",
    transform: "none",
  },
  // A finger needs 44px: an invisible area inside the toggle reaches past its edges on touch.
  target: {
    position: "absolute",
    insetInline: {
      default: 0,
      [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
    insetBlock: {
      default: 0,
      [media.coarse]: `calc((100% - ${grasp.tap}) / 2)`,
    },
  },
  // In a group the toggles stand side by side: an area reaching past a toggle's sides would lie
  // over its neighbour and take that one's press. It keeps to its own width, and the full height.
  targetGrouped: { insetInline: 0 },
});

// A grouped toggle's height, by the group's size.
const groupedSize = { sm: styles.groupedSm, md: styles.groupedMd } as const;

export const Toggle = ({
  children,
  icon,
  size,
  style: styleProp,
  layout,
  ...rest
}: ToggleProps) => {
  const group = useContext(ToggleGroupContext);
  const scale = group.grouped ? group.size : (size ?? "md");
  const square = children === undefined || children === null;
  return (
    <TogglePrimitive
      {...rest}
      className={(state: ToggleState) =>
        stylex.props(
          styles.toggle,
          group.grouped ? groupedSize[scale] : styles[scale],
          group.grouped && styles.grouped,
          scale === "sm" && styles.iconSm,
          square && styles.square,
          !state.disabled && !state.pressed && styles.live,
          !state.disabled &&
            !state.pressed &&
            group.grouped &&
            styles.liveGrouped,
          state.pressed && (group.grouped ? styles.raised : styles.pressed),
          state.disabled && styles.disabled,
          layout ?? styleProp,
          focus.ring
        ).className
      }
    >
      <span
        aria-hidden="true"
        {...stylex.props(styles.target, group.grouped && styles.targetGrouped)}
      />
      {icon && <Icon icon={icon} />}
      {children}
    </TogglePrimitive>
  );
};
