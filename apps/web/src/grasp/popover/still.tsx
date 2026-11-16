// PopoverStill: draws a popover standing still, in place, for the docs: its states row and the
// phone's width on a wide page. The parts inside are the real ones and wear their real styles;
// only UI SDK's behaviour is left out, so nothing opens, moves or takes focus. The box stands in
// for the window: the trigger near its top, the panel under it as UI SDK would place it. It is a
// drawing, so it is inert. Not part of the component: never in a product.
//
//   <PopoverStill phase="opening">
//     <Popover>…the same trigger and panel as in a product…</Popover>
//   </PopoverStill>
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { PopoverStillContext } from "./still-context";
import type { PopoverStillPhase, PopoverStillValue } from "./still-context";
import { stillStyles as styles } from "./still.styles";

// A picture, not a control: inert, and no pointer over it or hover on it, so nothing in it reads as
// pressable (Ruben pressed a still's buttons, 15 November).
const picture = stylex.create({ still: { pointerEvents: "none" } });

export type { PopoverStillPhase } from "./still-context";

export interface PopoverStillProps {
  /** Shut, a third of the way in, open, or a third of the way out. */
  phase: PopoverStillPhase;
  /** A phone's width: the trigger at the start of its line, the panel the width less the gutter. */
  phone?: boolean;
  /** Its own size and place in the docs: a phone's width. */
  style?: stylex.StyleXStyles;
  children: ReactNode;
}

export const PopoverStill = ({
  phase,
  phone = false,
  style,
  children,
}: PopoverStillProps) => {
  const opening = phase === "opening";
  const closing = phase === "closing";
  const look: PopoverStillValue["look"] = {
    trigger: phone && styles.phoneTrigger,
    panel: [
      styles.panel,
      phone && styles.phonePanel,
      (opening || closing) && styles.frozen,
      opening && styles.opening,
      closing && styles.closing,
    ],
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <PopoverStillContext.Provider value={{ phase, look }}>
      {/* data-force: a drawing that stands still, like a forced cell, is not a target to measure. */}
      <div
        inert
        data-force=""
        data-popover-still={phase}
        {...stylex.props(
          styles.frame,
          phone && styles.phoneFrame,
          style,
          picture.still
        )}
      >
        {children}
      </div>
    </PopoverStillContext.Provider>
  );
};
