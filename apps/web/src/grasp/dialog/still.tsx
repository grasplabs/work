// DialogStill: draws a dialog standing still, in place, for the docs: its states row and the
// phone's sheet on a wide page. The parts inside are the real ones and wear
// their real styles; only UI SDK's behaviour is left out, so nothing opens, moves or takes focus.
// The box stands in for the window: the shade covers it and the panel sits in it as a window
// would hold it. It is a drawing, so it is inert. Not part of the component: never in a product.
//
//   <DialogStill phase="opening">
//     <Dialog>…the same trigger and panel as in a product…</Dialog>
//   </DialogStill>
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { DialogStillContext } from "./still-context";
import type { DialogStillPhase, DialogStillValue } from "./still-context";
import { stillStyles as styles } from "./still.styles";

export type { DialogStillPhase } from "./still-context";

export interface DialogStillProps {
  /** Shut, a third of the way in, open, or a third of the way out. */
  phase: DialogStillPhase;
  /** The phone's sheet, whatever the window's width. */
  sheet?: boolean;
  /** The footer's action with work to do is working. */
  busy?: boolean;
  /** Its own size and place in the docs: a cell's height, a phone's width. */
  style?: stylex.StyleXStyles;
  children: ReactNode;
}

/** What a still dialog tells its parts: its phase, whether an action works, and their looks. */
const stillValue = (
  phase: DialogStillPhase,
  sheet: boolean,
  busy: boolean
): DialogStillValue => {
  const opening = phase === "opening";
  const closing = phase === "closing";
  const frozen = opening || closing;
  return {
    phase,
    busy,
    look: {
      scrim: [
        styles.scrim,
        frozen && styles.frozen,
        opening && styles.openingShade,
        closing && styles.closingShade,
      ],
      panel: [
        styles.placed,
        sheet && styles.sheet,
        frozen && styles.frozen,
        opening && styles.openingPanel,
        closing && styles.closingPanel,
        sheet && opening && styles.sheetOpening,
        sheet && closing && styles.sheetClosing,
      ],
      footer: styles.footer,
      action: sheet ? styles.sheetAction : styles.action,
    },
  };
};

export const DialogStill = ({
  phase,
  sheet = false,
  busy = false,
  style,
  children,
}: DialogStillProps) => {
  const value = stillValue(phase, sheet, busy);
  return (
    <DialogStillContext.Provider value={value}>
      {/* data-force: a drawing that stands still, like a forced cell, is not a target to measure. */}
      <div
        inert
        data-force=""
        data-dialog-still={phase}
        {...stylex.props(styles.frame, style)}
      >
        {children}
      </div>
    </DialogStillContext.Provider>
  );
};
