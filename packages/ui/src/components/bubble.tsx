// Bubble: the framed surface of a message in a conversation. A Message lays out the row (avatar, header, footer, which side); a Bubble is the surface
// inside it. The person's message is a `muted` Bubble at the end of the line: the soft bubble with
// the one edge. Reactions overlap its edge.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Bubble variant="muted" align="end">
//     <BubbleContent>Which invoices are unpaid?</BubbleContent>
//     <BubbleReactions role="img" aria-label="Reactions: thumbs up">👍</BubbleReactions>
//   </Bubble>
//
// A Bubble is as wide as its words, up to {message-bubble-width} of the column; `ghost` drops the
// frame and spans the row. BubbleContent may be drawn as the caller's own button or link
// (`asChild`): it is then reached by Tab, named by its words, with the keyboard's ring. Every value
// is a token. A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import { createContext, isValidElement, use } from "react";
import type { ReactNode } from "react";

import { focusOnColor, focusRing } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";

/** How a Bubble looks, from the strongest to no frame at all. */
export type BubbleVariant =
  | "default"
  | "secondary"
  | "muted"
  | "tinted"
  | "outline"
  | "ghost"
  | "destructive";

/** Every prop a BubbleGroup takes. */
export interface BubbleGroupProps {
  /** Consecutive Bubbles from the same sender. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a Bubble takes. */
export interface BubbleProps {
  /** Its BubbleContent, then any BubbleReactions. */
  children: ReactNode;
  /**
   * Its look: `default` the strong action fill, `secondary` the quiet fill, `muted` the soft band
   * (the person's message), `tinted` a wash of the brand's green, `outline` the page with the one
   * edge, `ghost` no frame (an answer's words, across the row), `destructive` a failure.
   * @default "default"
   */
  variant?: BubbleVariant;
  /**
   * Which end of the line it stands at: `end` for the person's own messages. In a Message, its
   * `align` places the Bubble too.
   * @default "start"
   */
  align?: "start" | "end";
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a BubbleContent takes. */
export interface BubbleContentProps {
  /** The words, or, with `asChild`, the one element (a `<button>` or `<a>`) to draw as the surface. */
  children: ReactNode;
  /**
   * Draw the one element given as children as the surface (a button, a link), with the Bubble's
   * look, keeping its own words and handlers.
   * @default false
   */
  asChild?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a BubbleReactions takes. */
export interface BubbleReactionsProps {
  /**
   * The reactions: emoji, a count, or small buttons. As a row of emoji, give it `role="img"` and an
   * `aria-label` that reads the row once ("Reactions: thumbs up, fire, and 8 more").
   */
  children: ReactNode;
  /**
   * The edge of the Bubble it overlaps.
   * @default "bottom"
   */
  side?: "top" | "bottom";
  /**
   * The end of that edge it stands at.
   * @default "end"
   */
  align?: "start" | "end";
  /** `img` for a row of emoji read as one picture. */
  role?: "img" | "group";
  /** Its name for a screen reader: what the reactions are. */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  group: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    minWidth: 0,
  },
  bubble: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    boxSizing: "border-box",
    width: "fit-content",
    minWidth: 0,
    maxWidth: size.messageBubbleWidth,
  },
  end: { alignSelf: "flex-end" },
  ghost: { maxWidth: "100%" },
  // The surface: the person's message's padding, corner and type.
  content: {
    boxSizing: "border-box",
    width: "fit-content",
    maxWidth: "100%",
    minWidth: 0,
    margin: 0,
    paddingBlock: space["3"],
    paddingInline: space["4"],
    border: "none",
    borderRadius: radius.base,
    cornerShape: radius.shape,
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    textAlign: "start",
    textDecoration: "none",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    outline: {
      default: "none",
      [media.forcedColors]: `${size.hairline} solid`,
    },
  },
  contentEnd: { alignSelf: "flex-end" },
  // Drawn as a button or a link: pressed by pointer, its fill a step down under it.
  pressable: {
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: {
      default: duration.hover,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  reactions: {
    position: "absolute",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space["1"],
    width: "fit-content",
    flexShrink: 0,
    paddingInline: space["2"],
    borderRadius: radius.full,
    backgroundColor: colors.card,
    // The one edge, so it reads as laid over the Bubble's.
    boxShadow: size.borderStrong,
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    outline: {
      default: "none",
      [media.forcedColors]: `${size.hairline} solid`,
    },
  },
  reactionsButtons: { padding: 0 },
  top: { top: 0, transform: "translateY(-75%)" },
  bottom: { bottom: 0, transform: "translateY(75%)" },
  reactionsStart: { insetInlineStart: space["3"] },
  reactionsEnd: { insetInlineEnd: space["3"] },
});

// Each variant's fill and words; the pressable fill under a pointer beside it.
const looks = stylex.create({
  default: {
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  secondary: {
    backgroundColor: colors.control,
    boxShadow: size.borderStrong,
  },
  muted: {
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
  },
  tinted: { backgroundColor: colors.accent },
  outline: {
    backgroundColor: colors.background,
    boxShadow: size.borderStrong,
  },
  ghost: {
    paddingBlock: 0,
    paddingInline: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    outline: "none",
  },
  destructive: {
    backgroundColor: colors.destructiveSubtle,
    color: colors.destructive,
  },
});

const pressed = stylex.create({
  default: {
    backgroundColor: { default: colors.primary, ":hover": colors.primaryHover },
  },
  secondary: {
    backgroundColor: {
      default: colors.control,
      ":hover": colors.controlHover,
    },
  },
  muted: {
    backgroundColor: { default: colors.muted, ":hover": colors.controlHover },
  },
  tinted: {
    backgroundColor: { default: colors.accent, ":hover": colors.accentActive },
  },
  outline: {
    backgroundColor: {
      default: colors.background,
      ":hover": colors.accent,
    },
  },
  ghost: {
    backgroundColor: { default: "transparent", ":hover": colors.accent },
  },
  destructive: {
    backgroundColor: {
      default: colors.destructiveSubtle,
      ":hover": colors.accentActive,
    },
  },
});

const VariantContext = createContext<BubbleVariant>("default");
const AlignContext = createContext<"start" | "end">("start");

/** Consecutive Bubbles from the same sender, stacked close. */
export const BubbleGroup = ({ children, style }: BubbleGroupProps) => (
  <div data-slot="bubble-group" {...stylex.props(styles.group, style)}>
    {children}
  </div>
);

/** The framed surface of one message: as wide as its words, up to most of the line. */
export const Bubble = ({
  children,
  variant = "default",
  align = "start",
  style,
}: BubbleProps) => (
  <VariantContext value={variant}>
    <AlignContext value={align}>
      <div
        data-slot="bubble"
        data-variant={variant}
        data-align={align}
        {...stylex.props(
          styles.bubble,
          align === "end" && styles.end,
          variant === "ghost" && styles.ghost,
          style
        )}
      >
        {children}
      </div>
    </AlignContext>
  </VariantContext>
);

/** The Bubble's surface: its words, or the caller's button or link drawn with its look. */
export const BubbleContent = ({
  children,
  asChild = false,
  style,
}: BubbleContentProps) => {
  const variant = use(VariantContext);
  const align = use(AlignContext);
  const element =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  const own = {
    "data-slot": "bubble-content",
    ...stylex.props(
      styles.content,
      looks[variant],
      element !== undefined && styles.pressable,
      element !== undefined && pressed[variant],
      align === "end" && styles.contentEnd,
      element !== undefined && focusRing,
      // Words on the filled Bubble: a link among them shows its ring in the ink seen on the fill.
      element === undefined && variant === "default" && focusOnColor,
      style
    ),
  };
  if (element !== undefined) {
    return renderElement("div", own, element);
  }
  return <div {...own}>{children}</div>;
};

/** Reactions or quick buttons laid over the Bubble's edge. */
export const BubbleReactions = ({
  children,
  side = "bottom",
  align = "end",
  role,
  "aria-label": label,
  style,
}: BubbleReactionsProps) => (
  <div
    role={role}
    aria-label={label}
    data-slot="bubble-reactions"
    data-side={side}
    data-align={align}
    {...stylex.props(
      styles.reactions,
      role !== "img" && styles.reactionsButtons,
      side === "top" ? styles.top : styles.bottom,
      align === "start" ? styles.reactionsStart : styles.reactionsEnd,
      style
    )}
  >
    {children}
  </div>
);
