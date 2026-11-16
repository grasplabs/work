// The still drawing of a drawer or a sheet, for the docs only (still.tsx): the frame that stands
// in for the window. Kept apart from styles.ts, so a product that imports the drawer never ships it.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

export const drawerStillStyles = stylex.create({
  // A piece of page the size of its box, with the panel in it as the window would hold it.
  // A picture, not a control: inert, and no pointer over its buttons or hover on them, so nothing
  // in it reads as pressable (Ruben pressed a still's buttons, 15 November).
  frame: {
    pointerEvents: "none",
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    height: grasp.stagePhoneHeight,
    overflow: "hidden",
    color: grasp.text,
    backgroundColor: grasp.soft,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  // In the frame, not over the window.
  scrim: {
    position: "absolute",
  },
  // Where UI SDK's viewport would hold the panel: against the side it comes from.
  viewport: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: {
      default: "column",
      ':is([data-side="left"], [data-side="right"])': "row",
    },
    justifyContent: {
      default: "flex-end",
      ':is([data-side="left"])': "flex-start",
    },
  },
  // A drawer resting at the higher of its two heights: most of it shows, the page still above it,
  // as at the 0.85 rest, so it never reads as a panel cut off at the frame's top.
  high: {
    height: "85%",
    overflow: "hidden",
  },
  // A drawer resting at the lower of its two heights: part of it shows.
  low: {
    height: "45%",
    overflow: "hidden",
  },
});
