// DialogPanel: the panel of a dialog (dialog.tsx), with the shade behind it and the close button
// in its corner: UI SDK's DialogContent and DialogBackdrop in Grasp's look.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  DialogBackdrop as BackdropPrimitive,
  DialogClose as ClosePrimitive,
  DialogContent as ContentPrimitive,
} from "@ui-sdk/react/dialog";
import { mergeProps } from "@ui-sdk/react/primitive";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "../button";
import { Cross } from "../icons";
import { panelMarker } from "./dialog.stylex";
import { useStill } from "./still-context";
import { dialogStyles as styles } from "./styles";
import { sureClose } from "./sure-close";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DialogPanel takes: these, and the rest of UI SDK's DialogContent. */
export interface DialogPanelProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The title, the description, the body and the footer, in that order. */
  children: ReactNode;
  /**
   * The name of the close button in the corner, in the page's language.
   * @default "Close"
   */
  closeLabel?: string;
}

/**
 * The panel, with the shade behind it and the close button in its corner. Over the page in the
 * middle of the window; a sheet along the bottom under 640px.
 */
export const DialogPanel = ({
  children,
  closeLabel = "Close",
  ...rest
}: DialogPanelProps) => {
  const still = useStill();
  const cross = (
    <Button variant="ghost" size="sm" icon={Cross} label={closeLabel} />
  );
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
          data-slot="dialog-content"
          {...stylex.props(styles.panel, styles.placed, still.look.panel)}
        >
          {children}
          <span {...stylex.props(styles.close)}>{cross}</span>
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
        <span {...stylex.props(styles.close)}>
          <ClosePrimitive
            render={(props: Record<string, unknown>) => (
              <Button
                {...props}
                variant="ghost"
                size="sm"
                icon={Cross}
                label={closeLabel}
              />
            )}
          />
        </span>
      </ContentPrimitive>
    </>
  );
};
