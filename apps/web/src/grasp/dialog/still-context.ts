// What a dialog's parts read to draw themselves standing still, in place, for the docs (still.tsx):
// nothing in a product, where every part is UI SDK's live part.
import type * as stylex from "@stylexjs/stylex";
import { createContext, useContext } from "react";

import type { ButtonLayoutStyle } from "../button";

/** Where a still dialog stands: shut, a third of the way in, open, or a third of the way out. */
export type DialogStillPhase = "closed" | "opening" | "open" | "closing";

export interface DialogStillValue {
  phase: DialogStillPhase;
  /** The footer's action with work to do is working. */
  busy: boolean;
  /**
   * The still's own styles for each part, from still.styles.ts. They come through here, so the
   * parts never import them and a product never ships them.
   */
  look: {
    scrim: stylex.StyleXStyles;
    panel: stylex.StyleXStyles;
    footer: stylex.StyleXStyles;
    action: ButtonLayoutStyle;
  };
}

export const DialogStillContext = createContext<DialogStillValue | null>(null);

export const useStill = () => useContext(DialogStillContext);
