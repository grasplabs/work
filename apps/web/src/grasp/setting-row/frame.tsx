// The parts every row of a settings card is built on (setting-row.tsx, connection-row.tsx): the
// row's frame, a hairline over every row but the first, the row's least height and its sides on the
// table's inset; and the info mark beside a row's name, more about it behind a tooltip, in a box one
// line tall, so its button never makes the row taller. Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Info } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

export const rowFrame = stylex.create({
  // The row's own width is what its narrow form measures (`@container setting-row`). A hairline over
  // every row but the first: the rows of one card, apart.
  box: {
    containerType: "inline-size",
    containerName: "setting-row",
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
  },
  // Inside the hairline: setting-row tall at least, table-cell-inline at the sides.
  pad: {
    boxSizing: "border-box",
    minHeight: grasp.settingRow,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
    fontFamily: grasp.fontSans,
  },
  // The info mark, in a box one line tall: its button may be taller, the row never is.
  info: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.textSmLine,
  },
});

/** What a row's frame takes: its slot, its state for a page's own CSS, and how its inside is laid out. */
export interface RowFrameProps {
  /** The row's `data-slot` ("setting-row", "connection-row"). */
  slot: string;
  /** How the inside of the frame lays out its parts: a grid of words and control, or a column. */
  inner: stylex.StyleXStyles;
  children: ReactNode;
  "data-state"?: string;
  "data-status"?: string;
  "aria-hidden"?: boolean;
}

/** One row of a settings card: the hairline over it, and inside it the row's height and sides. */
export const RowFrame = ({ slot, inner, children, ...data }: RowFrameProps) => (
  <div data-slot={slot} {...data} {...stylex.props(rowFrame.box)}>
    <div {...stylex.props(rowFrame.pad, inner)}>{children}</div>
  </div>
);

/** What an info mark takes. */
export interface InfoMarkProps {
  /** The mark's name for a screen reader ("More about this setting"). */
  label: string;
  /** What the tooltip says. */
  children: ReactNode;
  /** A `data-slot` of its own, when a page or a check needs to find it. */
  slot?: string;
}

/** More about a row behind an info mark beside its name. */
export const InfoMark = ({ label, children, slot }: InfoMarkProps) => (
  <span data-slot={slot} {...stylex.props(rowFrame.info)}>
    <Tooltip>
      <TooltipTrigger
        icon={Info}
        aria-label={label}
        variant="ghost"
        size="xs"
      />
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  </span>
);
