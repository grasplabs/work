// App preview's look: the frame, its bar or pill, the device outline and the layers over the frame.
// Every value is a token (src/tokens); every move is simply.* (0s with reduced motion).
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

// The preview's own room, not the window's. Below a tablet's width (app-preview-tablet, 48rem) the
// room is itself a tablet's or a phone's: with no `look`, the device outline replaces the bar.
const DEVICE = "@container app-preview (width < 48rem)";
// Below 36rem the bar with every control no longer holds the address at a readable width on one
// line: the widths, copy link, full screen and open fold into More.
const FOLD = "@container app-preview (width < 36rem)";

// A phone or tablet's scale to fit its room: the room's width (the stage, a container) over the
// device's own, never above 1. tan(atan2(a, b)) is a / b without its unit.
const fitOf = (device: string) => `min(1, tan(atan2(100cqi, ${device})))`;

export const styles = stylex.create({
  // The room it is given: a container the looks and the bar ask for their width.
  root: {
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    height: grasp.appPreviewHeight,
    containerType: "inline-size",
    containerName: "app-preview",
  },
  // The look itself, filling the room.
  shell: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    minWidth: 0,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    fontFamily: grasp.fontSans,
    color: grasp.text,
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
  },
  // The device look stands on the page's ground: the device is the edge.
  shellDevice: {
    backgroundColor: "transparent",
    boxShadow: "none",
    outline: "none",
  },
  // With no `look`: the browser look, and the device's in a phone's or tablet's room.
  shellAuto: {
    backgroundColor: { default: grasp.soft, [DEVICE]: "transparent" },
    boxShadow: { default: grasp.edge, [DEVICE]: "none" },
    outline: {
      default: "none",
      [media.forced]: { default: "1px solid CanvasText", [DEVICE]: "none" },
    },
  },
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    backgroundColor: grasp.raised,
    boxShadow: `0 ${grasp.hairline} 0 ${grasp.line}`,
    position: "relative",
    zIndex: 1,
  },
  barDevice: {
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  barAuto: {
    backgroundColor: { default: grasp.raised, [DEVICE]: "transparent" },
    boxShadow: {
      default: `0 ${grasp.hairline} 0 ${grasp.line}`,
      [DEVICE]: "none",
    },
  },
  // The address: read-only words in a soft field, shortening with an ellipsis.
  address: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "6rem",
    minWidth: 0,
    boxSizing: "border-box",
    minHeight: grasp.controlSm,
    paddingInline: grasp.space3,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.soft,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  addressDevice: {
    backgroundColor: "transparent",
  },
  addressAuto: {
    backgroundColor: { default: grasp.soft, [DEVICE]: "transparent" },
  },
  // The path as a field (with onNavigate): the address's own look, no edge of its own.
  pathField: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: grasp.text,
    // On a phone or a touch screen a field's text is 16px (fieldTextTouch, media.typing), as Input's: under it iOS Safari
    // zooms the page when the field takes focus. The read-only path stays 14px; it is no field.
    fontSize: { default: "inherit", [media.typing]: grasp.fieldTextTouch },
    lineHeight: "inherit",
    outline: "none",
  },
  path: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: grasp.fontMono,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 0,
    marginInlineStart: "auto",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
  },
  // In a narrow room these fold into More; More shows only then.
  folds: {
    display: { default: "flex", [FOLD]: "none" },
  },
  more: {
    display: { default: "none", [FOLD]: "flex" },
  },
  // The bare look's controls: a quiet row at the frame's foot, at its end, where they can never
  // cover the app (an app puts its own actions at its top corner).
  pill: {
    order: 1,
    alignSelf: "flex-end",
    flexShrink: 0,
    margin: grasp.space2,
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    maxWidth: `calc(100% - 2 * ${grasp.space2})`,
    boxSizing: "border-box",
    padding: grasp.space1,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.liftLow,
  },
  // Where the frame stands: it centres a narrower frame and never makes the page wider.
  // A container itself, so a scaled device measures its room in cqi.
  stage: {
    position: "relative",
    display: "flex",
    justifyContent: "center",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    containerType: "inline-size",
  },
  stageDevice: {
    paddingBlock: grasp.space2,
  },
  stageAuto: {
    paddingBlock: { default: 0, [DEVICE]: grasp.space2 },
  },
  frame: {
    position: "relative",
    boxSizing: "border-box",
    height: "100%",
    maxWidth: "100%",
    overflow: "hidden",
    backgroundColor: grasp.paper,
    transitionProperty: "width",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.easeInOut,
  },
  phone: { width: grasp.appPreviewPhone },
  tablet: { width: grasp.appPreviewTablet },
  desktop: { width: "100%" },
  fit: { width: "100%" },
  // A narrower frame in the browser and bare looks: a hairline either side.
  narrow: {
    boxShadow: `0 0 0 ${grasp.hairline} ${grasp.line}`,
  },
  // The device look at phone and tablet widths: an outline round the frame.
  device: {
    padding: grasp.appPreviewBezel,
    borderRadius: grasp.appPreviewDeviceCorner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
  },
  // A phone or tablet in a room narrower than it: the device keeps its true width and scales down
  // to fit (by --app-preview-fit, worked out in CSS from the room), as tall again as the scale took
  // off, so it still fills the room; the app inside lays out at the device's real width.
  deviceScaled: {
    flexShrink: 0,
    maxWidth: "none",
    transformOrigin: "top center",
    transform: "scale(var(--app-preview-fit, 1))",
    height: "calc(100% / var(--app-preview-fit, 1))",
  },
  fitPhone: { "--app-preview-fit": fitOf(grasp.appPreviewPhone) },
  fitTablet: { "--app-preview-fit": fitOf(grasp.appPreviewTablet) },
  deviceWide: {
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
  },
  // With no `look`, a phone or tablet frame: a hairline either side, or the device in a narrow room.
  autoNarrow: {
    padding: { default: 0, [DEVICE]: grasp.appPreviewBezel },
    borderRadius: { default: 0, [DEVICE]: grasp.appPreviewDeviceCorner },
    cornerShape: grasp.cornerShape,
    backgroundColor: { default: grasp.paper, [DEVICE]: grasp.raised },
    boxShadow: {
      default: `0 0 0 ${grasp.hairline} ${grasp.line}`,
      [DEVICE]: grasp.liftMedium,
    },
    outline: {
      default: "none",
      [media.forced]: { default: "none", [DEVICE]: "1px solid CanvasText" },
    },
    flexShrink: { default: 1, [DEVICE]: 0 },
    maxWidth: { default: "100%", [DEVICE]: "none" },
    transformOrigin: "top center",
    transform: {
      default: "none",
      [DEVICE]: "scale(var(--app-preview-fit, 1))",
    },
    height: {
      default: "100%",
      [DEVICE]: "calc(100% / var(--app-preview-fit, 1))",
    },
  },
  // With no `look`, the desktop or fit frame: in a narrow room the device's quiet edge round it.
  autoWide: {
    padding: { default: 0, [DEVICE]: grasp.appPreviewBezel },
    borderRadius: { default: 0, [DEVICE]: grasp.corner },
    cornerShape: grasp.cornerShape,
    backgroundColor: { default: grasp.paper, [DEVICE]: grasp.raised },
    boxShadow: { default: "none", [DEVICE]: grasp.edge },
  },
  screen: {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: grasp.paper,
  },
  screenDevice: {
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  screenAuto: {
    borderRadius: { default: 0, [DEVICE]: grasp.corner },
    cornerShape: grasp.cornerShape,
  },
  iframe: {
    display: "block",
    width: "100%",
    height: "100%",
    borderWidth: 0,
    backgroundColor: grasp.paper,
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
  },
  iframeWaiting: {
    opacity: 0,
  },
  layer: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space3,
    boxSizing: "border-box",
    padding: grasp.space6,
    backgroundColor: grasp.paper,
    textAlign: "center",
    overflow: "auto",
    scrollbarWidth: "none",
  },
  // Fix first, Retry beside it.
  choices: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: grasp.space2,
  },
  // Updating: a veil of the paper over the last version, so it reads as not current, and a quiet
  // line at the foot; presses still pass to the page beneath only once it is current again.
  updating: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: grasp.space3,
    backgroundColor: `color-mix(in oklch, ${grasp.paper} 40%, transparent)`,
  },
  updatingLine: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space3,
    borderRadius: grasp.cornerPill,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.liftLow,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  quiet: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  heading: {
    margin: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    color: grasp.text,
    outline: "none",
  },
  sentence: {
    margin: 0,
    maxWidth: grasp.emptyMeasure,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    textWrap: "balance",
  },
  // The failure's details: a Collapsible as wide as the sentence, its words and chevron at its ends.
  details: {
    width: "100%",
    maxWidth: grasp.emptyMeasure,
  },
  code: {
    margin: 0,
    marginBlockStart: grasp.space2,
    padding: grasp.space3,
    maxWidth: "100%",
    overflow: "auto",
    scrollbarWidth: "none",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.codeFill,
    fontFamily: grasp.fontMono,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    textAlign: "start",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});
