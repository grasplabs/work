// The pair look: exactly two languages on a two-way segmented switch, each with its flag and its
// code, the pill moving to the chosen one. UI SDK's SegmentedControl gives the keys (arrows, in the
// reading direction) and marks the chosen one; each segment is named by the own name in its language.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";

import { focus } from "../focus/focus";
import { OptionFlag } from "./face";
import { dirAttribute, primaryOf } from "./options";
import type { LanguageOption } from "./options";
import { styles } from "./styles";

export interface PairProps {
  options: readonly LanguageOption[];
  value: string;
  onChoose: (code: string) => void;
  size: "sm" | "md";
  label: string;
}

export const Pair = ({ options, value, onChoose, size, label }: PairProps) => (
  <SegmentedControl
    aria-label={label}
    value={value}
    onValueChange={(next) => {
      if (next !== null) {
        onChoose(next);
      }
    }}
    {...stylex.props(styles.segmented)}
  >
    <SegmentedControlIndicator {...stylex.props(styles.pill)} />
    {options.slice(0, 2).map((option) => (
      <SegmentedControlItem
        key={option.code}
        value={option.code}
        aria-label={option.name}
        lang={option.code}
        dir={dirAttribute(option)}
        // The segment that holds focus draws one ring, on its own shape: not the browser's own
        // outline inside a ring round the whole switch.
        {...stylex.props(
          styles.segment,
          size === "sm" ? styles.segmentSm : styles.segmentMd,
          focus.ring
        )}
      >
        <OptionFlag option={option} size={size === "sm" ? "sm" : "md"} />
        <span aria-hidden>{primaryOf(option.code).toUpperCase()}</span>
      </SegmentedControlItem>
    ))}
  </SegmentedControl>
);
