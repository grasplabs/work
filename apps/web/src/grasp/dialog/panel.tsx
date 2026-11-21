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

import { BarClose } from "../bar-actions/bar-actions";
import { useWords, withGiven } from "../words/words";
import { panelMarker } from "./dialog.stylex";
import { useSize } from "./size-context";
import { useStill } from "./still-context";
import { dialogStyles as styles } from "./styles";
import { watchPanel } from "./sure-close";
import { dialogWords } from "./words";
import type { DialogWords } from "./words";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a DialogPanel takes: these, and the rest of UI SDK's DialogContent. */
export interface DialogContentProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The title, the description, the body and the footer, in that order. */
  children: ReactNode;
  /**
   * The name of the close button in the corner, in the page's language. Left out, GraspWords
   * gives it (src/words), else "Close".
   * @default "Close"
   */
  closeLabel?: string;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ close: "Close the settings" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<DialogWords>;
}

/**
 * The panel, with the shade behind it and the close button in its corner. Over the page in the
 * middle of the window, `dialog-width` wide or `dialog-width-full` when the dialog is full; a sheet
 * along the bottom under 640px.
 */
export const DialogContent = ({
  children,
  closeLabel: given,
  words,
  ...rest
}: DialogContentProps) => {
  const { close: closeLabel } = withGiven(
    useWords("dialog", dialogWords, words),
    { close: given }
  );
  const still = useStill();
  const full = useSize() === "full";
  const cross = <BarClose label={closeLabel} />;
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
          {...stylex.props(
            styles.panel,
            styles.placed,
            full && styles.full,
            still.look.panel
          )}
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
        {...mergeProps(rest, { ref: watchPanel })}
        {...stylex.props(
          panelMarker,
          styles.panel,
          styles.placed,
          full && styles.full,
          styles.motion
        )}
      >
        {children}
        <span {...stylex.props(styles.close)}>
          <ClosePrimitive
            render={(props: Record<string, unknown>) => (
              <BarClose label={closeLabel} primitive={props} />
            )}
          />
        </span>
      </ContentPrimitive>
    </>
  );
};

/** @deprecated Use `DialogContent`. */
export const DialogPanel = DialogContent;
/** @deprecated Use `DialogContentProps`. */
export type DialogPanelProps = DialogContentProps;
