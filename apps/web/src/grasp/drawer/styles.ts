// The look of a drawer and a sheet, shared by their parts. A drawer rises from the bottom with a
// grip to drag it by; a sheet (src/components/sheet) stands along a side with a close button. Both
// are UI SDK's Drawer underneath, which moves the panel itself: these styles never set its
// translate or the shade's opacity.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";
import { drawerMarker } from "./drawer.stylex";

const PHONE = media.belowPhone;
const vertical = ':is([data-side="bottom"], [data-side="top"])';
const sideways = ':is([data-side="left"], [data-side="right"])';

// The body's hairlines along its scroll, as a Dialog's: the bottom one at the top, both in between,
// the top one at the end. A body cut in a gap between paragraphs still says there is more.
const lineBelow = `inset 0 -1px 0 ${grasp.line}`;
const lineAbove = `inset 0 1px 0 ${grasp.line}`;
const edges = stylex.keyframes({
  "0%": { boxShadow: lineBelow },
  "1%, 99%": { boxShadow: `${lineAbove}, ${lineBelow}` },
  "100%": { boxShadow: lineAbove },
});

// While there is more below, the last of the body fades into the panel's ground just above its
// bottom hairline, so a line cut at that edge reads as more to come, not as words underlined by the
// hairline (A3-layers-03, -09). The fade stands on its own layer (::after), not a mask: a mask would
// take the hairline with it. The hairline's own pixel is left clear. At the end it is gone.
const FADE = grasp.space6;
const more = stylex.keyframes({
  "0%, 99%": { opacity: 1 },
  "100%": { opacity: 0 },
});

export const drawerStyles = stylex.create({
  // The shade over the page. UI SDK sets its opacity as the panel moves.
  scrim: {
    position: "fixed",
    inset: 0,
    backgroundColor: grasp.dialogScrim,
  },

  // The panel: raised, lifted, the one corner on the side that faces the page. Title,
  // description, body and footer stand in one column; only the body scrolls.
  // A panel whose content heads it (SheetPanel close="none"): that content's ground keeps to the
  // panel's rounded corners instead of squaring the top ones off.
  panelClipped: { overflow: "clip" },
  // App shell's menu (SheetPanel corner="shell"): the shell's card corner, round, as the page's card
  // and the peeking sidebar beside it, not the system's larger squircle.
  shellCorner: { borderRadius: grasp.shellCardCorner, cornerShape: "round" },
  panel: {
    position: "relative",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: grasp.text,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftHigh,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    outline: "none",
    // Along the bottom: as wide as the window up to drawer-width, in the middle; as tall as its
    // content up to drawer-height. Along a side: the window's height, sheet-width wide, and on a
    // phone the same inset from both sides as from the top and foot, so it never stands off-centre.
    width: {
      default: "100%",
      [vertical]: {
        default: `min(${grasp.drawerWidth}, 100%)`,
        [PHONE]: "100%",
      },
      [sideways]: `min(${grasp.sheetWidth}, 100% - 2 * ${grasp.sheetInset})`,
    },
    height: {
      default: "fit-content",
      [sideways]: `calc(100% - 2 * ${grasp.sheetInset})`,
    },
    // A sheet floats a little off the window's edges, every corner rounded, as Palermo's drawer.
    marginBlock: { default: null, [sideways]: grasp.sheetInset },
    maxHeight: {
      default: `min(${grasp.drawerHeight}, var(--visual-viewport-height, 100dvh) - ${grasp.dialogGutter})`,
      [sideways]: "none",
    },
    marginInline: {
      default: null,
      [vertical]: "auto",
      [sideways]: grasp.sheetInset,
    },
    borderRadius: {
      default: `${grasp.corner} ${grasp.corner} 0 0`,
      ':is([data-side="top"])': `0 0 ${grasp.corner} ${grasp.corner}`,
      [sideways]: grasp.corner,
    },
  },

  // A wide sheet, and a full one: a chart or a table opened in full. Never closer than the inset
  // to the window's edges, so on a phone either is the full sheet.
  wide: {
    width: `min(${grasp.sheetWidthWide}, 100% - 2 * ${grasp.sheetInset})`,
  },
  full: {
    width: `min(${grasp.sheetWidthFull}, 100% - 2 * ${grasp.sheetInset})`,
  },

  // A sheet that keeps to App shell's box (SheetPanel bounds="shell"), which the shell writes on
  // itself while its menu is open: where it starts, its top, width and height in the window. With
  // nothing written, the window's. The shade covers the shell, not the window.
  inShell: {
    width: `min(${grasp.sheetWidth}, var(--grasp-shell-menu-width, 100%) - 2 * ${grasp.sheetInset})`,
    height: `calc(var(--grasp-shell-menu-height, 100%) - 2 * ${grasp.sheetInset})`,
    marginBlockStart: `calc(var(--grasp-shell-menu-top, 0px) + ${grasp.sheetInset})`,
    marginInlineStart: `calc(var(--grasp-shell-menu-start, 0px) + ${grasp.sheetInset})`,
  },
  inShellWide: {
    width: `min(${grasp.sheetWidthWide}, var(--grasp-shell-menu-width, 100%) - 2 * ${grasp.sheetInset})`,
  },
  inShellFull: {
    width: `min(${grasp.sheetWidthFull}, var(--grasp-shell-menu-width, 100%) - 2 * ${grasp.sheetInset})`,
  },
  scrimInShell: {
    insetBlockStart: "var(--grasp-shell-menu-top, 0px)",
    insetInlineStart: "var(--grasp-shell-menu-start, 0px)",
    insetBlockEnd: "auto",
    insetInlineEnd: "auto",
    width: "var(--grasp-shell-menu-width, 100%)",
    height: "var(--grasp-shell-menu-height, 100%)",
    // The corner of the window the shell fills, so the shade never shows past it (App shell F62).
    borderRadius: "var(--grasp-shell-menu-corner, 0px)",
    cornerShape: "var(--grasp-shell-menu-corner-shape, round)",
  },

  // A drawer with heights to rest at stands at its tallest; its rests show part of it. Its height
  // is the footer's measure for staying in view at a lower rest (footerRests).
  tall: {
    height: `min(${grasp.drawerHeight}, var(--visual-viewport-height, 100dvh) - ${grasp.dialogGutter})`,
    containerType: "size",
    // UI SDK's --drawer-progress (the part of the panel that shows) is registered not to inherit:
    // the panel hands it on, resolved, to the footer under it.
    "--grasp-drawer-shown": "var(--drawer-progress, 1)",
    // What of the lifted footer would stand above the panel as it nearly closes stays inside it.
    overflow: "clip",
  },

  // The grip at the top of a drawer: UI SDK's handle, a press steps it to its next height and
  // the arrow keys move it. The bar inside is a plain line, the size of a fingertip's aim.
  grip: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    width: grasp.controlLg,
    height: { default: grasp.space6, [media.coarse]: grasp.controlLg },
    marginBlockStart: grasp.space1,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: "transparent",
    cursor: { default: "grab", ":active": "grabbing" },
    touchAction: "none",
  },
  bar: {
    display: "block",
    width: grasp.drawerGripWidth,
    height: grasp.drawerGripHeight,
    borderRadius: grasp.drawerGripHeight,
    backgroundColor: {
      default: grasp.drawerGripFill,
      [media.forced]: "CanvasText",
    },
  },

  title: {
    flexShrink: 0,
    margin: 0,
    paddingBlockStart: grasp.space6,
    paddingInlineStart: grasp.space6,
    paddingInlineEnd: grasp.space6,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "balance",
  },
  // Under a grip, the title sits closer to the top.
  titleUnderGrip: {
    paddingBlockStart: grasp.space2,
  },
  // A sheet's title heads it, as Palermo's: a row of its own, in the interface's small type, with
  // the close button at its end and a hairline under it.
  titleBesideClose: {
    boxSizing: "border-box",
    minHeight: grasp.sheetHeadHeight,
    paddingBlockStart: `calc((${grasp.sheetHeadHeight} - ${grasp.textSmLine}) / 2)`,
    paddingBlockEnd: `calc((${grasp.sheetHeadHeight} - ${grasp.textSmLine}) / 2)`,
    // Its words start on the same edge as the description's, the body's and the footer's (space-6),
    // so the sheet reads down one line; the close button keeps its place at the end.
    paddingInlineStart: grasp.space6,
    paddingInlineEnd: `calc(${grasp.space4} + ${grasp.controlSm})`,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    boxShadow: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.line}`,
  },
  // Under a sheet's head, the description opens the content.
  descriptionUnderHead: {
    marginBlockStart: grasp.space6,
  },
  description: {
    flexShrink: 0,
    margin: 0,
    marginBlockStart: grasp.space2,
    paddingInline: grasp.space6,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "pretty",
  },

  // The body scrolls on its own, and has room above and below for a field's focus ring.
  body: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    marginBlockStart: `calc(${grasp.space5} - ${grasp.space2})`,
    marginBlockEnd: `calc(-1 * ${grasp.space2})`,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space6,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.text,
    overflowWrap: "anywhere",
    hyphens: "manual",
    // Only where the browser drives an animation by scroll; elsewhere no line at all. Never once
    // the panel is no longer open: a scroll-driven animation does not end, and a close may wait
    // for its animations to end.
    animationName: {
      default: null,
      "@supports (animation-timeline: scroll())": {
        default: edges,
        [stylex.when.ancestor(":not([data-open])", drawerMarker)]: "none",
      },
    },
    animationDuration: {
      default: null,
      "@supports (animation-timeline: scroll())": "auto",
    },
    animationTimingFunction: {
      default: null,
      "@supports (animation-timeline: scroll())": "linear",
    },
    animationFillMode: {
      default: null,
      "@supports (animation-timeline: scroll())": "both",
    },
    animationTimeline: {
      default: null,
      "@supports (animation-timeline: scroll())": "scroll(self)",
    },
    // Square, so the hairlines run straight to its sides; round only for its focus ring.
    borderRadius: { default: 0, ":focus-visible": grasp.cornerMark },
    "::after": {
      content: '""',
      position: "sticky",
      insetBlockEnd: `calc(-1 * ${grasp.space2})`,
      display: "block",
      height: FADE,
      marginBlockStart: `calc(-1 * ${FADE})`,
      marginInline: `calc(-1 * ${grasp.space6})`,
      pointerEvents: "none",
      backgroundImage: `linear-gradient(to bottom, transparent, ${grasp.raised} calc(100% - ${grasp.hairline}), transparent calc(100% - ${grasp.hairline}))`,
      opacity: 0,
      animationName: {
        default: null,
        "@supports (animation-timeline: scroll())": {
          default: more,
          [stylex.when.ancestor(":not([data-open])", drawerMarker)]: "none",
        },
      },
      animationDuration: {
        default: null,
        "@supports (animation-timeline: scroll())": "auto",
      },
      animationTimingFunction: {
        default: null,
        "@supports (animation-timeline: scroll())": "linear",
      },
      animationFillMode: {
        default: null,
        "@supports (animation-timeline: scroll())": "both",
      },
      animationTimeline: {
        default: null,
        "@supports (animation-timeline: scroll())": "scroll(nearest)",
      },
    },
  },
  stack: {
    display: "grid",
    rowGap: grasp.space4,
  },

  // The actions: at the end of the line, the main one last. In a drawer on a phone they share
  // its width. Clear of a phone's home bar.
  footer: {
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: grasp.space2,
    marginBlockStart: grasp.space6,
    paddingInline: grasp.space6,
    paddingBlockEnd: `max(${grasp.space6}, env(safe-area-inset-bottom))`,
  },
  // In a drawer with heights to rest at, the actions stay in view at a lower rest: lifted by what
  // of the panel is below the window (UI SDK's --drawer-progress is the part that shows), on the
  // panel's own ground over the body, a hairline above them while the body runs on under them.
  // With no body to grow, the actions go to the panel's foot, where the lift above expects them;
  // under the description they left an empty band beneath them (A3-layers-05: 328px at the higher rest).
  footerRests: {
    position: "relative",
    zIndex: 1,
    marginBlockStart: {
      default: `calc(${grasp.space6} - ${grasp.space4})`,
      [stylex.when.ancestor(
        ':not(:has([data-slot="drawer-body"]))',
        drawerMarker
      )]: "auto",
    },
    paddingBlockStart: grasp.space4,
    backgroundColor: grasp.raised,
    transform: "translateY(calc((var(--grasp-drawer-shown, 1) - 1) * 100cqh))",
    boxShadow: {
      default: "none",
      [stylex.when.ancestor(
        ":is([data-snap-point]):not([data-expanded])",
        drawerMarker
      )]: lineAbove,
    },
    // At a lower rest the body does not scroll (the actions are lifted over it), so its own fade
    // never shows and the row cut at the hairline read as underlined (A3-layers-09). The fade
    // stands just above the actions instead, on their ground, while they are lifted.
    "::before": {
      content: {
        default: "none",
        [stylex.when.ancestor(
          ":is([data-snap-point]):not([data-expanded])",
          drawerMarker
        )]: '""',
      },
      position: "absolute",
      insetInline: 0,
      insetBlockEnd: "100%",
      height: FADE,
      pointerEvents: "none",
      backgroundImage: `linear-gradient(to bottom, transparent, ${grasp.raised})`,
    },
  },
  // In a sheet the actions stand at its foot, however little is above them.
  footerAtFoot: {
    marginBlockStart: "auto",
    paddingBlockStart: grasp.space6,
  },
  // On a phone the actions share the line in equal parts (they grow from nothing), each at least
  // as wide as its words on one line: a label longer than its share takes more, and when two do not
  // fit the footer wraps them onto two full lines before a label wraps in its button (eyes-a
  // A-layers-13: grown from their own widths, "Not yet" took 174px and "Send" 159px).
  action: {
    flexGrow: { default: 0, [PHONE]: 1 },
    flexBasis: { default: "auto", [PHONE]: 0 },
    minWidth: { default: null, [PHONE]: "fit-content" },
  },

  // A sheet's close button, at the end of its head.
  close: {
    position: "absolute",
    insetBlockStart: `calc((${grasp.sheetHeadHeight} - ${grasp.controlSm}) / 2)`,
    insetInlineEnd: `calc((${grasp.sheetHeadHeight} - ${grasp.controlSm}) / 2)`,
    display: "flex",
  },
});
