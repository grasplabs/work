// InputGroupClear: a square at the end of an InputGroup (input-group.tsx) that empties its input
// and puts the caret back in it. On UI SDK's InputClear, so it is there only while there is text,
// and an agent can press it by its name.
"use client";

import * as stylex from "@stylexjs/stylex";
import { InputClear as ClearPrimitive } from "@ui-sdk/react/input";

import { focus } from "../focus/focus";
import { Cross, Icon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useGroupSize } from "./context";

/** Every prop an InputGroupClear takes. */
export interface InputGroupClearProps {
  /** Its name, for a screen reader, a voice command and an agent: "Clear search". */
  label: string;
}

const HOVER = media.hover;
const COARSE = media.coarse;

const styles = stylex.create({
  // A square as tall as the group, in muted, ink under a pointer, as PasswordInput's button.
  clear: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    flexShrink: 0,
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: "transparent",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  md: { width: grasp.controlMd },
  lg: { width: grasp.controlLg },
  // A finger needs 44px round it too.
  target: {
    position: "absolute",
    inset: { default: 0, [COARSE]: `calc((100% - ${grasp.tap}) / 2)` },
  },
});

/** Empties the input in its group; shown only while there is text. */
export const InputGroupClear = ({ label }: InputGroupClearProps) => {
  const size = useGroupSize();
  return (
    <ClearPrimitive
      aria-label={label}
      {...stylex.props(styles.clear, styles[size], focus.ring)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      <Icon icon={Cross} />
    </ClearPrimitive>
  );
};
