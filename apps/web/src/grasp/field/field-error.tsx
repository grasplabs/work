// FieldError: what is wrong with a Field's value, under its control (field.tsx has the rest). Its
// own file because its words mean something else than the other parts' words.
"use client";

import * as stylex from "@stylexjs/stylex";
import { FieldError as FieldErrorPrimitive } from "@ui-sdk/react/field";
import type { ComponentProps, ReactNode } from "react";

import { noteStyles } from "./field";

/** Every prop a FieldError takes. */
export interface FieldErrorProps extends Omit<
  ComponentProps<typeof FieldErrorPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /**
   * What is wrong and how to put it right ("Enter your work email"). Leave it out to show the
   * browser's own message.
   */
  children?: ReactNode;
  /**
   * When it shows: `"valueMissing"`, `"typeMismatch"` or another of the browser's checks for that
   * problem only, `true` always (an error from your code, with `invalid` on the Field). Without it,
   * any problem shows it.
   */
  match?: ComponentProps<typeof FieldErrorPrimitive>["match"];
}

/** The error under the control, while the field is wrong. A screen reader says it with the control. */
export const FieldError = ({ children, ...rest }: FieldErrorProps) => (
  <FieldErrorPrimitive
    {...rest}
    {...stylex.props(noteStyles.note, noteStyles.error)}
  >
    {children}
  </FieldErrorPrimitive>
);
