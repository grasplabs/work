// SheetPanel: the panel of a sheet (sheet.tsx), with the shade behind it and the close button in
// its corner: UI SDK's DrawerContent, DrawerBackdrop and DrawerClose in Grasp's look.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  DrawerBackdrop as BackdropPrimitive,
  DrawerClose as ClosePrimitive,
  DrawerContent as ContentPrimitive,
} from "@ui-sdk/react/drawer";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "../button";
import { drawerMarker } from "../drawer/drawer.stylex";
import { KindContext } from "../drawer/kind-context";
import { useStill } from "../drawer/still-context";
import { drawerStyles as styles } from "../drawer/styles";
import { Cross } from "../icons";
import { useSize } from "./size-context";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a SheetPanel takes: these, and the rest of UI SDK's DrawerContent. */
export interface SheetContentProps extends Omit<
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
  /**
   * Where its close button stands: `corner`, its own; `none`, where the content puts a SheetClose
   * of its own (App shell's menu puts it in its sidebar's head, so the panel has one head).
   * @default "corner"
   */
  close?: "corner" | "none";
  /**
   * Its corner: `sheet`, the system's; `shell`, App shell's card corner, round, for the shell's
   * menu, so it reads as one of the shell's cards beside it (the page's, the peeking sidebar's).
   * @default "sheet"
   */
  corner?: "sheet" | "shell";
  /**
   * What it and its shade keep to: `window`, the browser's window; `shell`, the box App shell writes
   * on itself while its menu is open (where the shell stands), so the menu opens at the shell's
   * edge and never wider than it, in a shell narrower than the window.
   * @default "window"
   */
  bounds?: "window" | "shell";
}

/** The sheet's close button, for content that places its own (`SheetPanel close="none"`). */
export const SheetClose = ({
  label = "Close",
  size = "sm",
}: {
  label?: string;
  size?: "xs" | "sm";
}) => (
  <ClosePrimitive
    render={(props: Record<string, unknown>) => (
      <Button
        {...props}
        variant="ghost"
        size={size}
        icon={Cross}
        aria-label={label}
      />
    )}
  />
);

/** The panel, with the shade behind it and the close button in its corner. The window's height. */
export const SheetContent = ({
  children,
  closeLabel = "Close",
  close = "corner",
  corner = "sheet",
  bounds = "window",
  ...rest
}: SheetContentProps) => {
  const size = useSize();
  const still = useStill();
  if (still) {
    // Drawn standing still for the docs (src/components/drawer/still.tsx).
    return (
      <KindContext.Provider value="sheet">
        <div
          aria-hidden="true"
          {...stylex.props(styles.scrim, still.look.scrim)}
        />
        <div data-side={still.side} {...stylex.props(still.look.viewport)}>
          <div
            data-slot="drawer-content"
            data-side={still.side}
            data-state={`${still.side} ${size}`}
            {...stylex.props(
              styles.panel,
              size === "wide" && styles.wide,
              size === "full" && styles.full,
              corner === "shell" && styles.shellCorner
            )}
          >
            {children}
            <span {...stylex.props(styles.close)}>
              <Button
                variant="ghost"
                size="sm"
                icon={Cross}
                aria-label={closeLabel}
              />
            </span>
          </div>
        </div>
      </KindContext.Provider>
    );
  }
  return (
    <KindContext.Provider value="sheet">
      <BackdropPrimitive
        {...stylex.props(
          styles.scrim,
          bounds === "shell" && styles.scrimInShell
        )}
      />
      <ContentPrimitive
        {...rest}
        {...stylex.props(
          drawerMarker,
          styles.panel,
          size === "wide" && styles.wide,
          size === "full" && styles.full,
          bounds === "shell" && styles.inShell,
          bounds === "shell" && size === "wide" && styles.inShellWide,
          bounds === "shell" && size === "full" && styles.inShellFull,
          close === "none" && styles.panelClipped,
          corner === "shell" && styles.shellCorner
        )}
      >
        {children}
        {close === "corner" && (
          <span {...stylex.props(styles.close)}>
            <SheetClose label={closeLabel} />
          </span>
        )}
      </ContentPrimitive>
    </KindContext.Provider>
  );
};

/** @deprecated Use `SheetContent`. */
export const SheetPanel = SheetContent;
/** @deprecated Use `SheetContentProps`. */
export type SheetPanelProps = SheetContentProps;
