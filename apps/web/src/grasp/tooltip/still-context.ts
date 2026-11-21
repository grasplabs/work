// What a tooltip's parts read to draw themselves standing still, in place, for the docs
// (still.tsx): nothing in a product, where every part is UI SDK's live part.
import type * as stylex from "@stylexjs/stylex";
import { createContext, useContext } from "react";

/** Where a still tooltip stands: shut, a third of the way in, open, or a third of the way out. */
export type TooltipStillPhase = "closed" | "opening" | "open" | "closing";

export interface TooltipStillValue {
  phase: TooltipStillPhase;
  /** The root's shortcut, so a still shortcut can show its keys. */
  shortcut?: string;
  /**
   * The still's own styles for the panel, from still.styles.ts. They come through here, so the
   * parts never import them and a product never ships them.
   */
  look: { panel: stylex.StyleXStyles };
}

export const TooltipStillContext = createContext<TooltipStillValue | null>(
  null
);

export const useStill = () => useContext(TooltipStillContext);
