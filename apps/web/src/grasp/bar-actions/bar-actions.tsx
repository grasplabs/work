// Bar actions: the one way a surface draws its actions at its top end. The App shell's bar, a
// Panel's or an Inspector panel's head, a Sheet, a Dialog and a chat's head all use it, so they
// never drift apart. The actions are small buttons (Button size="sm": quiet with words, ghost for an
// icon alone) a gap of space-2 apart, and close comes last, a ghost cross the same size. There is
// no line between them.
//
//   <BarActions close={<BarClose label="Close" onClick={close} />}>
//     <Button size="sm" variant="quiet" icon={Share}>Share</Button>
//   </BarActions>
//
// Every value is a token.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Button } from "../button";
import { Cross } from "../icons";
import { grasp } from "../tokens/tokens.stylex";

/** The size every bar action is, close included. */
export const barActionSize = "sm" as const;

export const barActionsStyles = stylex.create({
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
  },
});

/** Every prop BarActions takes. */
export interface BarActionsProps {
  /** The actions, in order: small buttons, quiet with words or ghost for an icon alone. */
  children?: ReactNode;
  /** Close, after every action: a BarClose. */
  close?: ReactNode;
}

/** The actions at a surface's top end, then its close: one gap apart, never a line between. */
export const BarActions = ({ children, close }: BarActionsProps) => (
  <div data-slot="bar-actions" {...stylex.props(barActionsStyles.actions)}>
    {children}
    {close}
  </div>
);

/** Every prop BarClose takes. */
export interface BarCloseProps {
  /** Its name for a screen reader ("Close"). */
  label: string;
  /** Closes the surface. */
  onClick?: () => void;
  /** What a primitive's close hands its render (Sheet's and Dialog's): spread onto the button. */
  primitive?: Record<string, unknown>;
}

/** Close, the last of a bar's actions: a ghost cross at the actions' size. */
export const BarClose = ({ label, onClick, primitive }: BarCloseProps) => (
  <Button
    variant="ghost"
    size={barActionSize}
    icon={Cross}
    aria-label={label}
    onClick={onClick}
    {...primitive}
  />
);
