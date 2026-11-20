// RowListItem: one row of a RowList (row-list.tsx). Its name, the small icon of its kind before it,
// a mark after it, a quiet detail and its actions at the end. With `onPress` the whole row is one
// button, with `href` or `render` one link; its actions are still their own.
"use client";

import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { use } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { arrive } from "../motion/arrive";
import { NoActions } from "./no-actions";
import { band, styles } from "./styles";

/** Every prop a RowListItem takes. */
export interface RowListItemProps {
  /** Its name, in a few words, on one line ("Search the web"). A long one ends in an ellipsis. */
  name: string;
  /** The small icon that says what kind of thing it is, in the one accent. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** In the icon's place, a mark of its own the same size: a brand, a portrait, a source's tile. */
  media?: ReactNode;
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
  /** Makes the whole row one link, to this address. Its actions stay their own buttons. */
  href?: string;
  /**
   * The row's link drawn as the router's own (`render={<Link to="/brain/sources/q3" />}`), so it keeps
   * middle-click and the address under the pointer. Leave `href` out when the link carries it.
   */
  render?: RenderProp;
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
  const none = use(NoActions);
  if (none) {
    return null;
  }
  if (given(actions)) {
    return (
      <span data-row-actions="" {...stylex.props(styles.actions)}>
        {actions}
      </span>
    );
  }
  return <span aria-hidden {...stylex.props(styles.actions, styles.held)} />;
};

/** The row's name: its link, its button, or its words. */
const Name = ({
  name,
  linked,
  href,
  render,
  onPress,
}: Pick<RowListItemProps, "name" | "href" | "render" | "onPress"> & {
  linked: boolean;
}) => {
  if (linked) {
    return renderElement(
      "a",
      {
        href,
        "data-row-press": "",
        title: name,
        className: stylex.props(styles.press).className,
        children: name,
      },
      render
    );
  }
  if (onPress !== undefined) {
    return (
      <button
        type="button"
        data-row-press=""
        onClick={onPress}
        title={name}
        {...stylex.props(styles.press)}
      >
        {name}
      </button>
    );
  }
  return (
    <span title={name} {...stylex.props(styles.name)}>
      {name}
    </span>
  );
};

/** One 44px row: kind, name, mark, detail and actions. */
export const RowListItem = ({
  name,
  icon,
  media,
  mark,
  detail,
  actions,
  onPress,
  href,
  render,
  fresh = false,
}: RowListItemProps) => {
  const linked = (href !== undefined && href !== "") || render !== undefined;
  const pressable = linked || onPress !== undefined;
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
      {given(media) ? (
        <span data-row-kind="" {...stylex.props(styles.kind)}>
          {media}
        </span>
      ) : (
        icon !== undefined && (
          <span data-row-kind="" {...stylex.props(styles.kind)}>
            <Icon icon={icon} />
          </span>
        )
      )}
      <Name
        name={name}
        linked={linked}
        href={href}
        render={render}
        onPress={onPress}
      />
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
