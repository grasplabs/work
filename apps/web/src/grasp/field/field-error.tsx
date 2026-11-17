// FieldError: what is wrong with a Field's value, under its control (field.tsx has the rest). Its
// own file because its words mean something else than the other parts' words. It always has words
// of its own: UI SDK's error falls back to the browser's sentence ("Please fill out this field.", in
// the browser's language) when it has none, and that never shows here.
"use client";

import * as stylex from "@stylexjs/stylex";
import { FieldError as FieldErrorPrimitive } from "@ui-sdk/react/field";
import type { ComponentProps, ReactElement } from "react";

import { noteStyles } from "./field";

/** Every prop a FieldError takes. */
export interface FieldErrorProps extends Omit<
  ComponentProps<typeof FieldErrorPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /**
   * What is wrong and how to put it right ("Enter your work email"). Always your own words: the
   * browser's own message never shows.
   */
  children: FieldErrorWords;
  /**
   * When it shows: `"valueMissing"`, `"typeMismatch"` or another of the browser's checks for that
   * problem only, `true` always (an error from your code, with `invalid` on the Field). Without it,
   * any problem shows it.
   */
  match?: ComponentProps<typeof FieldErrorPrimitive>["match"];
}

/** Words an error can have: text or elements, never empty. */
export type FieldErrorWords =
  | string
  | number
  | ReactElement
  | readonly (string | number | ReactElement)[];

/** Words that say nothing: none, an empty string, or only empty ones. */
const isEmpty = (words: unknown): boolean =>
  words === undefined ||
  words === null ||
  words === false ||
  words === "" ||
  (Array.isArray(words) && words.every(isEmpty));

/** The error under the control, while the field is wrong. A screen reader says it with the control. */
export const FieldError = ({ children, ...rest }: FieldErrorProps) => {
  // Without words of its own, nothing: UI SDK would fill in the browser's sentence.
  if (isEmpty(children)) {
    return null;
  }
  return (
    <FieldErrorPrimitive
      {...rest}
      {...stylex.props(noteStyles.note, noteStyles.error)}
    >
      {children}
    </FieldErrorPrimitive>
  );
};
