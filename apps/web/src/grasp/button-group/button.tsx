// ButtonGroupButton: a Grasp Button (src/components/button) inside a ButtonGroup: ghost, at the
// group's height, so the group's surface shows behind it and a pointer lights only the one it is on.
"use client";

import * as stylex from "@stylexjs/stylex";

import { Button } from "../button";
import type { ButtonProps, ButtonWords } from "../button";
import type { IconData } from "../icons";
import { useGroup } from "./context";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The props a ButtonGroupButton reads first; the rest are a Button's, without its look. */
interface ButtonGroupButtonOwn {
  /** The words on the button, a verb first ("Merge"). Leave them out for an icon with an `aria-label`. */
  children?: ButtonWords;
  /** An icon before the words, or the whole button with `aria-label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** The name of an icon-only button, for a screen reader and an agent ("Align left"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
}

/**
 * Every prop a ButtonGroupButton takes: these, and a Button's others. Its variant is always
 * `ghost` and its height the group's.
 */
export type ButtonGroupButtonProps = ButtonGroupButtonOwn &
  Without<ButtonProps, "variant" | "size" | "style">;

const styles = stylex.create({
  // A vertical group's buttons are as wide as the widest.
  vertical: { alignSelf: "stretch" },
});

/** A button inside a ButtonGroup. */
export const ButtonGroupButton = (props: ButtonGroupButtonProps) => {
  const { size, orientation } = useGroup();
  // The group's own stretch first, then the caller's layout, which wins where both set a property.
  return (
    <Button
      {...props}
      variant="ghost"
      size={size}
      layout={[orientation === "vertical" && styles.vertical, props.layout]}
    />
  );
};
