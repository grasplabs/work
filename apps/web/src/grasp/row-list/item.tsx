// RowListItem: one row of a RowList (row-list.tsx). Its name, the small icon of its kind before it,
// a mark after it, a quiet detail and its actions at the end. With `onPress` the whole row is one
// button, its actions still their own.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { arrive } from "../motion/arrive";
import { band, styles } from "./styles";

/** Every prop a RowListItem takes. */
export interface RowListItemProps {
  /** Its name, in a few words, on one line ("Search the web"). A long one ends in an ellipsis. */
  name: string;
  /** The small icon that says what kind of thing it is, in the one accent. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** After the name: a lock on one that cannot change, as an Icon with a `label`, or a Badge. */
  mark?: ReactNode;
  /** At the end, quiet: one short fact ("Required", "Text", "Daily"). */
  detail?: ReactNode;
  /**
   * At the end: its own buttons, RowListAction ("Remove"). Under a pointer they show when the row
   * is hovered or holds focus; on touch and for the keyboard they are always there.
   */
  actions?: ReactNode;
  /** Makes the whole row one button: open it, or edit it. Its actions stay their own buttons. */
  onPress?: () => void;
  /**
   * Just added: it fades in once, as it arrives. Nothing with reduced motion.
   * @default false
   */
  fresh?: boolean;
}

const given = (node: ReactNode): boolean =>
  node !== undefined && node !== null && node !== false && node !== "";

/** The row's end: its actions, or the room they would take when other rows have them. */
const End = ({ actions }: { actions: ReactNode }) => {
  if (given(actions)) {
    return (
      <span data-row-actions="" {...stylex.props(styles.actions)}>
        {actions}
      </span>
    );
  }
  return <span aria-hidden {...stylex.props(styles.actions, styles.held)} />;
};

/** One 44px row: kind, name, mark, detail and actions. */
export const RowListItem = ({
  name,
  icon,
  mark,
  detail,
  actions,
  onPress,
  fresh = false,
}: RowListItemProps) => {
  const pressable = onPress !== undefined;
  return (
    <li
      data-slot="row-list-item"
      {...stylex.props(
        styles.row,
        styles.lined,
        pressable && band.on,
        pressable && focus.band,
        fresh && arrive.in
      )}
    >
      {icon !== undefined && (
        <span {...stylex.props(styles.kind)}>
          <Icon icon={icon} />
        </span>
      )}
      {pressable ? (
        <button
          type="button"
          data-row-press=""
          onClick={onPress}
          title={name}
          {...stylex.props(styles.press)}
        >
          {name}
        </button>
      ) : (
        <span title={name} {...stylex.props(styles.name)}>
          {name}
        </span>
      )}
      {given(mark) && <span {...stylex.props(styles.mark)}>{mark}</span>}
      <span aria-hidden {...stylex.props(styles.spring)} />
      {given(detail) && (
        <span data-slot="row-list-detail" {...stylex.props(styles.detail)}>
          {detail}
        </span>
      )}
      <End actions={actions} />
    </li>
  );
};
