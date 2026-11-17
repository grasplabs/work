// TooltipStill: draws a tooltip standing still, in place, for the docs: its states row. The parts
// inside are the real ones and wear their real styles; only UI SDK's behaviour is left out, so
// nothing opens, moves or takes focus. It is a drawing, so it is inert. Not part of the component:
// never in a product.
//
//   <TooltipStill phase="opening">
//     <Tooltip>…the same trigger and panel as in a product…</Tooltip>
//   </TooltipStill>
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { TooltipStillContext } from "./still-context";
import type { TooltipStillPhase, TooltipStillValue } from "./still-context";
import { stillStyles as styles } from "./still.styles";

// A picture, not a control: inert, and no pointer over it or hover on it, so nothing in it reads as
// pressable (Ruben pressed a still's buttons, 15 November).
const picture = stylex.create({ still: { pointerEvents: "none" } });

export type { TooltipStillPhase } from "./still-context";

export interface TooltipStillProps {
  /** Shut, a third of the way in, open, or a third of the way out. */
  phase: TooltipStillPhase;
  children: ReactNode;
}

/** What a still tooltip tells its parts: its phase and the panel's look. */
const stillValue = (phase: TooltipStillPhase): TooltipStillValue => {
  const opening = phase === "opening";
  const closing = phase === "closing";
  return {
    phase,
    look: {
      panel: [
        styles.panel,
        (opening || closing) && styles.frozen,
        opening && styles.opening,
        closing && styles.closing,
      ],
    },
  };
};

export const TooltipStill = ({ phase, children }: TooltipStillProps) => {
  const value = stillValue(phase);
  return (
    <TooltipStillContext.Provider value={value}>
      {/* data-force: a drawing that stands still, like a forced cell, is not a target to measure. */}
      <div
        inert
        data-force=""
        data-tooltip-still={phase}
        {...stylex.props(styles.frame, picture.still)}
      >
        {children}
      </div>
    </TooltipStillContext.Provider>
  );
};
