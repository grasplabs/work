// Snippet: a value you can copy, as one quiet line. The value in the mono face on a quiet fill in
// the system's corner, a CopyButton at its end. A press anywhere on it copies the value; the button
// shows the check for a moment, the field turns to the success ground, and the page's one live
// region says so. For an install command, an id, a key, a token's name or its value.
//
//   <Snippet value="pnpm dlx shadcn add @acme/button" aria-label="Copy the install command" />
//   <Snippet size="sm" value="--brand-mint" aria-label="Copy --brand-mint" swatch="var(--brand-mint)" />
//
// It is one button (the copy button), so a keyboard reaches it once and a screen reader hears its
// name; the field round it is a label for that button, so a press on the value presses it too. A
// value longer than its room stays on one line and scrolls sideways inside the field, the end with
// more fading; it is never broken and never cut short. The timing, the check and the words are
// CopyButton's, the same for every copy in the library.
//
// Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";

import { useScrollEdges } from "../hooks/use-scroll-edges";
import { focusWithin } from "../lib/styles";
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
import { motionVars } from "../lib/vars.stylex";
import { ghostVars } from "./button.stylex";
import { CopyButton } from "./copy-button";

/** Every prop a Snippet takes. */
export interface SnippetProps {
  /** What is shown and copied, exactly: a command, an id, a token's name or value. */
  value: string;
  /**
   * The copy button's name, saying what it copies ("Copy the install command"), shown in its
   * tooltip too.
   * @default the catalogue's copyButton.copy, "Copy"
   */
  "aria-label"?: string;
  /**
   * `sm` 28px, for a list of values (a token's name and values); `default` 32px, for one value on
   * its own (an install command). On a touch screen the button has a 44px target either way.
   * @default "default"
   */
  size?: "sm" | "default";
  /** A colour shown as a small round before the value, for a colour's name or value: any CSS colour. */
  swatch?: string;
  /** Called with the value once it is on the clipboard. */
  onCopy?: (value: string) => void;
  /** Layout only: margins, width and alignment. The look belongs to the field. */
  style?: LayoutStyle;
}

// The copy button's result, read from the button itself (Button's data-status), so the field's
// ground follows it with no state of its own.
const COPIED = ':has([data-status="success"])';
const FAILED = ':has([data-status="error"])';
const RESTING = ':not(:has([data-status="success"], [data-status="error"]))';

/** The fade at an end with more beyond it: the space-8 nearest that end goes to nothing. */
const fadeEnd = `linear-gradient(to right, black calc(100% - ${space["8"]}), transparent)`;
const fadeStart = `linear-gradient(to left, black calc(100% - ${space["8"]}), transparent)`;
const fadeBoth = `linear-gradient(to right, transparent, black ${space["8"]}, black calc(100% - ${space["8"]}), transparent)`;

const styles = stylex.create({
  // The field's ring, just inside its edge: the field is a box in a row or a dialog, where a ring
  // standing off it would lie on what is beside it or be cut by what holds it.
  ringInside: {
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  // The field: a quiet fill in the system's corner, one line. It is one surface: its copy button
  // draws no fill or ring of its own in it (ghostVars), the field's fill answers the pointer and
  // the field takes the keyboard's ring (focusWithin); the icon is quiet until the pointer comes.
  field: {
    [ghostVars.hover]: "transparent",
    [ghostVars.active]: "transparent",
    [ghostVars.ring]: "transparent",
    // Its mark: quiet at rest, ink under the pointer, then the result's own colour.
    [ghostVars.ink]: {
      default: colors.mutedForeground,
      [`${RESTING}:hover`]: {
        default: null,
        [media.hover]: colors.foreground,
      },
      [`:is(${COPIED})`]: colors.mintDeep,
      [`:is(${FAILED})`]: colors.destructive,
    },
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    boxSizing: "border-box",
    maxWidth: "100%",
    minWidth: 0,
    margin: 0,
    paddingBlock: 0,
    paddingInlineStart: space["3"],
    fontFamily: font.mono,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    textAlign: "start",
    color: colors.foreground,
    cursor: "copy",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    verticalAlign: "middle",
    backgroundColor: {
      default: colors.codeBg,
      // Hover only at rest: while it says "copied", that wins.
      [`${RESTING}:hover`]: {
        default: null,
        [media.hover]: `color-mix(in oklch, ${colors.codeBg}, ${colors.foreground} 7%)`,
      },
      [`:is(${COPIED})`]: colors.successSubtle,
    },
    // Forced colours drop the fill: a line keeps the field.
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: {
      default: "inset 0 0 0 1px transparent",
      [`:is(${COPIED})`]: `inset 0 0 0 1px color-mix(in oklch, ${colors.mintDeep} 35%, transparent)`,
      // Strong enough to stand off the fill in dark, where a third of the colour read as a dull brown.
      [`:is(${FAILED})`]: `inset 0 0 0 1px color-mix(in oklch, ${colors.destructive} 60%, transparent)`,
    },
    transform: { default: null, ":active": `scale(${size.buttonPressScale})` },
    transitionProperty: "background-color, box-shadow, transform",
    // The ground and the edge change with the button's crossfade, never ahead of it.
    transitionDuration: `${duration.hover}, ${motionVars.swap}, ${motionVars.press}`,
    transitionTimingFunction: duration.ease,
  },
  // The button is a square as tall as the field: the room at the end makes up the rest, so the
  // icon stands as far from the end as the words from the start (space-3).
  sm: {
    height: size.controlXs,
    paddingInlineEnd: `max(0px, calc(${space["3"]} - (${size.controlXs} - ${size.iconSm}) / 2))`,
  },
  default: {
    height: size.controlSm,
    paddingInlineEnd: `max(0px, calc(${space["3"]} - (${size.controlSm} - ${size.iconSm}) / 2))`,
  },
  // A colour before the value: a small round of it with a 1px ring in the muted ink (4.5:1 on the
  // field in light and dark), so a colour like the field's own ground still shows as a round.
  swatch: (colour: string) => ({
    flexShrink: 0,
    width: space["3"],
    height: space["3"],
    marginInlineEnd: space["2"],
    borderRadius: radius.circle,
    backgroundColor: colour,
    boxShadow: `inset 0 0 0 1px ${colors.mutedForeground}`,
    forcedColorAdjust: "none",
  }),
  // The value: one line, never broken, never cut with an ellipsis. Narrower than its text, it
  // scrolls sideways inside the field with no bar and the end with more fades out.
  value: {
    flexGrow: 1,
    minWidth: 0,
    overflowX: "auto",
    overflowY: "hidden",
    whiteSpace: "nowrap",
    scrollbarWidth: "none",
    // Out of the tab order (below), but a press can still focus it: the field's ring shows focus.
    outline: "none",
    maskImage: {
      default: "none",
      ":is([data-under-end]:not([data-under-start]))": fadeEnd,
      ":is([data-under-start]:not([data-under-end]))": fadeStart,
      ":is([data-under-start][data-under-end])": fadeBoth,
    },
  },
});

/** A value you can copy, as one quiet line with a copy button at its end. */
export const Snippet = ({
  value,
  "aria-label": label,
  size: sized = "default",
  swatch,
  onCopy,
  style,
}: SnippetProps) => {
  // The ends of the value with more beyond them are marked for the fade there.
  const edges = useScrollEdges();
  const hasSwatch = swatch !== undefined && swatch !== "";
  return (
    // A label round the button: a press anywhere on the field presses the button, once.
    <label
      data-slot="snippet"
      data-size={sized}
      {...stylex.props(
        styles.field,
        sized === "sm" ? styles.sm : styles.default,
        focusWithin,
        styles.ringInside,
        style
      )}
    >
      {hasSwatch ? (
        <span aria-hidden="true" {...stylex.props(styles.swatch(swatch))} />
      ) : null}
      {/* Out of the tab order: Chrome and Firefox make a box that scrolls a Tab stop of its own,
          a second, ringless stop before the button. The button is the one stop. */}
      <span
        ref={edges}
        tabIndex={-1}
        data-slot="snippet-value"
        dir="ltr"
        {...stylex.props(styles.value)}
      >
        {value}
      </span>
      <CopyButton
        value={value}
        onCopy={onCopy}
        size={sized === "sm" ? "icon-xs" : "icon-sm"}
        aria-label={label}
      />
    </label>
  );
};
