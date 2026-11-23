// Kbd: a key to press, in StyleX. A small soft key with an edge, its sign in muted
// small type; a shortcut is a KbdGroup of one Kbd per key.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
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

const styles = stylex.create({
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    height: size.kbdHeight,
    minWidth: size.kbdHeight,
    paddingInline: space.kbdPadding,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: 1,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
    // Forced colours drop the fill and the edge: a line keeps the key.
    outline: { default: "none", [media.forcedColors]: "1px solid CanvasText" },
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
