// Marker: a line in a conversation that marks something that happened to it:
// a status of the conversation, a note, a row with a rule under it, or a word
// in the middle of a hairline (a date, "New messages", a checkpoint).
//
//   <Marker variant="separator">
//     <MarkerContent>Today</MarkerContent>
//   </Marker>
//   <Marker variant="separator" color="primary" decorative={false}>
//     <MarkerContent>New messages</MarkerContent>
//   </Marker>
//   <Marker role="status">
//     <MarkerIcon><Spinner /></MarkerIcon>
//     <MarkerContent>Reconnecting</MarkerContent>
//   </Marker>
//
// It says nothing by itself: give it `role="status"` when its words change while it stands, so they
// are said as they change. An assistant's step or work under way is a Trace line. A separator's words are ordinary content; its lines are drawn,
// not read. With `decorative={false}` it is read as a separator named by its words: a separator's
// children are not read, so its MarkerContent names it. `color` draws its words and rules in one of
// the brand's colours (`primary` for news). Drawn as the caller's link or button (`asChild`), it is
// reached by Tab and named by its words. Every value is a token. A caller may set layout only (the
// `style` prop).
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import { createContext, isValidElement, use, useId } from "react";
import type { ReactNode } from "react";

import { focusRingText } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";

/** How a Marker is drawn: a line of words, the same with a rule under it, or a word between rules. */
export type MarkerVariant = "default" | "separator" | "border";
/**
 * The colour of its words and rules: the quiet default, or one of the brand's colours, each in the
 * shade of it that holds as words.
 */
export type MarkerColor =
  | "default"
  | "primary"
  | "mint"
  | "pine"
  | "lavender"
  | "success"
  | "warning"
  | "destructive"
  | "info";

/** Every prop a Marker takes. */
export interface MarkerProps {
  /** Its MarkerIcon and MarkerContent, or, with `asChild`, the one link or button that holds them. */
  children: ReactNode;
  /**
   * `default` a line of words; `border` the same with a hairline under it, between rows of work;
   * `separator` its words in the middle of a hairline, between parts of a conversation.
   * @default "default"
   */
  variant?: MarkerVariant;
  /**
   * `default` muted words and hairline rules. Any other colour draws its words and rules in that
   * colour, in the shade that holds as words on every ground: `primary` for news (where the unread
   * messages start), `mint` (mint-deep) and `pine` for the brand's greens, `lavender` the second
   * accent, `success`, `warning`, `destructive` and `info` for what a status means.
   * @default "default"
   */
  color?: MarkerColor;
  /**
   * Draw the one element given as children (a link, a button) as the Marker, with its look,
   * keeping its own words and handlers.
   * @default false
   */
  asChild?: boolean;
  /**
   * A separator only: its rules are only drawn, and a screen reader reads its words as text. Set
   * it to `false` for a line a screen reader should announce as a separator (where the unread
   * messages start), named by its MarkerContent; it then holds words only, no Button beside them,
   * and is neither a status nor drawn as a link or button (`asChild`).
   * @default true
   */
  decorative?: boolean;
  /** `status` for a line whose words change while it stands (Reconnecting), said as they change. */
  role?: "status";
  /** Its name for a screen reader, when it has no words of its own (an icon only). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MarkerIcon takes. */
export interface MarkerIconProps {
  /** An icon or a Spinner. Hidden from screen readers: the words carry the meaning. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MarkerContent takes. */
export interface MarkerContentProps {
  /** Its words. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

const rule = {
  content: "''",
  flexGrow: 1,
  minWidth: 0,
  height: size.hairline,
  backgroundColor: {
    default: colors.border,
    [media.forcedColors]: "CanvasText",
  },
};

const styles = stylex.create({
  root: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    width: "100%",
    minHeight: size.iconSm,
    margin: 0,
    padding: 0,
    border: "none",
    backgroundColor: "transparent",
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    textAlign: "start",
    textDecoration: "none",
  },
  // A word in the middle of a hairline, clear of it on each side: the conversation's date line.
  separator: {
    gap: space["3"],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    "::before": rule,
    "::after": rule,
  },
  border: {
    paddingBlockEnd: space["2"],
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: {
      default: colors.border,
      [media.forcedColors]: "CanvasText",
    },
  },
  // In a colour: its rules take the colour of its words. Under forced colours the words take the
  // system's text colour by themselves, and the rules are set to it.
  inked: {
    borderBlockEndColor: {
      default: "currentColor",
      [media.forcedColors]: "CanvasText",
    },
    "::before": {
      backgroundColor: {
        default: "currentColor",
        [media.forcedColors]: "CanvasText",
      },
    },
    "::after": {
      backgroundColor: {
        default: "currentColor",
        [media.forcedColors]: "CanvasText",
      },
    },
  },
  // Drawn as a link or a button: underlined, the words' ink under a pointer.
  pressable: {
    cursor: "pointer",
    // On a touch screen it stands a finger tall.
    minHeight: { default: size.iconSm, [media.pointerCoarse]: size.tapTarget },
    textDecorationLine: "underline",
    textUnderlineOffset: "3px",
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    transitionProperty: "color",
    transitionDuration: {
      default: duration.hover,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: size.iconSm,
    height: size.iconSm,
  },
  content: {
    minWidth: 0,
    overflowWrap: "break-word",
  },
  // Its words wrap before they reach the edge: the hairlines on each side go to nothing, the gaps
  // beside them stay, so the row never runs past its box.
  contentSeparator: {
    flexShrink: 0,
    maxWidth: `calc(100% - 2 * ${space["3"]})`,
    textAlign: "center",
  },
});

// Each colour in the shade of it that holds as words on every ground, in light and in dark.
const inks = stylex.create({
  primary: { color: colors.primary },
  mint: { color: colors.mintDeep },
  pine: { color: colors.pine },
  lavender: { color: colors.lavender },
  success: { color: colors.success },
  warning: { color: colors.warning },
  destructive: { color: colors.destructive },
  info: { color: colors.info },
});

const VariantContext = createContext<MarkerVariant>("default");
// The id its words take when they name it as a separator.
const ContentIdContext = createContext<string | undefined>(undefined);

/** A line in a conversation that marks what happened: a status, a note, or a word between rules. */
export const Marker = ({
  children,
  variant = "default",
  color = "default",
  asChild = false,
  decorative = true,
  role,
  "aria-label": label,
  style,
}: MarkerProps) => {
  const element =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  const contentId = useId();
  // Only a separator of words: a status stays a status, and a caller's link or button keeps its role.
  const separator =
    variant === "separator" &&
    !decorative &&
    role === undefined &&
    element === undefined;
  // A separator's children are not read: its words name it.
  const nameId = separator && label === undefined ? contentId : undefined;
  const own = {
    role: separator ? "separator" : role,
    "aria-label": label,
    "aria-labelledby": nameId,
    "data-slot": "marker",
    "data-variant": variant,
    ...stylex.props(
      styles.root,
      variant === "separator" && styles.separator,
      variant === "border" && styles.border,
      element !== undefined && styles.pressable,
      element !== undefined && focusRingText,
      color !== "default" && [styles.inked, inks[color]],
      style
    ),
  };
  return (
    <VariantContext value={variant}>
      <ContentIdContext value={nameId}>
        {element === undefined ? (
          <div {...own}>{children}</div>
        ) : (
          renderElement("div", own, element)
        )}
      </ContentIdContext>
    </VariantContext>
  );
};

/** The Marker's icon, hidden from screen readers. */
export const MarkerIcon = ({ children, style }: MarkerIconProps) => (
  <span
    aria-hidden="true"
    data-slot="marker-icon"
    {...stylex.props(styles.icon, style)}
  >
    {children}
  </span>
);

/** The Marker's words. */
export const MarkerContent = ({ children, style }: MarkerContentProps) => {
  const variant = use(VariantContext);
  const contentId = use(ContentIdContext);
  return (
    <span
      id={contentId}
      data-slot="marker-content"
      {...stylex.props(
        styles.content,
        variant === "separator" && styles.contentSeparator,
        style
      )}
    >
      {children}
    </span>
  );
};
