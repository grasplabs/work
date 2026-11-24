// Kbd: a key to press, in StyleX. A small soft key with an edge, its sign in muted
// small type; a shortcut is a KbdGroup of one Kbd per key.
//
//   <Kbd>Esc</Kbd>
//   <KbdGroup><Kbd aria-label="Command">⌘</Kbd><Kbd>K</Kbd></KbdGroup>
//
// Every value is a token. A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { visuallyHidden } from "../lib/styles";
import { colors, font, media, radius, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";

/** Every prop a Kbd takes. */
export interface KbdProps {
  /** The key's sign as it is printed on the keyboard: "⌘", "Shift", "K". */
  children: ReactNode;
  /** Its name to a screen reader when the sign alone is a symbol ("Command" for "⌘"). */
  "aria-label"?: string;
  /** Layout only: margins and alignment. The look belongs to the key. */
  style?: LayoutStyle;
}

/** Every prop a KbdGroup takes. */
export interface KbdGroupProps {
  /** The keys of one shortcut, a Kbd each, in the order they are pressed. */
  children: ReactNode;
  /** Layout only: margins and alignment. */
  style?: LayoutStyle;
}

// In a tooltip the keys are quiet words at the end of its line, no key cap: the tooltip is a dark
// chip already, and a white cap in it would be the loudest thing in it.
const IN_TOOLTIP = ":is([data-slot=tooltip-content] *)";

const styles = stylex.create({
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    height: { default: size.kbdHeight, [IN_TOOLTIP]: "auto" },
    minWidth: { default: size.kbdHeight, [IN_TOOLTIP]: 0 },
    // At the end of a tooltip's last line.
    marginInlineStart: { default: null, [IN_TOOLTIP]: "auto" },
    paddingInline: { default: space.kbdPadding, [IN_TOOLTIP]: 0 },
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: { default: 1, [IN_TOOLTIP]: "inherit" },
    fontWeight: {
      default: font.weightMedium,
      [IN_TOOLTIP]: font.weightNormal,
    },
    whiteSpace: "nowrap",
    color: {
      default: colors.mutedForeground,
      [IN_TOOLTIP]: {
        default: colors.tooltipMutedForeground,
        [media.forcedColors]: "CanvasText",
      },
    },
    backgroundColor: { default: colors.muted, [IN_TOOLTIP]: "transparent" },
    boxShadow: { default: size.borderStrong, [IN_TOOLTIP]: "none" },
    // Forced colours drop the fill and the edge: a line keeps the key.
    outline: {
      default: "none",
      [media.forcedColors]: {
        default: "1px solid CanvasText",
        [IN_TOOLTIP]: "none",
      },
    },
    outlineOffset: "-1px",
    userSelect: "none",
  },
  // On the baseline, as a word: each key's sign stands on the line its neighbours stand on.
  group: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: space[1],
  },
});

export const Kbd = ({ children, "aria-label": label, style }: KbdProps) => (
  <kbd data-slot="kbd" {...stylex.props(styles.kbd, style)}>
    {/* A kbd has no role, so a name on it goes unread: the spoken name is hidden text instead. */}
    {label === undefined ? (
      children
    ) : (
      <>
        <span aria-hidden="true">{children}</span>
        <span {...stylex.props(visuallyHidden)}>{label}</span>
      </>
    )}
  </kbd>
);

export const KbdGroup = ({ children, style }: KbdGroupProps) => (
  <kbd data-slot="kbd-group" {...stylex.props(styles.group, style)}>
    {children}
  </kbd>
);
