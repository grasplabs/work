// The variables, markers and the pixel every component shares. StyleX resolves a variable or a
// marker only when it is imported straight from a .stylex.ts file, so they live here, not in
// styles.ts.
import * as stylex from "@stylexjs/stylex";

import { duration, size } from "./tokens.stylex";

const REDUCED = "@media (prefers-reduced-motion: reduce)";
const DENSE = "@media (min-resolution: 2dppx)";

/**
 * The two values an icon reads from whoever holds it. StyleX does not let a parent style its
 * children, so a component that holds an icon sets these on itself and
 * every Icon inside follows: `{ [iconVars.size]: size.iconSm }`. Never size an icon from outside.
 */
export const iconVars = stylex.defineVars({
  /** Width and height of the icon. */
  size: size.iconSm,
  /** Stroke width, in the icon's 24-unit grid. */
  stroke: size.iconStroke,
});

/**
 * The times things move or fade, which become 0s when the person asks for reduced motion: a part
 * that would move, grow or fade is then simply there, and simply gone. Use these for movement, size
 * and fades:
 *
 *   transitionProperty: "opacity, transform",
 *   transitionDuration: { default: motionVars.ui, ":is([data-ending-style])": motionVars.leave },
 *
 * A colour easing under the pointer is not motion: keep `duration.hover` there. A spinner or a
 * progress bar that must keep a sign of life under reduced motion keeps a slow fade of its own.
 */
export const motionVars = stylex.defineVars({
  /** A press shrinking a control a little. */
  press: { default: duration.press, [REDUCED]: "0s" },
  /** A small change of place or shape (a chevron turning). */
  hover: { default: duration.hover, [REDUCED]: "0s" },
  /** A mark drawn in, words sliding in beside it. */
  mark: { default: duration.mark, [REDUCED]: "0s" },
  /** One state giving way to the next on a control. */
  swap: { default: duration.swap, [REDUCED]: "0s" },
  /** Something coming in at full length: a toast into its stack, a sheet from its side. */
  open: { default: duration.open, [REDUCED]: "0s" },
  /** Something opening (a popup, a panel). */
  ui: { default: duration.ui, [REDUCED]: "0s" },
  /** Something leaving, faster than it came. */
  leave: { default: duration.leave, [REDUCED]: "0s" },
  /** A beat to wait before something follows what moved first. */
  stagger: { default: duration.stagger, [REDUCED]: "0s" },
  /** A tooltip leaving. */
  tooltipLeave: { default: duration.tooltipLeave, [REDUCED]: "0s" },
  /** Words following their mark. */
  follow: { default: duration.resultFollow, [REDUCED]: "0s" },
  /** A confirmation settling into its new form. */
  settle: { default: duration.confirmationSettle, [REDUCED]: "0s" },
  /** A collapsible opening to its height. */
  collapsibleOpen: { default: duration.collapsibleOpen, [REDUCED]: "0s" },
  /** A switch's thumb travelling on its spring. */
  travel: { default: duration.switchTravel, [REDUCED]: "0s" },
  /** A switch's light following its thumb. */
  trail: { default: duration.switchTrail, [REDUCED]: "0s" },
  /** The command palette fading in. */
  searchOpen: { default: duration.searchOpen, [REDUCED]: "0s" },
  /** The command palette fading out. */
  searchClose: { default: duration.searchClose, [REDUCED]: "0s" },
  /** A popup opening (a menu, a list, a popover). */
  popup: { default: duration.popup, [REDUCED]: "0s" },
  /** A level slider's thumb snapping to a level. */
  snap: { default: duration.sliderLevelsSnap, [REDUCED]: "0s" },
});

/** The marker a control carries when its focus ring is drawn on a part inside it (`focusLabel`). */
export const focusMarker = stylex.defineMarker();

/**
 * The marker of a part that packs its controls edge to edge or clips them (a button group, a field's
 * box, a code view): the ring of every control inside is drawn just inside that control's own edge
 * (`focusRing`), where no neighbour covers it and nothing cuts it.
 */
export const ringInsetMarker = stylex.defineMarker();

/** The marker of a list popup, so a part inside it can answer the popup's state (`listStyles`). */
export const listMarker = stylex.defineMarker();

/**
 * The marker of a side panel's card (a SidePanelSection's), so the `xs` Items in it take the
 * panel's rhythm: 44px rows of the panel's smaller words, flush, a hairline between them.
 */
export const sidePanelCardMarker = stylex.defineMarker();

/**
 * The marker of a one-row prompt input's card, so a model chip in it answers what the row decides
 * about its room: `data-fold`, its level folds to the maker's mark; `data-away`, it is away until
 * something is typed (prompt-input.tsx, `useRowFit`).
 */
export const promptInputRowMarker = stylex.defineMarker();

/**
 * The room a menu's words keep at their start for an icon (`menuStyles.inset`). Each menu panel
 * sets it for its own rows (`menuStyles.panel`): an icon and its gap when one of them has an icon,
 * none when none has. A submenu stands inside its parent's panel and sets its own, so the parent's
 * icons never push in the words of a submenu that has none.
 */
export const menuVars = stylex.defineVars({
  lead: "0px",
});

/**
 * On every Field: its label shows the required mark when the field holds a required control, and a
 * control inside answers the field's own state (a pointer anywhere on a horizontal row, the field
 * shown as wrong) through stylex.when.ancestor, without a selector that reaches into children.
 */
export const fieldControlMarker = stylex.defineMarker();

/**
 * The marker of the Toaster's region, so a layer can tell focus went into a toast (a popover stays
 * open while a toast's action is pressed): `closest` finds it by its class.
 */
export const toastRegionMarker = stylex.defineMarker();

/**
 * The marker of a layer's footer (a dialog's, an alert dialog's, a drawer's, a sheet's): on a phone
 * every Button in it takes an equal part of the line (button.tsx).
 */
export const layerFooterMarker = stylex.defineMarker();

/**
 * How tall a rectangular Skeleton stands: a default control, or what the box that holds it says (an
 * icon's 16px box sets `100%`, so its placeholder is the box's size in every engine).
 */
export const skeletonVars = stylex.defineVars({
  block: "var(--damsko-control-default)",
});

/** What a pixel grid reads from the part that draws it. */
export const pixelVars = stylex.defineVars({
  /**
   * The colour a grid is drawn in as a background: a part sets it where it draws the grid,
   * `{ [pixelVars.color]: colors.foreground }`. A mask needs none.
   */
  color: "currentColor",
  /**
   * The side of a fine pixel, drawn for a dot a pixel and a half across: that, where it is whole
   * device pixels (a screen of two to a pixel or more), and 1px where it is not.
   */
  fine: { default: "1px", [DENSE]: "1.5px" },
});

/** One square of `side` at the start corner of a tile, with hard edges. */
const square = (side: string, colour: string) =>
  `conic-gradient(from 270deg at ${side} ${side}, ${colour} 90deg, transparent 0)`;

/**
 * The system's pixel: a square at the start corner of every tile, as wide as the dot it is drawn
 * for, with hard edges on whole device pixels, so a grid of them is sharp at 1x and 2x. Every
 * dither a part draws in CSS as one grid from a corner is this one (Progress's track how far
 * unknown, Page header's banner, a Data grid's range): as a background in `pixelVars.color`, or as a
 * mask over what shows through it. The pitch is the part's own `backgroundSize` or `maskSize`, in
 * whole pixels, and so is where the grid starts: a tile stretched, spaced or centred onto part of a
 * pixel would blur the squares.
 *
 *   backgroundImage: pixel.fill, backgroundSize: "4px 4px", [pixelVars.color]: colors.foreground
 *   maskImage: pixel.mask, maskSize: "3px 3px"
 */
export const pixel = stylex.defineConsts({
  /** A 2px square as a background in `pixelVars.color`. */
  fill: square("2px", pixelVars.color),
  /** The 2px square as a mask: where a light shows, or a ground seen through the dither. */
  mask: square("2px", "#000"),
  /** A fine square (`pixelVars.fine`) as a background: a faint field at rest. */
  fineFill: square(pixelVars.fine, pixelVars.color),
});

/**
 * The marker of a card that holds a Trace row (Tool's): the row's trigger runs the card's width and
 * takes no fill under the pointer, only its words turn to ink, as a row that opens in a list does
 * (trace.tsx). A fill only as wide as the words would stand as a block of its own inside the card.
 */
export const traceCardMarker = stylex.defineMarker();
