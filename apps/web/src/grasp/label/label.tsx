// Label: the name of a control you can see, from shadcn's (registry/bases/base/ui/label.tsx),
// converted from Tailwind to StyleX and rebuilt on UI SDK's Label, which names any control by
// `htmlFor` (an input, and also a radio group or a slider) and passes a press on to it.
//
//   <Label htmlFor="team-name">Team name</Label>
//   <Label htmlFor="team-name" required>Team name</Label>      the required mark, for a screen too
//
// Inside a Field, use FieldLabel (src/components/field): it is this label, wired to the field's
// description and error, and it shows the required mark by itself.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import type { ComponentProps, ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";

/** What a caller may style: where the label sits. Never its type or colour. */
export type LabelLayoutStyle = LayoutStyle;

// The look of every label in Grasp UI. FieldLabel uses the same styles, so a label is one thing.
export const labelStyles = stylex.create({
  label: {
    display: "block",
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    // A long Dutch name breaks inside the word, hyphenated under lang="nl". Never cut off.
    overflowWrap: "anywhere",
    hyphens: "auto",
    cursor: "default",
    // A field that is out of use takes its label with it.
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
  },
  // The required mark: a quiet asterisk after the words. It is for the eye only; the control's own
  // `required` says it to a screen reader and to an agent.
  mark: {
    marginInlineStart: grasp.space1,
    fontWeight: grasp.weightRegular,
    color: grasp.muted,
  },
});

/** The asterisk after a required label. Hidden from screen readers: the control says it. */
export const RequiredMark = ({ layout }: { layout?: stylex.StyleXStyles }) => (
  <span
    aria-hidden="true"
    data-slot="required-mark"
    {...stylex.props(labelStyles.mark, layout)}
  >
    *
  </span>
);

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
   * Shows the required mark. Use it when the control it names is `required`; inside a Field the
   * FieldLabel shows it by itself.
   * @default false
   */
  required?: boolean;
  /** Layout only: margins and alignment. Type and colour belong to the label. */
  style?: LabelLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: LabelLayoutStyle;
}

export const Label = ({
  children,
  required = false,
  style: styleProp,
  layout,
  ...rest
}: LabelProps) => (
  <LabelPrimitive
    {...rest}
    data-slot="label"
    {...stylex.props(labelStyles.label, layout ?? styleProp)}
  >
    {children}
    {required && <RequiredMark />}
  </LabelPrimitive>
);
