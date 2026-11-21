// What a popover's parts read to draw themselves standing still, in place, for the docs
// (still.tsx): nothing in a product, where every part is UI SDK's live part.
import type * as stylex from "@stylexjs/stylex";
import { createContext, useContext } from "react";

/** Where a still popover stands: shut, a third of the way in, open, or a third of the way out. */
export type PopoverStillPhase = "closed" | "opening" | "open" | "closing";

export interface PopoverStillValue {
  phase: PopoverStillPhase;
  /**
   * The still's own styles for each part, from still.styles.ts. They come through here, so the
   * parts never import them and a product never ships them.
   */
  look: {
    trigger: stylex.StyleXStyles;
    panel: stylex.StyleXStyles;
  };
}

export const PopoverStillContext = createContext<PopoverStillValue | null>(
  null
);

export const useStill = () => useContext(PopoverStillContext);
