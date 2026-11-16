// DrawerStill: draws a drawer or a sheet standing still, in place, for the docs' every-state row.
// The parts inside are the real ones in their real styles; only UI SDK's behaviour is left out, so
// nothing opens, moves or takes focus. The box stands in for the window. It is a drawing, so it is
// inert. Not part of the component: never in a product, and not exported from index.ts.
//
//   <DrawerStill side="right" busy>
//     <Sheet>…the same trigger and panel as in a product…</Sheet>
//   </DrawerStill>
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { DrawerStillContext } from "./still-context";
import type { DrawerStillValue } from "./still-context";
import { drawerStillStyles as styles } from "./still.styles";

export interface DrawerStillProps {
  /** The drawer or sheet, written as in a product. */
  children: ReactNode;
  /** The edge it stands at. */
  side?: DrawerStillValue["side"];
  /** A drawer resting at the lower of two heights. */
  low?: boolean;
  /** The footer's action with work to do is working. */
  busy?: boolean;
}

/** A drawer or a sheet, standing still in a box that stands in for the window. */
export const DrawerStill = ({
  children,
  side = "bottom",
  low = false,
  busy = false,
}: DrawerStillProps) => {
  const value: DrawerStillValue = {
    side,
    low,
    busy,
    look: {
      scrim: styles.scrim,
      viewport: styles.viewport,
      low: styles.low,
      high: styles.high,
    },
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <DrawerStillContext.Provider value={value}>
      <div data-drawer-still="" inert {...stylex.props(styles.frame)}>
        {children}
      </div>
    </DrawerStillContext.Provider>
  );
};
