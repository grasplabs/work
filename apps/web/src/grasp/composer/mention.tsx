// The mention menu of a composer (composer.tsx), after Capy's: typing @ opens it at the caret with
// the kinds of thing that can be mentioned (people, agents, skills, files), each with a line of
// help and a chevron; choosing a kind goes one level in, to the things of that kind. Typing after
// the @ searches every kind at once. Typing / at the start of a line opens the commands the same
// way, in one level. Focus stays in the text: arrows move, Enter or Tab picks, Escape closes.
//
// This file holds the menu's look and the pure helpers; the composer owns the state, because the
// keys arrive in its text.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { ChevronRight, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ComposerKind } from "./add";

/** One thing that can be mentioned: a person, an agent, a skill, a file, or a command. */
export interface ComposerMentionItem {
  /** Its own key. */
  value: string;
  /** Its name, as it goes into the text after the @ ("Amara Okafor"). */
  label: string;
  /** The `value` of its kind ("people"), or "commands" for the / menu. */
  kind: string;
  /** One quiet line ("Design lead"). */
  description?: string;
  /** Its mark. Import it from src/icons; without it, the kind's mark. */
  icon?: IconData;
}

/** One row of the open menu: a kind (to go into) or a thing (to pick). */
export type MentionRow =
  | { type: "kind"; kind: ComposerKind }
  | { type: "item"; item: ComposerMentionItem; icon?: IconData };

/** The rows the menu shows for what has been typed. */
export const mentionRows = (
  trigger: "@" | "/",
  query: string,
  level: string | null,
  kinds: ComposerKind[],
  items: ComposerMentionItem[]
): MentionRow[] => {
  const q = query.trim().toLowerCase();
  const iconOf = (item: ComposerMentionItem) =>
    item.icon ?? kinds.find((kind) => kind.value === item.kind)?.icon;
  const match = (item: ComposerMentionItem) =>
    !q ||
    item.label.toLowerCase().includes(q) ||
    item.description?.toLowerCase().includes(q) === true;
  if (trigger === "/") {
    return items
      .filter((item) => item.kind === "commands" && match(item))
      .map((item) => ({ type: "item", item, icon: iconOf(item) }));
  }
  if (level !== null && level !== "") {
    return items
      .filter((item) => item.kind === level && match(item))
      .map((item) => ({ type: "item", item, icon: iconOf(item) }));
  }
  if (!q) {
    return kinds.map((kind) => ({ type: "kind", kind }));
  }
  return items
    .filter((item) => item.kind !== "commands" && match(item))
    .map((item) => ({ type: "item", item, icon: iconOf(item) }));
};

/** Where the caret stands in a text field, as a point inside the field's box. */
export const caretPoint = (area: HTMLTextAreaElement, index: number) => {
  const mirror = document.createElement("div");
  const style = getComputedStyle(area);
  for (const property of [
    "boxSizing",
    "width",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "wordSpacing",
    "tabSize",
    "direction",
  ] as const) {
    mirror.style[property] = style[property];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "anywhere";
  mirror.textContent = area.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(marker);
  area.parentElement?.append(mirror);
  const point = {
    x: marker.offsetLeft,
    y: marker.offsetTop + marker.offsetHeight - area.scrollTop,
  };
  mirror.remove();
  return point;
};

const styles = stylex.create({
  menu: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    zIndex: 3,
    display: "grid",
    gap: grasp.hairline,
    boxSizing: "border-box",
    // Its own width, capped by the window, not by the text it opens from.
    width: `min(${grasp.mentionMenuWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxHeight: grasp.popupHeight,
    margin: 0,
    padding: grasp.space1,
    listStyle: "none",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  group: {
    margin: 0,
    paddingInline: grasp.space2,
    paddingBlock: grasp.space1,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: grasp.controlXs, [media.coarse]: grasp.tap },
    paddingInline: grasp.space2,
    paddingBlock: grasp.space1,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      ":is([aria-selected=true])": grasp.itemFillHighlight,
    },
  },
  mark: {
    display: "flex",
    flexShrink: 0,
    color: grasp.muted,
  },
  words: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // Placed at the caret, which only the text's layout knows: measured, not styled.
  atTop: (left: string, top: string) => ({ left, top }),
  atBottom: (left: string, bottom: string) => ({ left, bottom }),
  atStart: (left: string) => ({ left }),
  line: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  quiet: {
    paddingInline: grasp.space2,
    paddingBlock: grasp.space2,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

interface MenuProps {
  id: string;
  rows: MentionRow[];
  highlight: number;
  title?: string;
  loading: boolean;
  loadingLabel: string;
  emptyLabel: string;
  /** Where it stands in the text's box: its start, and its top or its bottom edge. */
  place: { x: number; top?: number; bottom?: number };
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

const placeOf = (place: MenuProps["place"]) => {
  const left = `${Math.max(0, place.x)}px`;
  if (place.top !== undefined) {
    return styles.atTop(left, `${place.top}px`);
  }
  if (place.bottom !== undefined) {
    return styles.atBottom(left, `${place.bottom}px`);
  }
  return styles.atStart(left);
};

/** The open menu, at the caret. */
export const MentionMenu = ({
  id,
  rows,
  highlight,
  title,
  loading,
  loadingLabel,
  emptyLabel,
  place,
  onPick,
  onHover,
}: MenuProps) => {
  let body: ReactNode;
  if (loading) {
    body = (
      <li role="presentation" {...stylex.props(styles.quiet)}>
        {loadingLabel}
      </li>
    );
  } else if (rows.length === 0) {
    body = (
      <li role="presentation" {...stylex.props(styles.quiet)}>
        {emptyLabel}
      </li>
    );
  } else {
    body = rows.map((row, index) => {
      const kind = row.type === "kind";
      const name = kind ? row.kind.label : row.item.label;
      const line = kind ? row.kind.description : row.item.description;
      const mark = kind ? row.kind.icon : row.icon;
      return (
        <li
          key={kind ? `kind-${row.kind.value}` : `item-${row.item.value}`}
          id={`${id}-${index}`}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- the text's combobox popup: focus stays in the text, and an <option> lives only in a <select>
          role="option"
          aria-selected={index === highlight}
          onPointerDown={(event) => {
            // Keep the focus in the text.
            event.preventDefault();
            onPick(index);
          }}
          onPointerMove={() => {
            onHover(index);
          }}
          {...stylex.props(styles.row)}
        >
          {mark && (
            <span aria-hidden="true" {...stylex.props(styles.mark)}>
              <Icon icon={mark} />
            </span>
          )}
          <span {...stylex.props(styles.words)}>
            <span {...stylex.props(styles.name)}>{name}</span>
            {line !== undefined && line !== "" && (
              <span {...stylex.props(styles.line)}>{line}</span>
            )}
          </span>
          {kind && (
            <span aria-hidden="true" {...stylex.props(styles.mark)}>
              <Icon icon={ChevronRight} />
            </span>
          )}
        </li>
      );
    });
  }
  return (
    <ul
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- the text's combobox popup, as above
      role="listbox"
      aria-label={title}
      data-slot="composer-mentions"
      {...stylex.props(popoverStyles.panel, styles.menu, placeOf(place))}
    >
      {title !== undefined && title !== "" && (
        <li role="presentation" {...stylex.props(styles.group)}>
          {title}
        </li>
      )}
      {body}
    </ul>
  );
};
