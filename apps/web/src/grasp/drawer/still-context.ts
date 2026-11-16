// What a drawer's and a sheet's parts read to draw themselves standing still, in place, for the
// docs (still.tsx): nothing in a product, where every part is UI SDK's live part.
import type * as stylex from "@stylexjs/stylex";
import { createContext, useContext } from "react";

export interface DrawerStillValue {
  /** The physical edge it stands at, as UI SDK resolves it. */
  side: "bottom" | "left" | "right";
  /** A drawer resting at its lower height, of two. */
  low: boolean;
  /** The footer's action with work to do is working. */
  busy: boolean;
  /** The still's own styles, from still.styles.ts, so a product never ships them. */
  look: {
    scrim: stylex.StyleXStyles;
    viewport: stylex.StyleXStyles;
    low: stylex.StyleXStyles;
    high: stylex.StyleXStyles;
  };
}

export const DrawerStillContext = createContext<DrawerStillValue | null>(null);

export const useStill = () => useContext(DrawerStillContext);
