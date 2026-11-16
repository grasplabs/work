// AlertDialogPanel: the panel of an alert dialog (alert-dialog.tsx), with the shade behind it: UI
// SDK's AlertDialogContent and AlertDialogBackdrop in Dialog's look (src/components/dialog/styles.ts).
// It has no close button, and a press on the shade does nothing: the safe answer (Keep it) or Escape is the way out.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  AlertDialogBackdrop as BackdropPrimitive,
  AlertDialogContent as ContentPrimitive,
} from "@ui-sdk/react/alert-dialog";
import { mergeProps } from "@ui-sdk/react/primitive";
import type { ComponentProps, ReactNode } from "react";

import { panelMarker } from "../dialog/dialog.stylex";
import { useStill } from "../dialog/still-context";
import { dialogStyles as styles } from "../dialog/styles";
import { sureClose } from "../dialog/sure-close";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop an AlertDialogPanel takes: these, and the rest of UI SDK's AlertDialogContent. */
export interface AlertDialogPanelProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The title, the description and the footer, in that order. */
  children: ReactNode;
}

/**
 * The panel, with the shade behind it. In the middle of the window; a sheet along the bottom under
 * 640px. Focus starts on the first action, the safe answer.
 */
export const AlertDialogPanel = ({
  children,
  ...rest
}: AlertDialogPanelProps) => {
  const still = useStill();
  if (still) {
    if (still.phase === "closed") {
      return null;
    }
    return (
      <>
        <div
          aria-hidden="true"
          {...stylex.props(styles.scrim, still.look.scrim)}
        />
        <div
          data-slot="alert-dialog-content"
          {...stylex.props(styles.panel, styles.placed, still.look.panel)}
        >
          {children}
        </div>
      </>
    );
  }
  return (
    <>
      <BackdropPrimitive {...stylex.props(styles.scrim)} />
      <ContentPrimitive
        {...mergeProps(rest, { ref: sureClose })}
        {...stylex.props(
          panelMarker,
          styles.panel,
          styles.placed,
          styles.motion
        )}
      >
        {children}
      </ContentPrimitive>
    </>
  );
};
