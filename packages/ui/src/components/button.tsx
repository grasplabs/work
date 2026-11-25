// Button: one action to press, in StyleX, in the
// brand's Bevel finish with the one corner. Its behaviour is UI SDK's Button, so an agent on the page
// finds it by its name and presses it; a destructive one waits for the person's yes first.
//
//   <Button>Save changes</Button>
//   <Button variant="outline"><Icon icon={PlusIcon} />Invite people</Button>
//   <Button variant="ghost" size="icon-sm" aria-label="More actions"><Icon icon={DotsIcon} /></Button>
//   <Button asChild><a href="/settings">Settings</a></Button>
//   <Button onClick={saveChanges}>Save changes</Button>          saveChanges returns a Promise
//   <Button onClick={sendInvite} successText="Sent" errorText="Not sent">Send invite</Button>
//
// A press whose `onClick` returns a Promise is followed by the Button itself (hooks/use-action):
// while it works the button is busy, takes no second press and shows a spinner; once it settles, a
// tick or the alert for a moment, then it rests. While it works the spinner takes the place of its
// icon and the words stay; with no icon the mark stands over the words, which keep their place
// unseen (and their name for a screen reader), so the button never changes width. Words for a
// state (`loadingText`, `successText`, `errorText`) are said, and shown in the words' place, every
// one stacked in the same cell so the widest sets the width; there, success with no words of its
// own is the tick before the button's words, so the button keeps the tick's room at rest (its
// width never changes as the tick comes). Failed, it draws the quiet fill with
// destructive words and edge, whatever its variant. A page that runs the work elsewhere (a form's
// submit) gives `status` instead.
//
// `tooltip` gives it a Tooltip of its own, as SidebarMenuButton's: an icon-only button shows its
// name (`aria-label`) by default, `tooltip={false}` shows none, and words show those. Inside a
// Tooltip of the caller's it shows none.
//
// Drawn by another UI SDK part (`<DialogTrigger asChild><Button /></DialogTrigger>`), it takes that
// part's props and is only its face: one element is never two UI SDK buttons, which an agent would
// see twice. A caller may set layout only, by `style`.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import { mergeProps } from "@ui-sdk/react/primitive";
import { isValidElement } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { useAction } from "../hooks/use-action";
import type { ActionResult, ActionStatus } from "../hooks/use-action";
import { useI18n } from "../lib/i18n";
import { CheckIcon, CircleAlertIcon, Icon } from "../lib/icons";
import { focusRing, hyphenate, tapTarget } from "../lib/styles";
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
import {
  isIconSize,
  isInvalid,
  isThenable,
  listOf,
  textOf,
} from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, layerFooterMarker, motionVars } from "../lib/vars.stylex";
import { buttonMarker, ghostVars } from "./button.stylex";
import { Spinner } from "./spinner";
import { ControlTooltip } from "./tooltip";

export type ButtonVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "success"
  | "outline"
  | "ghost"
  | "link";
export type ButtonSize =
  | "xs"
  | "sm"
  | "default"
  | "lg"
  | "icon"
  | "icon-xs"
  | "icon-sm"
  | "icon-lg";
type IconSize = "icon" | "icon-xs" | "icon-sm" | "icon-lg";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from ButtonProps, the union below, so they cannot drift from what the code accepts.

/** What every button takes: these, and the rest of UI SDK's Button and a <button>. */
interface ButtonBase extends Omit<
  ComponentProps<typeof ButtonPrimitive>,
  "className" | "style" | "render" | "children" | "onClick"
> {
  /**
   * The weight of the action: `default` for the one main step of a view, `outline` for the
   * ordinary button anywhere (the lesser one beside it, a standalone action or trigger),
   * `secondary` for a flat one repeated or dense (the same action on every row; never a filter or
   * an on/off control, which is a Toggle), `ghost` for
   * toolbars, rows and icon buttons, `destructive` for what cannot be undone, `success` for the yes
   * that approves or confirms (Approve on a request), `link` for an action that reads as words.
   * @default "default"
   */
  variant?: ButtonVariant;
  /**
   * Draw the one element given as the child (`<a href>`, a router's link) in its place, with the
   * button's look and behaviour. It keeps its own role: a link stays a link.
   * @default false
   */
  asChild?: boolean;
  /**
   * What the button does, said to the person when an agent asks to press it ("Deletes the
   * workspace and its files"). The agent's press waits for their yes. A `destructive` or `success`
   * button always asks: in its own words unless this says it better.
   */
  agentConfirm?: string;
  /**
   * Keeps it in the tab order while it cannot be pressed, so it holds focus and a tooltip that says
   * why. Pass it while it is loading, so focus stays on it.
   * @default false
   */
  focusableWhenDisabled?: boolean;
  /**
   * Out of use: no press, no hover, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Runs when it is pressed. Return a Promise and the Button follows it: busy, with a spinner and
   * no second press, until it settles; then a tick or the alert for a moment, said once to a screen
   * reader, and back to rest. A failure is caught and said, never thrown to the page.
   */
  onClick?: ComponentProps<typeof ButtonPrimitive>["onClick"];
  /** Said while its press works, and shown in place of its words ("Saving"). */
  loadingText?: string;
  /** Said once its press worked, and shown in place of its words for a moment ("Saved"). */
  successText?: string;
  /** Said when its press failed, and shown in place of its words for a moment ("Not saved"). */
  errorText?: string;
  /**
   * Where its work is, when the page runs it (a form's submit): the Button shows it and leaves
   * `onClick` alone. Whoever runs the work says how it went.
   */
  status?: ActionStatus;
  /**
   * Squeezed, the words stay on one line and end in an ellipsis instead of wrapping, and the button
   * may shrink to its square. They stay its name whole; give `tooltip` to show them whole to the
   * pointer. For a name in a narrow head, where a second line would push the next control off. An
   * icon-only button has no words to cut.
   * @default false
   */
  truncate?: boolean;
  /**
   * Its tooltip, under a resting pointer and on keyboard focus. Left out, a control that is only an
   * icon shows its `aria-label`; `false` shows none; words or a node show those in its place, on a
   * control with words too. Inside a Tooltip of your own it shows none.
   */
  tooltip?: ReactNode;
  /** Layout only: where it sits and how much room it takes. Its look belongs to `variant` and `size`. */
  style?: LayoutStyle;
}

/**
 * A button with words, and an icon before or after them if it helps.
 * @when with words
 */
interface WithWords extends ButtonBase {
  /**
   * The height: `xs` 28px, `sm` 32px, `default` 36px, `lg` 44px; an icon-only button is a square of
   * the same heights, `icon-xs`, `icon-sm`, `icon` and `icon-lg`. On a touch screen every size has
   * a 44px target. Named none, it is `sm` as a direct child of a Dialog, AlertDialog, Sheet or
   * Drawer footer, as the footer's Close is.
   * @default "default"
   */
  size?: Exclude<ButtonSize, IconSize>;
  /**
   * The words, a verb first in sentence case ("Save changes"), with an `<Icon />` before or after
   * them. Icon only: the `<Icon />`.
   */
  children: ReactNode;
}

/**
 * A button that is only an icon: square, named by `aria-label`.
 * @when icon only
 */
interface IconOnly extends ButtonBase {
  size: IconSize;
  /**
   * Its name, for a screen reader, a voice command and an agent ("More actions"). It shows in a
   * tooltip under a resting pointer and on keyboard focus.
   */
  "aria-label": string;
  children: ReactNode;
}

export type ButtonProps = WithWords | IconOnly;

// ---- The look ------------------------------------------------------------------------------------

// Hover only where a pointer can hover, so a tap never leaves a button lit.
const HOVER = media.hover;
const FORCED = media.forcedColors;

// A Button group's own items: never a layer a trigger in it draws inline (a Dropdown menu's list
// stands in the group, after its trigger, while open). Counted by :last-child, the trigger lost its
// end corner as its menu opened.
const ITEM =
  ':not([data-slot$="-content"], [data-slot$="-positioner"], [data-slot$="-backdrop"], [role=menu], [role=dialog], [role=listbox], [role=tooltip])';
const FIRST = `:nth-child(1 of ${ITEM})`;
const LAST = `:nth-last-child(1 of ${ITEM})`;

// A layer footer's own actions: its direct children, read from the page's tree, not React's, so a
// popup opened from the footer, drawn elsewhere or inside it, keeps its own sizes.
const FOOTERS =
  "[data-slot=dialog-footer], [data-slot=alert-dialog-footer], [data-slot=sheet-footer], [data-slot=drawer-footer]";
const FOOTER_ACTION = `:is(:is(${FOOTERS}) > *)`;

const styles = stylex.create({
  base: {
    // The icon inside follows these (lib/vars.stylex.ts).
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space["2"],
    flexShrink: 0,
    boxSizing: "border-box",
    maxWidth: "100%",
    margin: 0,
    // No border: the edge is the bevel's shadows, which add no size. Forced colours drop shadows,
    // so a real one appears there, in the system's button text colour.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: { default: "currentColor", [FORCED]: "ButtonText" },
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: "normal",
    textAlign: "center",
    textDecorationLine: "none",
    // A long label wraps between words, balanced, and breaks only a word longer than its column.
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    textWrapStyle: "balance",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    cursor: "pointer",
    transform: { default: null, ":active": `scale(${sizes.buttonPressScale})` },
    transitionProperty: "transform, background-color, box-shadow, color",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${motionVars.press}, ${duration.hover}, ${duration.hover}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
  },
  // In a layer's footer on a phone, every Button takes an equal part of the line, each at least as
  // wide as its words. After the size, so its width wins over the size's least width.
  inFooter: {
    flexGrow: {
      default: null,
      [stylex.when.ancestor(":is(*)", layerFooterMarker)]: {
        default: null,
        [media.maxSm]: 1,
      },
    },
    flexBasis: {
      default: null,
      [stylex.when.ancestor(":is(*)", layerFooterMarker)]: {
        default: null,
        [media.maxSm]: 0,
      },
    },
    // It may give way in a row that is short of room, whatever the page's reset says.
    minWidth: {
      default: 0,
      [stylex.when.ancestor(":is(*)", layerFooterMarker)]: {
        default: 0,
        [media.maxSm]: "fit-content",
      },
    },
  },
  // Inside a Button group: square between buttons, and at the group's ends its corner, so a
  // pressed fill sits inside the group's shape. Logical corners, so right to left holds too.
  inGroup: {
    borderStartStartRadius: {
      default: null,
      ":is([data-slot=button-group] > *)": 0,
      [`:is([data-slot=button-group] > ${FIRST})`]: "inherit",
    },
    borderEndEndRadius: {
      default: null,
      ":is([data-slot=button-group] > *)": 0,
      [`:is([data-slot=button-group] > ${LAST})`]: "inherit",
    },
    borderEndStartRadius: {
      default: null,
      ":is([data-slot=button-group] > *)": 0,
      [`:is([data-slot=button-group]:not([aria-orientation=vertical]) > ${FIRST}, [data-slot=button-group][aria-orientation=vertical] > ${LAST})`]:
        "inherit",
    },
    borderStartEndRadius: {
      default: null,
      ":is([data-slot=button-group] > *)": 0,
      [`:is([data-slot=button-group]:not([aria-orientation=vertical]) > ${LAST}, [data-slot=button-group][aria-orientation=vertical] > ${FIRST})`]:
        "inherit",
    },
  },
  // Not pressable now: no press.
  still: {
    transform: "none",
  },
  disabled: {
    opacity: sizes.opacityDisabled,
    cursor: "not-allowed",
    borderColor: { default: "currentColor", [FORCED]: "GrayText" },
  },
  // The default button out of use draws a quiet fill, not the full fill at half strength: at night
  // the full fill is near white, and dimmed it was still the brightest thing in a box that can do
  // nothing.
  defaultDisabled: {
    opacity: 1,
    color: { default: colors.primaryForegroundDisabled, [FORCED]: "GrayText" },
    backgroundColor: {
      default: colors.primaryDisabled,
      [FORCED]: "ButtonFace",
    },
    boxShadow: {
      default: `inset 0 0 0 ${sizes.hairline} ${colors.borderStrongColor}`,
      [FORCED]: "none",
    },
  },
  // Loading: it looks like itself, and the pointer says it is busy.
  busy: {
    cursor: "progress",
  },
  // Truncated: the button may shrink to its square floor (each size's minWidth), on one line.
  cut: {
    flexShrink: 1,
    whiteSpace: "nowrap",
  },
  // Failed, on every variant: calm. The quiet fill (no light over it), destructive words, a field's
  // edge tinted destructive, and one small shake. The alert and the words say it too, so it is never colour alone.
  failed: {
    color: { default: colors.destructive, [FORCED]: "ButtonText" },
    backgroundColor: colors.control,
    backgroundImage: "none",
    boxShadow: sizes.errorBorder,
    animationName: {
      default: stylex.keyframes({
        "0%, 100%": { transform: "none" },
        "25%": { transform: `translateX(calc(-1 * ${sizes.resultShake}))` },
        "50%": { transform: `translateX(${sizes.resultShake})` },
        "75%": { transform: `translateX(calc(-0.5 * ${sizes.resultShake}))` },
      }),
      [media.reducedMotion]: "none",
    },
    animationDuration: duration.ui,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: 1,
  },
  // In forced colours the focus ring is the system's highlight, apart from the border's ButtonText.
  forcedFocus: {
    outlineColor: {
      default: null,
      [FORCED]: { default: null, ":focus-visible": "Highlight" },
    },
  },
  // A ghost's ring in the colour the part that holds it gives (ghostVars), the system's in forced
  // colours. In place of forcedFocus, which sets the same property.
  ghostFocus: {
    outlineColor: {
      default: ghostVars.ring,
      [FORCED]: { default: null, ":focus-visible": "Highlight" },
    },
  },
  // Failed, a `link`: words with no box stay words. The destructive ink, and no underline to press.
  failedWords: {
    color: { default: colors.destructive, [FORCED]: "LinkText" },
    textDecorationLine: "none",
  },
  // The light over a filled button: white at the top, fading to nothing; brighter under a pointer.
  sheen: {
    position: "absolute",
    zIndex: -1,
    inset: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
    backgroundImage: `linear-gradient(${colors.buttonSheen}, transparent)`,
    opacity: 0.6,
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  sheenLive: {
    opacity: {
      default: 0.6,
      [stylex.when.ancestor(":hover", buttonMarker)]: {
        default: null,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(":active", buttonMarker)]: {
        default: 0.3,
        [HOVER]: 0.3,
      },
    },
  },
});

// Height comes from the line plus padding, so a wrapped label makes the button taller and never
// spills out. The corner is the one corner, capped at half the height. An icon size is a square.
const sizeStyles = stylex.create({
  xs: {
    minHeight: sizes.controlXs,
    minWidth: sizes.controlXs,
    paddingBlock: `calc((${sizes.controlXs} - ${font.textSmLine}) / 2)`,
    paddingInline: space["2"],
    borderRadius: `min(${radius.xl}, calc(${sizes.controlXs} / 2))`,
    cornerShape: radius.shape,
  },
  sm: {
    minHeight: sizes.controlSm,
    minWidth: sizes.controlSm,
    paddingBlock: `calc((${sizes.controlSm} - ${font.textSmLine}) / 2)`,
    paddingInline: space["3"],
    borderRadius: `min(${radius.xl}, calc(${sizes.controlSm} / 2))`,
    cornerShape: radius.shape,
  },
  default: {
    minHeight: sizes.controlDefault,
    minWidth: sizes.controlDefault,
    paddingBlock: `calc((${sizes.controlDefault} - ${font.textSmLine}) / 2)`,
    paddingInline: space["3"],
    borderRadius: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
    cornerShape: radius.shape,
  },
  lg: {
    // The large size's icon is the default one, with words or without.
    [iconVars.size]: sizes.iconDefault,
    minHeight: sizes.controlLg,
    minWidth: sizes.controlLg,
    paddingBlock: `calc((${sizes.controlLg} - ${font.textSmLine}) / 2)`,
    paddingInline: space["4"],
    borderRadius: `min(${radius.xl}, calc(${sizes.controlLg} / 2))`,
    cornerShape: radius.shape,
  },
  "icon-xs": {
    minHeight: sizes.controlXs,
    width: sizes.controlXs,
    paddingBlock: `calc((${sizes.controlXs} - ${font.textSmLine}) / 2)`,
    paddingInline: 0,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlXs} / 2))`,
    cornerShape: radius.shape,
  },
  "icon-sm": {
    minHeight: sizes.controlSm,
    width: sizes.controlSm,
    paddingBlock: `calc((${sizes.controlSm} - ${font.textSmLine}) / 2)`,
    paddingInline: 0,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlSm} / 2))`,
    cornerShape: radius.shape,
  },
  icon: {
    minHeight: sizes.controlDefault,
    width: sizes.controlDefault,
    paddingBlock: `calc((${sizes.controlDefault} - ${font.textSmLine}) / 2)`,
    paddingInline: 0,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
    cornerShape: radius.shape,
  },
  "icon-lg": {
    [iconVars.size]: sizes.iconDefault,
    minHeight: sizes.controlLg,
    width: sizes.controlLg,
    paddingBlock: `calc((${sizes.controlLg} - ${font.textSmLine}) / 2)`,
    paddingInline: 0,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlLg} / 2))`,
    cornerShape: radius.shape,
  },
});

// A Button that names no size: `default`, and as a layer footer's own action `sm`, as the footer's
// Close is, so its actions stand one height. An explicit size always wins: it takes sizeStyles.
const unsizedStyles = stylex.create({
  look: {
    minHeight: {
      default: sizes.controlDefault,
      [FOOTER_ACTION]: sizes.controlSm,
    },
    minWidth: {
      default: sizes.controlDefault,
      [FOOTER_ACTION]: sizes.controlSm,
    },
    paddingBlock: {
      default: `calc((${sizes.controlDefault} - ${font.textSmLine}) / 2)`,
      [FOOTER_ACTION]: `calc((${sizes.controlSm} - ${font.textSmLine}) / 2)`,
    },
    paddingInline: space["3"],
    borderRadius: {
      default: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
      [FOOTER_ACTION]: `min(${radius.xl}, calc(${sizes.controlSm} / 2))`,
    },
    cornerShape: radius.shape,
  },
});

// Each variant at rest; its hover and press are in liveStyles, left out while it cannot be pressed.
const variantStyles = stylex.create({
  default: {
    color: colors.primaryForeground,
    backgroundColor: colors.primary,
    boxShadow: shadow.bevelInk,
  },
  // A flat veil of ink, no edge and no lift: quieter than outline, firmer than ghost, for a repeated
  // or dense action where a row of edged, lifted buttons would be too heavy.
  secondary: {
    color: colors.foreground,
    backgroundColor: colors.secondary,
    boxShadow: "none",
  },
  destructive: {
    color: colors.destructiveFillForeground,
    backgroundColor: colors.destructiveFill,
    boxShadow: shadow.bevelDestructive,
  },
  // The yes that approves or confirms: a pane of the success light, mint deepened towards pine,
  // wider than the button so it can move: under a pointer it leans a step deeper, pressed it draws
  // to its deepest. Its fill is under it, for forced colours.
  success: {
    color: colors.successFillForeground,
    backgroundColor: colors.successFill,
    backgroundImage: { default: colors.successLight, [FORCED]: "none" },
    backgroundSize: sizes.successLightSize,
    backgroundPosition: sizes.successLightRest,
    boxShadow: shadow.bevelSuccess,
    transitionProperty:
      "transform, background-color, box-shadow, color, background-position",
    transitionDuration: `${motionVars.press}, ${duration.hover}, ${duration.hover}, ${duration.hover}, ${motionVars.mark}`,
  },
  // The ordinary button: the quiet fill, a field's edge and its lift, so it stands as tall as an
  // input beside it.
  outline: {
    color: colors.foreground,
    backgroundColor: colors.control,
    boxShadow: shadow.bevelMuted,
  },
  // Its ink, its fills and its ring's colour are ghostVars, which the part that holds it may set.
  ghost: {
    color: ghostVars.ink,
    // Held on (aria-pressed: a group's chosen view, a format toggle): the press's fill stays.
    backgroundColor: {
      default: "transparent",
      ":is([aria-pressed=true])": ghostVars.active,
    },
    boxShadow: "none",
  },
  // Words that act: underlined under a pointer, with no fill or edge.
  link: {
    color: colors.foreground,
    backgroundColor: "transparent",
    boxShadow: "none",
    textDecorationThickness: sizes.linkUnderlineWidth,
    textUnderlineOffset: sizes.linkUnderlineOffset,
    textDecorationColor: colors.linkUnderline,
  },
});

// The press is written under the hover's media query too: a hover inside a media query outranks a
// bare :active, and the pressed fill never showed under a mouse.
const liveStyles = stylex.create({
  default: {
    boxShadow: {
      default: shadow.bevelInk,
      ":hover": { default: null, [HOVER]: shadow.bevelInkHover },
      ":active": {
        default: shadow.bevelInkPress,
        [HOVER]: shadow.bevelInkPress,
      },
    },
    // Under a pointer the fill lightens a step as the bevel brightens; in dark it goes to white.
    backgroundColor: {
      default: colors.primary,
      ":hover": {
        default: null,
        [HOVER]: `light-dark(oklch(from ${colors.primary} calc(l + 0.08) c h), ${colors.primaryHover})`,
      },
      ":active": {
        default: colors.primaryActive,
        [HOVER]: colors.primaryActive,
      },
    },
  },
  secondary: {
    backgroundColor: {
      default: colors.secondary,
      ":hover": { default: null, [HOVER]: colors.secondaryHover },
      ":active": {
        default: colors.secondaryActive,
        [HOVER]: colors.secondaryActive,
      },
    },
  },
  destructive: {
    boxShadow: {
      default: shadow.bevelDestructive,
      ":hover": { default: null, [HOVER]: shadow.bevelDestructiveHover },
      ":active": {
        default: shadow.bevelDestructivePress,
        [HOVER]: shadow.bevelDestructivePress,
      },
    },
    backgroundColor: {
      default: colors.destructiveFill,
      ":hover": {
        default: null,
        [HOVER]: `oklch(from ${colors.destructiveFill} calc(l + 0.06) c h)`,
      },
      ":active": {
        default: colors.destructiveFillActive,
        [HOVER]: colors.destructiveFillActive,
      },
    },
  },
  success: {
    boxShadow: {
      default: shadow.bevelSuccess,
      ":hover": { default: null, [HOVER]: shadow.bevelSuccessHover },
      ":active": {
        default: shadow.bevelSuccessPress,
        [HOVER]: shadow.bevelSuccessPress,
      },
    },
    backgroundPosition: {
      default: sizes.successLightRest,
      ":hover": { default: null, [HOVER]: sizes.successLightLean },
      ":active": {
        default: sizes.successLightPress,
        [HOVER]: sizes.successLightPress,
      },
    },
  },
  outline: {
    backgroundColor: {
      default: colors.control,
      ":hover": { default: null, [HOVER]: colors.controlHover },
      ":active": {
        default: colors.controlActive,
        [HOVER]: colors.controlActive,
      },
    },
  },
  ghost: {
    backgroundColor: {
      default: "transparent",
      ":is([aria-pressed=true])": ghostVars.active,
      ":hover": {
        default: null,
        [HOVER]: ghostVars.hover,
        ":is([aria-pressed=true])": ghostVars.active,
      },
      ":active": { default: ghostVars.active, [HOVER]: ghostVars.active },
    },
  },
  link: {
    textDecorationLine: {
      default: "none",
      ":hover": { default: null, [HOVER]: "underline" },
    },
  },
});

/** The variants drawn on a fill, which carry the sheen. */
const filled = (variant: ButtonVariant) =>
  variant === "default" || variant === "destructive" || variant === "success";

/** Whether the element's props say its press failed (`data-status`, from `withStatus`). */
const hasFailed = (extra: Record<string, unknown>) =>
  extra["data-status"] === "error";

const lookOf = (
  variant: ButtonVariant,
  size: ButtonSize | undefined,
  pressable: boolean
) => [
  buttonMarker,
  styles.base,
  hyphenate,
  size === undefined ? unsizedStyles.look : sizeStyles[size],
  styles.inFooter,
  styles.inGroup,
  variantStyles[variant],
  pressable ? liveStyles[variant] : styles.still,
  focusRing,
  variant === "ghost" ? styles.ghostFocus : styles.forcedFocus,
];

/** A button's look, for an element that must look like one without being a Button. */
export const buttonVariants = ({
  variant = "default",
  size = "default",
}: { variant?: ButtonVariant; size?: ButtonSize } = {}): stylex.StyleXStyles =>
  lookOf(variant, size, true);

// ---- The parts -------------------------------------------------------------------------------------

/** The words an agent is told before its press runs, when it must ask. */
interface AgentWords {
  agentAsks: string;
  agentPresses: (words: string) => string;
}

/**
 * What an agent is told before its press runs: `agentConfirm`, or the part's own. A destructive
 * button, and a success one (the yes that approves), always asks, in its own words, unless it only
 * opens something (a dialog's trigger): the action inside asks.
 */
const confirmFor = (
  variant: ButtonVariant,
  given: unknown,
  extra: Record<string, unknown>,
  words: unknown,
  said: AgentWords
) => {
  if (typeof given === "string") {
    return given;
  }
  const slot = extra["data-slot"];
  const popup = extra["aria-haspopup"];
  const opens =
    (typeof slot === "string" && slot.endsWith("-trigger")) ||
    (popup !== undefined && popup !== false && popup !== "false");
  const own =
    typeof words === "string" && words !== ""
      ? said.agentPresses(words)
      : said.agentAsks;
  return (variant === "destructive" || variant === "success") && !opens
    ? own
    : undefined;
};

/** The button's own props: its look, its slot, its variant and size, and what an agent is told. */
const ownOf = (
  {
    variant,
    size,
    disabled,
    truncate,
    style,
  }: Required<Pick<ButtonBase, "variant" | "disabled" | "truncate">> &
    Pick<ButtonBase, "style"> & { size: ButtonSize | undefined },
  extra: Record<string, unknown>,
  agentConfirm: string | undefined,
  words: unknown,
  said: AgentWords
) => {
  // Drawn by another part (a dialog's trigger), the element keeps that part's slot, which its own
  // selectors and the page's read, and says it is a Button with data-button.
  const part =
    typeof extra["data-slot"] === "string" ? extra["data-slot"] : undefined;
  const busy = isInvalid(extra["aria-busy"]);
  return {
    ...stylex.props(
      lookOf(variant, size, !disabled),
      truncate && styles.cut,
      disabled && !busy && styles.disabled,
      disabled && !busy && variant === "default" && styles.defaultDisabled,
      busy && styles.busy,
      hasFailed(extra) &&
        (variant === "link" ? styles.failedWords : styles.failed),
      style
    ),
    "data-slot": part ?? "button",
    "data-button": part === undefined ? undefined : "",
    "data-variant": variant,
    "data-size": size ?? "default",
    "data-agent-confirm": confirmFor(
      variant,
      agentConfirm ?? extra["data-agent-confirm"],
      extra,
      words,
      said
    ),
  };
};

/** The sheen over a filled button, and the touch target. */
const Inside = ({
  variant,
  pressable,
  failed,
}: {
  variant: ButtonVariant;
  pressable: boolean;
  failed: boolean;
}) => (
  <>
    {filled(variant) && !failed && (
      <span
        aria-hidden="true"
        {...stylex.props(styles.sheen, pressable && styles.sheenLive)}
      />
    )}
    <span aria-hidden="true" {...stylex.props(tapTarget)} />
  </>
);

type Child = ReactElement<{ children?: ReactNode }>;

/**
 * The element given with `asChild`, or a plain <button> when another part draws the Button: the
 * face's props merged onto it (its own win, its handlers both run), with the sheen and the touch
 * target before its children.
 */
const Face = ({
  element,
  face,
  inside,
  words,
  children,
}: {
  element: Child | undefined;
  face: Record<string, unknown>;
  inside: ReactNode;
  /** Draws the words with the press's state round them. */
  words: (content: ReactNode) => ReactNode;
  children?: ReactNode;
}) => {
  if (element === undefined) {
    return (
      <button type="button" {...face}>
        {inside}
        {words(children)}
      </button>
    );
  }
  const { type: Element, props } = element;
  return (
    <Element {...mergeProps(face, props)}>
      {inside}
      {words(props.children)}
    </Element>
  );
};

// ---- A press that takes time ----------------------------------------------------------------------

/** What the Button waits on: the Promise its `onClick` gave. */
const waitFor = async (work: PromiseLike<unknown>) => await work;

/**
 * The end of a press's run, for UI SDK's Button, which stays pending until it settles, and for an
 * agent's press: a failure rejects with its words, so the agent hears it failed.
 */
const reported = async (
  run: Promise<ActionResult<unknown>>,
  failed: string
) => {
  const result = await run;
  if (!result.ok && !("busy" in result)) {
    throw new Error(failed);
  }
};

const statusStyles = stylex.create({
  // The words, as they are, while it rests: the box adds nothing to the button's own layout.
  contents: {
    display: "contents",
  },
  // The words while a mark stands over them: still in their place, and still its name for a
  // screen reader, but not seen.
  unseen: {
    color: "transparent",
  },
  // Truncated: the content is a row of its own that may shrink, its icons whole and its words cut.
  cutRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    maxWidth: "100%",
  },
  cutWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A state's mark, centred over the words.
  mark: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    animationName: stylex.keyframes({
      from: { opacity: 0, transform: `scale(${sizes.resultMarkFrom})` },
      to: { opacity: 1, transform: "none" },
    }),
    animationDuration: motionVars.mark,
    animationTimingFunction: duration.ease,
  },
  // With words for a state: every state in one cell, on top of each other, so the widest sets the
  // width. Only one is seen.
  stack: {
    display: "inline-grid",
    alignItems: "center",
    justifyItems: "center",
    minWidth: 0,
    maxWidth: "100%",
  },
  layer: {
    gridArea: "1 / 1",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space["2"],
    minWidth: 0,
    maxWidth: "100%",
    transitionProperty: "opacity, visibility",
    transitionDuration: motionVars.swap,
    transitionTimingFunction: duration.ease,
  },
  // A state that is not showing only keeps its width, on one line: wrapped, an unseen "Not saved"
  // made a button in a narrow footer taller than the one beside it.
  gone: {
    opacity: 0,
    visibility: "hidden",
    whiteSpace: "nowrap",
  },
  // The words while a mark with no words of its own stands over them: unseen, still its name.
  faded: {
    opacity: 0,
    whiteSpace: "nowrap",
  },
  // The tick's room, kept at rest by words with no icon, half at each side so they stay centred:
  // once the work went well the tick and its gap stand there, and the width never changes.
  tickRoom: {
    paddingInline: `calc((${iconVars.size} + ${space["2"]}) / 2)`,
  },
  // The room a state's mark takes beside its words, while another state shows; and the spinner
  // where the button's icon stood, centred in the icon's own box so the words do not move.
  place: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: iconVars.size,
    height: iconVars.size,
  },
});

type Labels = Partial<Record<Exclude<ActionStatus, "idle">, string>>;

/** A state's mark: the spinner while it works, a tick, the alert. */
const Mark = ({ status }: { status: Exclude<ActionStatus, "idle"> }) => {
  if (status === "loading") {
    return <Spinner />;
  }
  return <Icon icon={status === "success" ? CheckIcon : CircleAlertIcon} />;
};

/**
 * The button's content while it works, when it has an icon: the spinner in the icon's place, the
 * words as they were. Without an icon, nothing: the mark stands over the words instead.
 */
const spinning = (children: ReactNode) => {
  const parts = listOf(children);
  const at = parts.findIndex(
    (part) => isValidElement(part) && part.type === Icon
  );
  return at === -1
    ? undefined
    : parts.with(
        at,
        <span
          key="spinner"
          data-slot="button-spinner"
          {...stylex.props(statusStyles.place)}
        >
          <Spinner />
        </span>
      );
};

/**
 * The button's content once its work went well, with no words of its own for it: the tick in the
 * icon's place, or before the words when it has no icon. The words are the same nodes as at rest.
 */
const ticked = (children: ReactNode, iconed: boolean): ReactNode[] => {
  const parts = listOf(children);
  const tick = (
    <span
      key="tick"
      data-slot="button-tick"
      {...stylex.props(statusStyles.place)}
    >
      <Icon icon={CheckIcon} />
    </span>
  );
  if (!iconed) {
    return [tick, ...parts];
  }
  const at = parts.findIndex(
    (part) => isValidElement(part) && part.type === Icon
  );
  return parts.with(at, tick);
};

/**
 * What a state draws in the words' own layer, or nothing when it draws a layer or a mark of its
 * own: the spinner where the icon stood while it works with no words for it; the tick once it
 * worked, where the words keep its room.
 */
const inPlaceOf = (
  status: ActionStatus,
  label: string | undefined,
  tickRoom: boolean,
  iconed: boolean,
  children: ReactNode
): ReactNode => {
  if (status === "loading" && label === undefined) {
    return spinning(children);
  }
  return status === "success" && tickRoom
    ? ticked(children, iconed)
    : undefined;
};

/** The content with each run of words in a box that cuts them with an ellipsis (`truncate`). */
const cutWords = (children: ReactNode): ReactNode[] =>
  listOf(children).map((child, index): ReactNode =>
    typeof child === "string" || typeof child === "number" ? (
      // Words have no id of their own; their place among the icons is their key.
      <span key={index} {...stylex.props(statusStyles.cutWords)}>
        {child}
      </span>
    ) : (
      child
    )
  );

/**
 * The words, and over them the state's mark; with words for a state, every state stacked in one
 * cell. Mounted only while it shows, a mark never turns unseen.
 */
const Status = ({
  status,
  labels,
  truncate,
  children: given,
}: {
  status: ActionStatus;
  labels: Labels;
  truncate: boolean;
  children: ReactNode;
}) => {
  const stacked = Object.values(labels).some((each) => each !== undefined);
  const label = status === "idle" ? undefined : labels[status];
  // Laid out with its states side by side, success with no words of its own is the tick before the
  // button's own words, as the original's done state: drawn in the words' own layer (the words are
  // never drawn twice), in the icon's place, or with no icon in the room the words keep at rest.
  const tickRoom = stacked && labels.success === undefined;
  const iconed = listOf(given).some(
    (part) => isValidElement(part) && part.type === Icon
  );
  const inPlace = inPlaceOf(status, label, tickRoom, iconed, given);
  const resting = status === "idle" || inPlace !== undefined;
  const content = inPlace ?? given;
  const children = truncate ? cutWords(content) : content;
  const mark =
    resting || label !== undefined ? null : (
      <span aria-hidden="true" {...stylex.props(statusStyles.mark)}>
        <Mark status={status} />
      </span>
    );
  if (!stacked) {
    return (
      <>
        <span
          data-slot="button-content"
          {...stylex.props(
            truncate ? statusStyles.cutRow : statusStyles.contents,
            !resting && statusStyles.unseen
          )}
        >
          {children}
        </span>
        {mark}
      </>
    );
  }
  return (
    <>
      <span data-slot="button-content" {...stylex.props(statusStyles.stack)}>
        <span
          aria-hidden={label === undefined ? undefined : true}
          {...stylex.props(
            statusStyles.layer,
            tickRoom &&
              !iconed &&
              status !== "success" &&
              statusStyles.tickRoom,
            !resting &&
              (label === undefined ? statusStyles.faded : statusStyles.gone)
          )}
        >
          {children}
        </span>
        {(["loading", "success", "error"] as const).map((each) =>
          labels[each] === undefined ? null : (
            <span
              key={each}
              aria-hidden={status === each ? undefined : true}
              {...stylex.props(
                statusStyles.layer,
                status !== each && statusStyles.gone
              )}
            >
              {status === each ? (
                <Mark status={each} />
              ) : (
                <span {...stylex.props(statusStyles.place)} />
              )}
              {labels[each]}
            </span>
          )
        )}
      </span>
      {mark}
    </>
  );
};

/** The button's own props with where its press is: busy while it works, and `data-status`. */
const withStatus = (
  rest: Record<string, unknown>,
  status: ActionStatus
): Record<string, unknown> => ({
  ...rest,
  "aria-busy": status === "loading" ? true : rest["aria-busy"],
  "data-status": status === "idle" ? undefined : status,
});

/**
 * A press whose `onClick` gives a Promise, followed: where it is, and the handler for UI SDK's
 * Button. With `held`, the page's status, and `onClick` as it is.
 */
const usePress = (
  onClick: ButtonBase["onClick"],
  held: ActionStatus | undefined,
  labels: Labels
) => {
  const action = useAction(waitFor, {
    loadingText: labels.loading,
    successText: labels.success,
    errorText: labels.error,
  });
  if (held !== undefined) {
    return { status: held, press: onClick };
  }
  const press: ButtonBase["onClick"] = (event, details) => {
    // While it works or shows how it went, a press does nothing.
    if (action.status !== "idle") {
      event.preventDefault();
      return null;
    }
    const result = onClick?.(event, details);
    return isThenable(result)
      ? reported(action.run(result), action.labels.error)
      : result;
  };
  return { status: action.status, press };
};

const Pressable = ({
  variant = "default",
  size,
  asChild = false,
  agentConfirm,
  disabled = false,
  focusableWhenDisabled = false,
  pendingAnnouncement = "",
  loadingText,
  successText,
  errorText,
  status: held,
  tooltip: _tooltip,
  onClick,
  style,
  truncate = false,
  children,
  ...rest
}: ButtonProps) => {
  const { agentAsks, agentPresses } = useI18n().action;
  const { status, press } = usePress(onClick, held, {
    loading: loadingText,
    success: successText,
    error: errorText,
  });
  const working = status === "loading";
  const extra = withStatus(rest, status);
  const off = disabled || working;
  const own = ownOf(
    { variant, size, disabled: off, truncate, style },
    extra,
    agentConfirm,
    textOf(children) || extra["aria-label"],
    { agentAsks, agentPresses }
  );
  const inside = (
    <Inside variant={variant} pressable={!off} failed={hasFailed(extra)} />
  );
  const element =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  // An icon-only button keeps its square: its words are said, never shown.
  const words = (content: ReactNode) => (
    <Status
      status={status}
      truncate={truncate}
      labels={
        isIconSize(size)
          ? {}
          : { loading: loadingText, success: successText, error: errorText }
      }
    >
      {content}
    </Status>
  );
  // Kept in focus while it works, so focus stays on it.
  const focusable = focusableWhenDisabled || working;

  if (typeof extra["data-slot"] === "string") {
    // Drawn by another UI SDK part: only its face, on the part's own element. The part's own
    // click (a popover trigger's open) runs only while the button can be pressed: kept in focus
    // with `focusableWhenDisabled`, the element is not disabled, so the guard is ours.
    const face: Record<string, unknown> = {
      ...extra,
      ...own,
      onClick: (...args: Parameters<NonNullable<typeof onClick>>) => {
        if (off) {
          args[0].preventDefault();
          return null;
        }
        return press?.(...args);
      },
      disabled: off && !focusable ? true : undefined,
      "aria-disabled": off && focusable ? true : extra["aria-disabled"],
    };
    return (
      <Face element={element} face={face} inside={inside} words={words}>
        {children}
      </Face>
    );
  }
  return (
    <ButtonPrimitive
      {...extra}
      {...own}
      onClick={press}
      render={
        element === undefined
          ? undefined
          : (props: Record<string, unknown>) => (
              <Face
                element={element}
                face={props}
                inside={inside}
                words={words}
              />
            )
      }
      disabled={off}
      focusableWhenDisabled={focusable}
      // Silent by default: hooks/use-action says a press's life once, by the page's one voice.
      pendingAnnouncement={pendingAnnouncement}
    >
      {element === undefined && (
        <>
          {inside}
          {words(children)}
        </>
      )}
    </ButtonPrimitive>
  );
};

export const Button = (props: ButtonProps) => (
  <ControlTooltip
    tooltip={props.tooltip}
    iconOnly={isIconSize(props.size ?? "default")}
  >
    <Pressable {...props} />
  </ControlTooltip>
);
