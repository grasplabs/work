// RowListAdd: the row that adds one more, as Profound's empty sections: the whole row is the
// button, a quiet plus and its words ("Add trigger"). Alone in a card, it is a section's empty state.
"use client";

import * as stylex from "@stylexjs/stylex";

import { focus } from "../focus/focus";
import { Icon, Plus } from "../icons";
import { band, styles } from "./styles";

/** Every prop a RowListAdd takes. */
export interface RowListAddProps {
  /** What it adds, as a verb and a noun ("Add trigger"). */
  children: string;
  /** Runs when it is pressed: open what adds one. */
  onPress?: () => void;
  /**
   * Nothing more can be added now (the list is full, or the person may not add): the row stays in
   * its place, dimmed as a disabled Button is, and takes no press. Say why near it.
   * @default false
   */
  disabled?: boolean;
}

/** A whole row that adds one more. */
export const RowListAdd = ({
  children,
  onPress,
  disabled = false,
}: RowListAddProps) => (
  <li
    data-slot="row-list-item"
    {...stylex.props(styles.row, styles.flush, styles.lined)}
  >
    <button
      type="button"
      data-row-add=""
      disabled={disabled}
      onClick={onPress}
      {...stylex.props(
        styles.row,
        styles.add,
        disabled ? styles.addDisabled : band.on,
        focus.inside
      )}
    >
      <span {...stylex.props(styles.kind, styles.quietKind)}>
        <Icon icon={Plus} />
      </span>
      <span {...stylex.props(styles.addWords)}>{children}</span>
    </button>
  </li>
);
