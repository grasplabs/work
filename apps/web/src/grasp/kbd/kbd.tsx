// Kbd: a key to press, from shadcn's (registry/bases/base/ui/kbd.tsx), converted from Tailwind to
// StyleX and made Grasp's. Palermo has none: it is drawn as the ⌘K key in Palermo's search box, a
// small soft key with the edge, its sign in muted small type.
//
//   <Kbd>Esc</Kbd>
//   <Kbd>⌘</Kbd><Kbd>K</Kbd>      a shortcut: one key each
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { visuallyHidden } from "../hidden/hidden";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where the key sits. Never its look. */
export type KbdLayoutStyle = LayoutStyle;

/** Every prop a Kbd takes. */
export interface KbdProps {
  /** The key's sign as it is printed on the keyboard: "⌘", "Shift", "K". */
  children: ReactNode;
  /** Its name to a screen reader when the sign alone is a symbol ("Command" for "⌘"). */
  "aria-label"?: string;
  /** @deprecated Use `layout`. */
  style?: KbdLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the key. */
  layout?: KbdLayoutStyle;
}

const styles = stylex.create({
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    height: grasp.kbdHeight,
    minWidth: grasp.kbdHeight,
    paddingInline: grasp.kbdInset,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: 1,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    color: grasp.muted,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    // Forced colours drop the fill and the edge: a line keeps the key.
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: "-1px",
    userSelect: "none",
  },
});

export const Kbd = ({
  children,
  "aria-label": label,
  style: styleProp,
  layout,
}: KbdProps) => (
  <kbd data-slot="kbd" {...stylex.props(styles.kbd, layout ?? styleProp)}>
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
