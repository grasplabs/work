// Label: the name of a control you can see,
// in StyleX, built on UI SDK's Label, which names any control by
// `htmlFor` (an input, and also a radio group or a slider) and passes a press on to it.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Label htmlFor="team-name">Team name</Label>
//   <Label htmlFor="team-name" required>Team name</Label>      the required mark, for the eye
"use client";

import * as stylex from "@stylexjs/stylex";
import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import type { ComponentProps, ReactNode } from "react";

import { hyphenate } from "../lib/styles";
import { colors, font, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";

const styles = stylex.create({
  label: {
    display: "block",
    minWidth: 0,
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    // A long name breaks inside the word, hyphenated where its language allows. Never cut off.
    overflowWrap: "anywhere",
    cursor: "default",
    // A control that is out of use takes its label with it.
    opacity: { default: 1, ":is([data-disabled])": size.opacityDisabled },
  },
  // The required mark: a quiet asterisk after the words, drawn by the label itself (::after), so it
  // is never in the label's text: not in its textContent, not in the name it gives its control (the
  // empty alternative after the slash), not found by a page search. It is for the eye only; the
  // control's own `required` says it to a screen reader and to an agent.
  required: {
    "::after": {
      content: '"*" / ""',
      marginInlineStart: space[1],
      fontWeight: font.weightNormal,
      color: colors.mutedForeground,
    },
  },
});

type LabelPrimitiveProps = ComponentProps<typeof LabelPrimitive>;

/** Every prop a Label takes: these, and the rest of UI SDK's Label and a <label>. */
export interface LabelProps extends Omit<
  LabelPrimitiveProps,
  "className" | "style" | "children" | "render"
> {
  /** The words: what the control is, in sentence case ("Work email"). Never a question. */
  children: ReactNode;
  /** The `id` of the control it names. Leave it out when the label wraps its control. */
  htmlFor?: string;
  /**
   * Shows the required mark. Use it when the control it names is `required`.
   * @default false
   */
  required?: boolean;
  /** Where it sits: margins and alignment. Type and colour belong to the label. */
  style?: LayoutStyle;
}

export const Label = ({
  children,
  required = false,
  style,
  ...rest
}: LabelProps) => (
  <LabelPrimitive
    {...rest}
    data-slot="label"
    {...stylex.props(
      styles.label,
      hyphenate,
      required && styles.required,
      style
    )}
  >
    {children}
  </LabelPrimitive>
);
