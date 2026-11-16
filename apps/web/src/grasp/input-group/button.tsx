// InputGroupButton: a Grasp Button (src/components/button) inside an InputGroup, at Button's small
// height and set in from the group's edge by the same room on every side: Copy, Send, Search.
"use client";

import * as stylex from "@stylexjs/stylex";

import { Button } from "../button";
import type {
  ButtonLayoutStyle,
  ButtonProps,
  ButtonVariant,
  ButtonWords,
} from "../button";
import type { IconData } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import { useGroupSize } from "./context";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The props an InputGroupButton reads first; the rest are a Button's, without its size or style. */
interface InputGroupButtonOwn {
  /**
   * The Button's weight: `ghost` inside a field, `ink` for the one step the field is for (Send).
   * @default "ghost"
   */
  variant?: ButtonVariant;
  /** The words on the button, a verb first ("Send"). Leave them out for an icon with a `label`. */
  children?: ButtonWords;
  /** An icon before the words, or the whole button with `label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** The name of an icon-only button, for a screen reader and an agent ("Copy link"). */
  label?: string;
}

/**
 * Every prop an InputGroupButton takes: these, and a Button's others. Its height is always
 * Button's `sm`, set in from the group's edge.
 */
export type InputGroupButtonProps = InputGroupButtonOwn &
  Without<ButtonProps, "size" | "style">;

const styles = stylex.create({
  md: { marginInline: `calc((${grasp.controlMd} - ${grasp.controlSm}) / 2)` },
  lg: { marginInline: `calc((${grasp.controlLg} - ${grasp.controlSm}) / 2)` },
});

/** The Button's props: small, in its variant, set in by the group's size. */
const placed = (
  rest: object,
  variant: ButtonVariant,
  inset: ButtonLayoutStyle
) => {
  const props = { ...rest, variant, size: "sm", style: inset };
  // SAFETY: the caller's own Button props, with the size and the inset the group gives it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return props as ButtonProps;
};

/** A button inside an InputGroup: Button's small height, set in from the group's edge. */
export const InputGroupButton = ({
  variant = "ghost",
  ...rest
}: InputGroupButtonProps) => {
  const size = useGroupSize();
  return <Button {...placed(rest, variant, styles[size])} />;
};
