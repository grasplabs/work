// DrawerPanel: the panel of a drawer (drawer.tsx), with the shade behind it and the grip at its
// top: UI SDK's DrawerContent, DrawerBackdrop and DrawerHandle in Grasp's look.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  DrawerBackdrop as BackdropPrimitive,
  DrawerContent as ContentPrimitive,
  DrawerHandle as HandlePrimitive,
} from "@ui-sdk/react/drawer";
import type { ComponentProps, ReactNode } from "react";

import { focus } from "../focus/focus";
import { useWords, withGiven } from "../words/words";
import { drawerMarker } from "./drawer.stylex";
import { KindContext, useSnaps } from "./kind-context";
import { useStill } from "./still-context";
import { drawerStyles as styles } from "./styles";
import { drawerWords } from "./words";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a DrawerPanel takes: these, and the rest of UI SDK's DrawerContent. */
export interface DrawerContentProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The title, the description, the body and the footer, in that order. */
  children: ReactNode;
  /**
   * The name of the grip, in the page's language, when the drawer has `snapPoints`: a press on
   * it steps the drawer to its next height, and the arrow keys move it.
   * @default "Resize"
   */
  gripLabel?: string;
}

/** What the still panel says it is: low, tall with snap points, or open. */
const stateOf = (low: boolean, snaps: boolean) => {
  if (low) {
    return "low";
  }
  return snaps ? "tall" : "open";
};
/** The panel, with the shade behind it and the grip at its top. Along the bottom of the window. */
export const DrawerContent = ({
  children,
  gripLabel: gripLabelGiven,
  ...rest
}: DrawerContentProps) => {
  const { resize: gripLabel } = withGiven(useWords("drawer", drawerWords), {
    resize: gripLabelGiven,
  });
  const snaps = useSnaps();
  const still = useStill();
  if (still) {
    // Drawn standing still for the docs (still.tsx): the real styles, in place, with no behaviour.
    return (
      <KindContext.Provider value="drawer">
        <div
          aria-hidden="true"
          {...stylex.props(styles.scrim, still.look.scrim)}
        />
        <div data-side={still.side} {...stylex.props(still.look.viewport)}>
          <div
            data-slot="drawer-content"
            data-side={still.side}
            data-state={stateOf(still.low, snaps)}
            {...stylex.props(
              drawerMarker,
              styles.panel,
              snaps && styles.tall,
              snaps && !still.low && still.look.high,
              still.low && still.look.low
            )}
          >
            <div aria-hidden="true" {...stylex.props(styles.grip)}>
              <span {...stylex.props(styles.bar)} />
            </div>
            {children}
          </div>
        </div>
      </KindContext.Provider>
    );
  }
  return (
    <KindContext.Provider value="drawer">
      <BackdropPrimitive {...stylex.props(styles.scrim)} />
      <ContentPrimitive
        {...rest}
        {...stylex.props(drawerMarker, styles.panel, snaps && styles.tall)}
      >
        {snaps ? (
          <HandlePrimitive
            aria-label={gripLabel}
            {...stylex.props(styles.grip, focus.ring)}
          >
            <span aria-hidden="true" {...stylex.props(styles.bar)} />
          </HandlePrimitive>
        ) : (
          // With one height there is nothing to step to: the grip only shows it can be dragged down.
          <div aria-hidden="true" {...stylex.props(styles.grip)}>
            <span {...stylex.props(styles.bar)} />
          </div>
        )}
        {children}
      </ContentPrimitive>
    </KindContext.Provider>
  );
};

/** @deprecated Use `DrawerContent`. */
export const DrawerPanel = DrawerContent;
/** @deprecated Use `DrawerContentProps`. */
export type DrawerPanelProps = DrawerContentProps;
