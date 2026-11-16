// InputGroupText: words or an icon inside an InputGroup (input-group.tsx): a unit, a prefix such as
// "https://", or a Search icon. It is shown, never sent with the form, and a press on it focuses
// the input.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp } from "../tokens/tokens.stylex";
import { useGroupSize } from "./context";

/** Every prop an InputGroupText takes. */
export interface InputGroupTextProps {
  /** The words: a prefix ("https://"), a suffix (".com") or a unit ("GB"). Short, never a label. */
  children?: ReactNode;
  /** An icon before the words, or on its own: Search. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
}

const styles = stylex.create({
  text: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    color: grasp.muted,
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  md: {
    paddingInlineStart: { default: 0, ":nth-child(2)": grasp.space3 },
    paddingInlineEnd: { default: 0, ":last-child": grasp.space3 },
  },
  lg: {
    paddingInlineStart: { default: 0, ":nth-child(2)": grasp.space3 },
    paddingInlineEnd: { default: 0, ":last-child": grasp.space3 },
  },
});

/** Words or an icon inside an InputGroup. */
export const InputGroupText = ({ children, icon }: InputGroupTextProps) => {
  const size = useGroupSize();
  return (
    <span data-input-group-text="" {...stylex.props(styles.text, styles[size])}>
      {icon && <Icon icon={icon} />}
      {children}
    </span>
  );
};
