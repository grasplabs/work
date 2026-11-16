// Button: Grasp's button, from shadcn's (registry/bases/base/ui/button.tsx), converted from Tailwind
// to StyleX and then made Grasp's: the website's Bevel finish, one corner, and the whole life of an
// action on the control itself. Its behaviour is UI SDK's Button, so an agent on the page finds it by
// its name and presses it (site/behaviour/agent.ts). A danger or approve button waits for the person's
// yes before an agent's press runs; a press while it shows its result fails with a message.
//
//   <Button variant="ink">Save changes</Button>
//   <Button variant="approve">Approve the plan</Button>
//   <Button icon={Plus}>Invite people</Button>
//   <Button icon={More} label="More actions" />          icon only: the label is its name
//   <Button render={<a href="/settings" />}>Settings</Button>   a link that looks like a button
//   <Button variant="ink" {...save.props}>Save changes</Button> with useAction (use-action.ts)
//   <Button variant="danger" agentConfirm="Deletes the workspace">Delete</Button>
//
// Drawn by another UI SDK part (a dialog's trigger, a toast's action), it takes that part's props
// and is only its face: one element is never two UI SDK buttons, which an agent would see twice.
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import type { ButtonActionDetails } from "@ui-sdk/react/button";
import {
  Suspense,
  isValidElement,
  lazy,
  useContext,
  useEffect,
  useRef,
} from "react";
import type {
  ComponentProps,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";

import { announce } from "../announce/announce";
import { focus } from "../focus/focus";
import { Failed, Icon, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { Spinner } from "../spinner";
import { spinnerVars } from "../spinner/spinner.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { buttonMarker, layerMarker } from "./button.stylex";
import { HoldFill, holdLook } from "./hold-fill";
import { HoldContext, assignRef, englishHoldLabels } from "./use-hold";
import type { ButtonHoldLabels, HoldLook, HoldSetting } from "./use-hold";

export type ButtonVariant = "ink" | "quiet" | "ghost" | "danger" | "approve";
export type ButtonSize = "xs" | "sm" | "md" | "lg";
/** Where an action is: at rest, working on it, done, or failed. */
export type ActionState = "idle" | "working" | "done" | "failed";

type Layout = string | number | null;

/**
 * A floor that follows the words, never a fixed width: `fit-content` keeps a growing button from
 * wrapping its words while they fit the line, so a row of equal buttons wraps before a label does.
 */
type ContentFloor =
  | "fit-content"
  | "max-content"
  | "min-content"
  | "auto"
  | 0
  | null;

/** What a caller may style: where the button sits. Never its look, and never a fixed width. */
export type ButtonLayoutStyle = stylex.StyleXStyles<{
  minWidth?: ContentFloor;
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexGrow?: Layout;
  flexShrink?: Layout;
  flexBasis?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  order?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockStart?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
  marginInlineStart?: Layout;
  marginInlineEnd?: Layout;
}>;

/**
 * The words on a button. Text or elements, never empty: `false`, `null` and `""` are not words,
 * so `children={ready && "Save"}` does not type-check and a button cannot lose its name.
 */
export type ButtonWords =
  | string
  | number
  | ReactElement
  | readonly (string | number | ReactElement)[];

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from ButtonProps, the union below, so they cannot drift from what the code accepts.

/**
 * A button with words, and an icon before or after them if it helps.
 */
interface WithWords {
  /** The words on the button: a verb first, in sentence case ("Save changes"). */
  children: ButtonWords;
  /** An icon before the words, or the whole button with `label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** An icon after the words: an arrow that leads on. */
  iconEnd?: IconData;
  label?: never;
}

/**
 * A button that is only an icon. It is square, and `label` is its name.
 */
interface IconOnly {
  children?: never;
  icon: IconData;
  iconEnd?: never;
  /** The name of an icon-only button, for a screen reader and a voice command ("More actions"). */
  label: string;
}

/** What every button takes. */
interface ButtonBase {
  /**
   * The weight of the action. `ink` for the one step you want taken, `quiet` for the others,
   * `ghost` for toolbars and rows, `danger` for an action that deletes, `approve` for the one
   * that approves or confirms.
   * @default "quiet"
   */
  variant?: ButtonVariant;
  /**
   * The height: `xs` 28px, `sm` 32px, `md` 36px, `lg` 44px. On a touch screen every size has a 44px target.
   * @default "md"
   */
  size?: ButtonSize;
  /**
   * Render another element in its place, with the button's look: `<a href>` or a router's link.
   * It keeps its own role: a link stays a link.
   */
  render?: ReactElement<Record<string, unknown>>;
  /**
   * What the button does, said to the person when an agent asks to press it ("Deletes the
   * workspace and its files"). The agent's press waits for their yes. A `danger` or `approve`
   * button always asks: in its own words unless this says it better.
   */
  agentConfirm?: string;
  /**
   * Keeps it in the tab order while it cannot be pressed, so it can hold focus and a tooltip that
   * says why. A working button does so on its own.
   * @default false
   */
  focusableWhenDisabled?: boolean;
  /**
   * Out of use: no press, no hover, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: margins, alignment, and a floor that follows the words (`minWidth: "fit-content"`). Colours, sizes, corners and widths belong to the button. */
  style?: ButtonLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: ButtonLayoutStyle;
  /**
   * Hold to confirm, for what cannot be undone but is not grave (delete a draft): the action runs
   * once the press has lasted {hold-duration}, or `{ ms }`. A click or a tap asks in a popover.
   * @default false
   */
  hold?: HoldSetting;
  /**
   * What a hold says, any of it replaced: the name while held, the confirmation's title and Cancel.
   * @default { holdTo: (words) => `Hold to ${words}`, ask: (words) => `${words}?`, confirm: "Confirm", cancel: "Cancel" }
   */
  holdLabels?: Partial<ButtonHoldLabels>;
}

/** A plain button: it does its work and the page shows the result. */
interface WithoutLife {
  state?: undefined;
  workingLabel?: never;
  doneLabel?: never;
  failedLabel?: never;
}

/**
 * A button that shows the life of its action. useAction() returns all four props.
 */
interface WithLife {
  /**
   * Where the action is: `idle`, `working`, `done` or `failed`. While working, it cannot be
   * pressed again. Comes from useAction().
   */
  state: ActionState;
  /**
   * Said to a screen reader while it works ("Saving"). Not shown: the spinner shows that it works,
   * and the button keeps its own words.
   */
  workingLabel?: string;
  /** The words once it worked, shown after a tick and said to a screen reader ("Saved"). */
  doneLabel: string;
  /** The words when it failed, said plainly ("Could not save"). */
  failedLabel: string;
}

type Shared = Omit<
  ComponentProps<typeof ButtonPrimitive>,
  | "className"
  | "style"
  | "render"
  | "children"
  | "disabled"
  | "focusableWhenDisabled"
> &
  ButtonBase;

/** Every prop a Button takes: the ones above, and the rest of UI SDK's Button and a <button>. */
export type ButtonProps = Shared &
  (WithWords | IconOnly) &
  (WithoutLife | WithLife);

// ---- The look --------------------------------------------------------------------------------------

// Hover only where a pointer can hover, so a tap never leaves a button lit.
const HOVER = media.hover;
const REDUCED = media.reduced;
const COARSE = media.coarse;
const FORCED = media.forced;

// A failed button shakes once, a few pixels, and settles where it was.
const shake = stylex.keyframes({
  "0%, 100%": { transform: "none" },
  "25%": { transform: `translateX(calc(-1 * ${grasp.resultShake}))` },
  "50%": { transform: `translateX(${grasp.resultShake})` },
  "75%": { transform: `translateX(calc(-0.5 * ${grasp.resultShake}))` },
});

const styles = stylex.create({
  base: {
    // The icon inside follows these (the icons entry (`@/components/grasp/icons`)/icon.stylex.ts).
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    maxWidth: "100%",
    margin: 0,
    // No border: the edge is drawn by the bevel's shadows, which add no size. In forced colours
    // shadows are dropped, so a real one appears there, in the system's button text colour in
    // every variant and state (GrayText when disabled, below).
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: { default: "currentColor", [FORCED]: "ButtonText" },
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: "normal",
    textAlign: "center",
    textDecorationLine: "none",
    // A long label wraps between words (balanced), and only breaks a word longer than the
    // column it stands in. It is never cut off.
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    hyphens: "auto",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    cursor: "pointer",
    // Focus is focus.ring (src/focus), last in the props below.
    transform: { default: null, ":active": `scale(${grasp.pressScale})` },
    transitionProperty: "transform, background-color, box-shadow, color",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${simply.press}, ${grasp.durationHover}, ${grasp.durationHover}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
  },

  // Sizes. Height comes from the line plus padding, so a wrapped label makes the button taller
  // and never spills out. The corner is the one corner, capped at half the height.
  xs: {
    minHeight: grasp.controlXs,
    minWidth: grasp.controlXs,
    paddingBlock: `calc((${grasp.controlXs} - ${grasp.textSmLine}) / 2)`,
    paddingInline: grasp.space2,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
  },
  sm: {
    minHeight: grasp.controlSm,
    minWidth: grasp.controlSm,
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.textSmLine}) / 2)`,
    paddingInline: grasp.space3,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  md: {
    minHeight: grasp.controlMd,
    minWidth: grasp.controlMd,
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.textSmLine}) / 2)`,
    paddingInline: grasp.space3,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
  },
  lg: {
    // The large size's icon is the medium one (eyes-a, A-actions-11: an icon-only large button kept
    // the small icon in a larger square). With words too, so the two sizes read as one family.
    [iconVars.size]: grasp.iconMd,
    minHeight: grasp.controlLg,
    minWidth: grasp.controlLg,
    paddingBlock: `calc((${grasp.controlLg} - ${grasp.textSmLine}) / 2)`,
    paddingInline: grasp.space4,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
  },
  // Icon only: a square of the same height.
  square: {
    paddingInline: 0,
  },
  squareXs: { width: grasp.controlXs },
  squareSm: { width: grasp.controlSm },
  squareMd: { width: grasp.controlMd },
  squareLg: { width: grasp.controlLg },

  // Variants, at rest. `live` adds hover and press; a button that is disabled, working or
  // showing a result gets only the rest.
  ink: {
    // On the fill a working spinner's last bars stay seen (Spinner's floor).
    [spinnerVars.floor]: grasp.spinnerFadeOnFill,
    color: grasp.actionText,
    backgroundColor: grasp.actionFill,
    boxShadow: grasp.bevelInk,
  },
  inkLive: {
    boxShadow: {
      default: grasp.bevelInk,
      ":hover": { default: null, [HOVER]: grasp.bevelInkHover },
      ":active": grasp.bevelInkPress,
    },
    backgroundColor: {
      default: grasp.actionFill,
      ":hover": { default: null, [HOVER]: grasp.actionFillHover },
      ":active": grasp.actionFillPress,
    },
  },
  quiet: {
    color: grasp.ink,
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.bevelQuiet,
  },
  quietLive: {
    backgroundColor: {
      default: grasp.quietFill,
      ":hover": { default: null, [HOVER]: grasp.quietFillHover },
      ":active": grasp.quietFillPress,
    },
  },
  ghost: {
    color: grasp.ink,
    // Held on (aria-pressed, a Button group's chosen view or a format toggle): the press's fill stays,
    // so a held choice is seen on the button itself, not only in what it changes.
    backgroundColor: {
      default: "transparent",
      ":is([aria-pressed=true])": grasp.ghostFillPress,
    },
    boxShadow: "none",
  },
  ghostLive: {
    backgroundColor: {
      default: "transparent",
      ":is([aria-pressed=true])": grasp.ghostFillPress,
      ":hover": {
        default: null,
        [HOVER]: grasp.ghostFillHover,
        ":is([aria-pressed=true])": grasp.ghostFillPress,
      },
      ":active": grasp.ghostFillPress,
    },
  },
  danger: {
    // On the fill a working spinner's last bars stay seen (Spinner's floor).
    [spinnerVars.floor]: grasp.spinnerFadeOnFill,
    color: grasp.dangerText,
    backgroundColor: grasp.dangerFill,
    boxShadow: grasp.bevelDanger,
  },
  dangerLive: {
    boxShadow: {
      default: grasp.bevelDanger,
      ":hover": { default: null, [HOVER]: grasp.bevelDangerHover },
      ":active": grasp.bevelDangerPress,
    },
    // A press also deepens the fill, so it shows beyond the scale. Hover stays on the drop.
    backgroundColor: {
      default: grasp.dangerFill,
      ":active": grasp.dangerFillPress,
    },
  },
  // Approve stands in a pane of the light, the website's glass: lime at the edge, through sea,
  // into mint. The light is wider than the button, so it can move: under a pointer it leans in,
  // pressed it draws back. Its fill is under it, for forced colours and a failed action.
  approve: {
    // On the fill a working spinner's last bars stay seen (Spinner's floor).
    [spinnerVars.floor]: grasp.spinnerFadeOnFill,
    color: grasp.approveText,
    backgroundColor: grasp.approveFill,
    backgroundImage: grasp.approveLight,
    backgroundSize: grasp.approveLightSize,
    backgroundPosition: grasp.approveLightRest,
    boxShadow: grasp.bevelApprove,
    // The base's four, then the light. With reduced motion the light moves at once.
    transitionProperty:
      "transform, background-color, box-shadow, color, background-position",
    transitionDuration: `${simply.press}, ${grasp.durationHover}, ${grasp.durationHover}, ${grasp.durationHover}, ${simply.lean}`,
  },
  approveLive: {
    boxShadow: {
      default: grasp.bevelApprove,
      ":hover": { default: null, [HOVER]: grasp.bevelApproveHover },
      ":active": grasp.bevelApprovePress,
    },
    backgroundPosition: {
      default: grasp.approveLightRest,
      ":hover": { default: null, [HOVER]: grasp.approveLightLean },
      ":active": grasp.approveLightPress,
    },
  },

  // Not pressable now: no press, no hover (the live styles are left out).
  still: {
    transform: "none",
  },
  disabled: {
    opacity: grasp.dim,
    cursor: "not-allowed",
    borderColor: { default: "currentColor", [FORCED]: "GrayText" },
  },
  // Working or showing a result: it looks like itself, and the pointer says it is busy.
  busy: {
    cursor: "progress",
  },
  // In forced colours the focus ring is the system's highlight, apart from the border's ButtonText.
  // It comes after focus.ring; a longhand outranks its outline shorthand.
  forcedFocus: {
    outlineColor: {
      default: null,
      [FORCED]: { default: null, ":focus-visible": "Highlight" },
    },
  },
  // Failed, on every variant: calm. The quiet fill, danger words, a field's edge tinted danger,
  // and one small shake. The alert icon and the words say it too, so it is never colour alone.
  failed: {
    color: grasp.failedText,
    backgroundColor: grasp.failedFill,
    backgroundImage: "none",
    boxShadow: grasp.failedEdge,
    animationName: { default: shake, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: 1,
  },

  // The light over a filled button: white at the top, fading to nothing. It brightens under a
  // pointer. A real element (not ::before), so StyleX keeps one rule per value.
  sheen: {
    position: "absolute",
    zIndex: -1,
    inset: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
    backgroundImage: `linear-gradient(${grasp.sheen}, transparent)`,
    opacity: 0.6,
    pointerEvents: "none",
    transitionProperty: "opacity",
    // Its light brightening is a fade: with reduced motion, simply there.
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  sheenGone: {
    opacity: 0,
  },
  sheenLive: {
    opacity: {
      default: 0.6,
      [stylex.when.ancestor(":hover", buttonMarker)]: {
        default: null,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(":active", buttonMarker)]: 0.3,
    },
  },

  // A finger needs 44px: on a touch screen an invisible area makes up the difference, with
  // nothing to see.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: 0,
  },
  targetXs: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlXs} - ${grasp.tap}) / 2)`,
    },
  },
  targetSm: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  targetMd: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlMd} - ${grasp.tap}) / 2)`,
    },
  },
  targetLg: { insetBlock: 0 },
  targetSquareXs: {
    insetInline: {
      default: 0,
      [COARSE]: `calc((${grasp.controlXs} - ${grasp.tap}) / 2)`,
    },
  },
  targetSquareSm: {
    insetInline: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  targetSquareMd: {
    insetInline: {
      default: 0,
      [COARSE]: `calc((${grasp.controlMd} - ${grasp.tap}) / 2)`,
    },
  },

  // The words of every state stand in one cell, on top of each other, so the button is as wide
  // as its widest state and keeps that width while the words change. Only one is seen.
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
    gap: grasp.space2,
    minWidth: 0,
    maxWidth: "100%",
    transitionProperty: "opacity, filter, transform, visibility",
    // With reduced motion a state is simply there (src/motion/simply.stylex.ts).
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
  },
  shown: {
    opacity: 1,
    visibility: "visible",
    filter: "none",
    transform: "none",
  },
  // A state that is not showing only reserves width. It must never wrap: a wrapped, unseen
  // "Could not archive" in a narrow footer once made the button 52px tall beside a 32px Cancel.
  // States swap by a fade alone, as Palermo's.
  gone: {
    opacity: 0,
    visibility: "hidden",
    whiteSpace: "nowrap",
  },
  // The resting words while the action works: faded out but still there, so the button keeps its
  // width and a screen reader still has its name. The spinner stands over them.
  faded: {
    opacity: 0,
    visibility: "visible",
    whiteSpace: "nowrap",
  },
  // A result arriving where the spinner was: its mark is drawn in at once, then its words slide in
  // beside it. Both leave by the layer's own fade. With reduced motion they are simply there.
  resultMark: {
    display: "inline-flex",
    flexShrink: 0,
    opacity: {
      default: 0,
      [stylex.when.ancestor("[data-shown]", layerMarker)]: 1,
    },
    transform: {
      default: `scale(${grasp.resultMarkFrom})`,
      [stylex.when.ancestor("[data-shown]", layerMarker)]: "none",
      [REDUCED]: "none",
    },
    transitionProperty: "opacity, transform",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  resultWords: {
    "--grasp-line-sign": { default: "1", ":dir(rtl)": "-1" },
    opacity: {
      default: 0,
      [stylex.when.ancestor("[data-shown]", layerMarker)]: 1,
    },
    transform: {
      // From the start side: --grasp-line-sign is -1 right to left.
      default: `translateX(calc(-1 * ${grasp.resultShift} * var(--grasp-line-sign, 1)))`,
      [stylex.when.ancestor("[data-shown]", layerMarker)]: "none",
      [REDUCED]: "none",
    },
    transitionProperty: "opacity, transform",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
    transitionDelay: {
      default: "0s",
      [stylex.when.ancestor("[data-shown]", layerMarker)]: simply.follow,
    },
  },
  words: {
    minWidth: 0,
    // Only the style of wrapping: the text-wrap shorthand would also set text-wrap-mode to wrap and
    // undo a hidden layer's nowrap, so an unseen "Archiving" wrapped and made a button 132px tall.
    textWrapStyle: "balance",
  },
  // Beside an icon, wrapped words read from the icon's side, not from the middle.
  wordsBeside: {
    textAlign: "start",
  },
});

const variantStyles = {
  ink: [styles.ink, styles.inkLive],
  quiet: [styles.quiet, styles.quietLive],
  ghost: [styles.ghost, styles.ghostLive],
  danger: [styles.danger, styles.dangerLive],
  approve: [styles.approve, styles.approveLive],
} as const;

const filled = (variant: ButtonVariant) =>
  variant !== "quiet" && variant !== "ghost";

// ---- The parts ---------------------------------------------------------------------------------------

interface Layers {
  icon?: IconData | undefined;
  iconEnd?: IconData | undefined;
  words?: ReactNode;
  state: ActionState | undefined;
  doneLabel?: string | undefined;
  failedLabel?: string | undefined;
}

const Layer = ({
  on,
  faded = false,
  children,
}: {
  on: boolean;
  faded?: boolean;
  children: ReactNode;
}) => {
  const shown = faded ? styles.faded : styles.shown;
  return (
    <span
      aria-hidden={on ? undefined : true}
      data-shown={on && !faded ? "" : undefined}
      {...stylex.props(layerMarker, styles.layer, on ? shown : styles.gone)}
    >
      {children}
    </span>
  );
};

/** Where the spinner stands while it works: in the icon's place, after the words, or alone. */
const spinnerPlace = (
  working: boolean,
  icon: IconData | undefined,
  iconEnd: IconData | undefined
) => ({
  atStart: working && icon !== undefined,
  atEnd: working && icon === undefined && iconEnd !== undefined,
  alone: working && icon === undefined && iconEnd === undefined,
});

const Content = ({
  icon,
  iconEnd,
  words,
  state,
  doneLabel,
  failedLabel,
}: Layers) => {
  const current = state ?? "idle";
  // Working, as Palermo: with an icon, the spinner takes the icon's place and the words stay; without
  // one, the words fade out and the spinner stands alone at the centre. The width never changes.
  const working = current === "working";
  const spinner = spinnerPlace(working, icon, iconEnd);
  const beside = icon !== undefined || iconEnd !== undefined;
  return (
    <span {...stylex.props(styles.stack)}>
      <Layer on={current === "idle" || working} faded={spinner.alone}>
        {spinner.atStart ? (
          <Spinner />
        ) : (
          icon !== undefined && <Icon icon={icon} />
        )}
        {words !== undefined && (
          <span {...stylex.props(styles.words, beside && styles.wordsBeside)}>
            {words}
          </span>
        )}
        {spinner.atEnd ? (
          <Spinner />
        ) : (
          iconEnd !== undefined && <Icon icon={iconEnd} />
        )}
      </Layer>
      {state !== undefined && (
        <>
          {/* The one spinner (src/components/spinner): it turns, or with reduced motion breathes. */}
          <Layer on={spinner.alone}>
            {/* Mounted only while it shows: an unseen spinner would turn for ever, costing frames
                and moving under reduced motion. The layer still fades it in as it arrives. */}
            {spinner.alone && <Spinner />}
          </Layer>
          {/* Done: the tick is drawn in where the spinner was, then the words slide in beside it,
              as one centred group, the tick always first. A button that
              is only an icon shows the mark alone in its square; its result is still said aloud. */}
          <Layer on={current === "done"}>
            <span {...stylex.props(styles.resultMark)}>
              <Icon icon={Tick} />
            </span>
            {words !== undefined && (
              <span {...stylex.props(styles.resultWords)}>{doneLabel}</span>
            )}
          </Layer>
          {/* Failed: the alert icon directly before the words, as one group, as any button with an
              icon. Never an X, which reads as "close". */}
          <Layer on={current === "failed"}>
            <span {...stylex.props(styles.resultMark)}>
              <Icon icon={Failed} />
            </span>
            {words !== undefined && (
              <span {...stylex.props(styles.resultWords)}>{failedLabel}</span>
            )}
          </Layer>
        </>
      )}
    </span>
  );
};

/** Words that would leave a button without a name: nothing, `false`, an empty string. */
const isEmpty = (words: unknown): boolean =>
  words === undefined ||
  words === null ||
  words === false ||
  words === true ||
  words === "" ||
  (Array.isArray(words) && words.every(isEmpty));

/** Says `words` once when they change to something, through the page's one live region. */
const useSaid = (words: string | undefined) => {
  // Starts at the first words, so a button drawn already showing a result (a page of examples)
  // says nothing on load; only a change is said.
  const last = useRef<string | undefined>(words);
  useEffect(() => {
    if (words !== undefined && words !== "" && words !== last.current) {
      announce(words);
    }
    last.current = words;
  }, [words]);
};

/** What is said aloud for each state: workingLabel while it works, then its result. */
const saidFor = (
  state: ActionState | undefined,
  labels: Record<Exclude<ActionState, "idle">, string | undefined>
) => (state === undefined || state === "idle" ? undefined : labels[state]);

/** The click a Button gives UI SDK: the caller's, unless the button cannot be pressed now. */
// A plain click (a hold released over the button) brings no details.
/** What a plain click says it was, when it comes with no details of its own. */
const pointerPress: ButtonActionDetails = { source: "mouse" };

type GuardedClick = (
  event: MouseEvent<HTMLElement>,
  details?: ButtonActionDetails
) => unknown;

/** The props of a Button, out of its union: each the type it has in any member. */
interface Read extends Shared {
  children?: ReactNode;
  icon?: IconData;
  iconEnd?: IconData;
  label?: string;
  state?: ActionState;
  workingLabel?: string;
  doneLabel?: string;
  failedLabel?: string;
}

/** Whether the part that draws this button opens something (a dialog's trigger): it does not ask. */
const opensSomething = (extra: Record<string, unknown>) => {
  const slot = extra["data-slot"];
  const popup = extra["aria-haspopup"];
  return (
    (typeof slot === "string" && slot.endsWith("-trigger")) ||
    (popup !== undefined && popup !== false && popup !== "false")
  );
};

/**
 * What an agent is told before its press runs: `agentConfirm`, or the part's own, or for a danger
 * or approve button that opens nothing, its own words.
 */
const confirmFor = (
  variant: ButtonVariant,
  words: string | undefined,
  agentConfirm: string | undefined,
  extra: Record<string, unknown>
) => {
  const theirs = extra["data-agent-confirm"];
  const given =
    agentConfirm ?? (typeof theirs === "string" ? theirs : undefined);
  const asks =
    (variant === "danger" || variant === "approve") && !opensSomething(extra);
  const own =
    words === undefined || words === ""
      ? "Does something that needs your yes"
      : `Presses "${words}"`;
  return given ?? (asks ? own : undefined);
};

const squares = {
  xs: styles.squareXs,
  sm: styles.squareSm,
  md: styles.squareMd,
  lg: styles.squareLg,
};
const targets = {
  xs: styles.targetXs,
  sm: styles.targetSm,
  md: styles.targetMd,
  lg: styles.targetLg,
};

interface Look {
  variant: ButtonVariant;
  size: ButtonSize;
  iconOnly: boolean;
  pressable: boolean;
  disabled: boolean;
  busy: boolean;
  failed: boolean;
  held: HoldLook | null;
  style: ButtonLayoutStyle | undefined;
}

const lookOf = ({
  variant,
  size,
  iconOnly,
  pressable,
  disabled,
  busy,
  failed,
  held,
  style,
}: Look) =>
  stylex.props(
    buttonMarker,
    styles.base,
    styles[size],
    iconOnly && styles.square,
    iconOnly && squares[size],
    variantStyles[variant][0],
    pressable && variantStyles[variant][1],
    !pressable && styles.still,
    disabled && styles.disabled,
    busy && !disabled && styles.busy,
    failed && styles.failed,
    held !== null && holdLook(variant, held.holding),
    focus.ring,
    styles.forcedFocus,
    style
  );

/** What is inside the button: the hold's fill, the sheen, the touch target and the content. */
const Inside = ({
  look,
  content,
}: {
  look: Pick<
    Look,
    "variant" | "size" | "iconOnly" | "pressable" | "failed" | "held"
  >;
  content: Layers;
}) => {
  const { variant, size, iconOnly, pressable, failed, held } = look;
  return (
    <>
      {held !== null && (
        <HoldFill variant={variant} holding={held.holding} ms={held.ms} />
      )}
      {filled(variant) && (
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.sheen,
            pressable && styles.sheenLive,
            failed && styles.sheenGone
          )}
        />
      )}
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.target,
          targets[size],
          iconOnly && size === "xs" && styles.targetSquareXs,
          iconOnly && size === "sm" && styles.targetSquareSm,
          iconOnly && size === "md" && styles.targetSquareMd
        )}
      />
      <Content {...content} />
    </>
  );
};

/**
 * Drawn by another UI SDK part, whose props it was given (they carry that part's data-slot): only
 * its face, on the part's own element, so the page has one button there, not two.
 */
const PartFace = ({
  render,
  face,
  children,
}: {
  render: ReactElement<Record<string, unknown>> | undefined;
  face: Record<string, unknown>;
  children: ReactNode;
}) => {
  if (render === undefined || !isValidElement(render)) {
    return (
      <button type="button" {...face}>
        {children}
      </button>
    );
  }
  const { type: Part, props } = render;
  return (
    <Part {...props} {...face}>
      {children}
    </Part>
  );
};

/** The face's props: the part's own, the button's look, and the press only while it can be pressed. */
const faceOf = ({
  extra,
  own,
  onClick,
  off,
  keepsFocus,
}: {
  extra: Record<string, unknown>;
  own: Record<string, unknown>;
  onClick: GuardedClick;
  off: boolean;
  keepsFocus: boolean;
}): Record<string, unknown> => ({
  ...extra,
  ...own,
  onClick,
  disabled: off && !keepsFocus ? true : undefined,
  "aria-disabled": off && keepsFocus ? true : extra["aria-disabled"],
});

/** The button's own props: its look, its data attributes, its name and what an agent is told. */
const ownOf = ({
  look,
  state,
  label,
  words,
  agentConfirm,
  extra,
}: {
  look: Look;
  state: ActionState | undefined;
  label: string | undefined;
  words: string | undefined;
  agentConfirm: string | undefined;
  extra: Record<string, unknown>;
}) => {
  const { variant, size, busy, iconOnly, held } = look;
  const name = busy ? undefined : held?.name;
  return {
    ...lookOf(look),
    "data-slot": "button",
    "data-variant": variant,
    "data-size": size,
    "data-state": busy ? state : undefined,
    // A danger or approve button never runs for an agent without the person's yes (UI SDK's mark).
    // One that only opens something (a dialog's trigger) does not ask: the action inside it does.
    "data-agent-confirm": confirmFor(variant, words, agentConfirm, extra),
    "aria-label": name ?? (iconOnly ? label : undefined),
    "aria-busy": state === "working" || undefined,
  };
};

const Pressable = ({
  held,
  hold: _hold,
  holdLabels: _holdLabels,
  ...allProps
}: ButtonProps & { held: HoldLook | null }) => {
  const read: Read = allProps;
  const {
    variant = "quiet",
    size = "md",
    icon,
    iconEnd,
    label,
    children,
    state,
    workingLabel,
    doneLabel,
    failedLabel,
    render,
    style,
    layout,
    agentConfirm,
    disabled = false,
    focusableWhenDisabled = false,
    pendingAnnouncement = "",
    onClick,
    ...rest
  } = read;
  const extra: Record<string, unknown> = rest;

  const iconOnly = isEmpty(children);
  const busy = state !== undefined && state !== "idle";
  const working = state === "working";
  const pressable = !(disabled || busy);
  const failed = state === "failed";
  const look = {
    variant,
    size,
    iconOnly,
    pressable,
    disabled,
    busy,
    failed,
    held,
    style: layout ?? style,
  };

  // The result is said once, by the page's one polite voice (src/announce), when it changes.
  // Nothing is put beside the button, so it stays a single element in a row or a group.
  // workingLabel is said, not shown: the words on the button stay its own while it works.
  useSaid(
    saidFor(state, {
      working: workingLabel,
      done: doneLabel,
      failed: failedLabel,
    })
  );

  // While it works or shows its result, a press does nothing (a second save never starts). An
  // agent's press while it shows "Saved" or "Could not save" fails with a message, instead of
  // reporting a press that did nothing. While it works, UI SDK already holds presses: the Promise
  // onClick returns (useAction's) keeps it pending.
  const shown = state === "done" ? doneLabel : failedLabel;
  const guardedClick: GuardedClick = (event, given) => {
    // A plain click (a hold released over it) comes with no details: a person's pointer.
    const details = given ?? pointerPress;
    if (pressable) {
      return onClick?.(event, details);
    }
    event.preventDefault();
    if (busy && details.source === "agent") {
      throw new Error(`It still says "${shown}". Press it again in a moment.`);
    }
    return null;
  };

  const own = ownOf({
    look,
    state,
    label,
    agentConfirm,
    extra,
    words: typeof children === "string" ? children : label,
  });
  const inside = (
    <Inside
      look={look}
      content={{
        icon,
        iconEnd,
        words: iconOnly ? undefined : children,
        state,
        doneLabel,
        failedLabel,
      }}
    />
  );

  if (typeof extra["data-slot"] === "string") {
    const face = faceOf({
      extra,
      own,
      onClick: guardedClick,
      off: disabled || working,
      keepsFocus: working || focusableWhenDisabled,
    });
    return (
      <PartFace render={render} face={face}>
        {inside}
      </PartFace>
    );
  }

  return (
    <ButtonPrimitive
      {...rest}
      {...own}
      render={render}
      onClick={guardedClick}
      // Working: it cannot be pressed, but keeps focus, so a keyboard user is not dropped.
      disabled={disabled || working}
      focusableWhenDisabled={working || focusableWhenDisabled}
      // Silent by default: the result is said once, by the page's one voice (useSaid above).
      pendingAnnouncement={pendingAnnouncement}
    >
      {inside}
    </ButtonPrimitive>
  );
};

// Loaded only for a Button with `hold`, so a plain Button never ships Popover.
const HoldButton = lazy(async () => {
  const module = await import("./hold");
  return { default: module.HoldButton };
});

/** Once the hold has loaded: the hold, which clicks itself once if it was pressed while loading. */
const HoldReady = ({
  allProps,
  takeEarly,
}: {
  allProps: ButtonProps;
  takeEarly: () => boolean;
}) => {
  const node = useRef<HTMLElement | null>(null);
  const { ref: callerRef } = allProps;
  const ref = (element: HTMLElement | null) => {
    node.current = element;
    assignRef(callerRef, element);
  };
  useEffect(() => {
    if (takeEarly()) {
      node.current?.click();
    }
  }, [takeEarly]);
  return <HoldButton {...allProps} ref={ref} />;
};

// Until hold.tsx (and the Popover it brings) has loaded, the button stands in its place, with the
// same name. A press then runs nothing: it is kept, and once the hold is there it opens the
// confirmation, as a click with no hold behind it does. So no press is lost, and none skips the hold.
const LazyHold = (allProps: ButtonProps) => {
  const early = useRef(false);
  const words =
    typeof allProps.children === "string" ? allProps.children : allProps.label;
  const { holdTo } = { ...englishHoldLabels, ...allProps.holdLabels };
  const name = words === undefined || words === "" ? undefined : holdTo(words);
  const waiting = { holding: false, ms: 0, name };
  const keep = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    early.current = true;
  };
  // Read once, by the hold when it has loaded: whether a press came while it loaded.
  const takeEarly = () => {
    const pressed = early.current;
    early.current = false;
    return pressed;
  };
  return (
    <Suspense
      fallback={<Pressable {...allProps} held={waiting} onClick={keep} />}
    >
      <HoldReady allProps={allProps} takeEarly={takeEarly} />
    </Suspense>
  );
};

export const Button = (allProps: ButtonProps) => {
  // A hold is a popover's trigger first (hold.tsx), which draws this Button inside it.
  const held = useContext(HoldContext);
  if (allProps.hold === undefined || allProps.hold === false || held !== null) {
    return <Pressable {...allProps} held={held} />;
  }
  return <LazyHold {...allProps} />;
};
