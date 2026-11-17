// The items of a Grasp menu, as data, drawn on UI SDK's menu parts: actions (with an icon, a
// shortcut, a danger tone and failure words), checkboxes, radio groups, named groups and
// separators. Context menu and Menubar share them. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
} from "@ui-sdk/react/menu";
import type {
  MenuCheckboxItemState,
  MenuItemState,
  MenuRadioItemState,
} from "@ui-sdk/react/menu";

import { listStyles } from "../combobox/list.styles";
import { Icon, Spinner, Tick } from "../icons";
import type { IconData } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";

/** An action in a menu. */
export interface MenuAction {
  /** What `onAction` receives, and how an agent may name it. Unique in the menu. */
  value: string;
  /** The words, a verb first ("Rename", "Move to trash"). */
  label: string;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** The keys that do the same from anywhere, like `"mod+d"`. Shown at the end; your page handles the keys. */
  shortcut?: string;
  /** Out of use: it can be reached but does nothing. */
  disabled?: boolean;
  /** It destroys or removes something: drawn in the danger colour. */
  danger?: boolean;
  /** For an action that can fail: the words shown on it, and given to an agent, when it does. */
  failedLabel?: string;
}

/** A setting that is on or off, with a tick while on. */
export interface MenuCheckbox {
  /** Marks this entry as a checkbox. */
  type: "checkbox";
  /** Identifies it in `onCheckedChange`. */
  value: string;
  /** What it turns on ("Show hidden files"). */
  label: string;
  /** On at first. */
  defaultChecked?: boolean;
  /** Out of use: it can be reached but does not change. */
  disabled?: boolean;
}

/** A choice of one, with a dot on the chosen one. */
export interface MenuRadioGroupEntry {
  /** Marks this entry as a radio group. */
  type: "radio-group";
  /** Identifies the group in `onValueChange`. */
  name: string;
  /** The group's name, small and quiet above it ("Sort by"). */
  label?: string;
  /** The value chosen at first. */
  defaultValue?: string;
  /** The choices; one out of use can be reached but not chosen. */
  items: { value: string; label: string; disabled?: boolean }[];
}

/** A named run of actions. */
export interface MenuGroupEntry {
  /** Marks this entry as a group. */
  type: "group";
  /** The group's name, small and quiet above it. */
  label: string;
  /** The actions in the group, in order. */
  items: MenuAction[];
}

/** A menu's items: actions, checkboxes, radio groups, groups and separators `{ type: "separator" }`. */
export type MenuEntries = (
  | MenuAction
  | MenuCheckbox
  | MenuRadioGroupEntry
  | MenuGroupEntry
  | { type: "separator" }
)[];

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  // Working: the spinner at the end turns; with reduced motion it stands still.
  spinner: {
    animationName: { default: spin, [media.reduced]: "none" },
    animationDuration: grasp.durationSpin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  failed: {
    color: grasp.danger,
  },
  pending: {
    cursor: "progress",
  },
  // A tick sits at the end, where the shortcut would.
  indicator: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: grasp.ink,
  },
  // The chosen one of a radio group: a dot in the tick's place, so one of many reads apart from the
  // tick of a setting that is on or off (eyes-a A-layers-14). As wide as an icon, as Dropdown menu's.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: grasp.iconSm,
    height: grasp.iconSm,
    marginInlineStart: "auto",
    "::before": {
      content: '""',
      width: `calc(${grasp.iconSm} * 0.375)`,
      height: `calc(${grasp.iconSm} * 0.375)`,
      borderRadius: grasp.cornerCircle,
      backgroundColor: {
        default: "currentColor",
        [media.forced]: "CanvasText",
      },
    },
  },
  // The words of an item with no icon, in a panel where another item has one: they start past an
  // empty icon slot, where the others' words do, so the words keep one edge (eyes-a A-nav-08). In a
  // panel with no icon at all they start at the item's edge.
  wordsBare: {
    paddingInlineStart: `calc(${grasp.iconSm} + ${grasp.space2})`,
  },
});

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

// The end of an action's row: a spinner while it runs, its failure words once it fails, else its
// shortcut.
const ActionEnd = ({
  entry,
  state,
  failedLabel,
}: {
  entry: MenuAction;
  state: MenuItemState;
  failedLabel: string;
}) => {
  if (state.pending) {
    return (
      <span
        aria-hidden="true"
        {...stylex.props(listStyles.itemEnd, styles.spinner)}
      >
        <Icon icon={Spinner} />
      </span>
    );
  }
  if (state.error !== undefined) {
    return (
      <span {...stylex.props(listStyles.itemEnd, styles.failed)}>
        {entry.failedLabel ?? failedLabel}
      </span>
    );
  }
  if (entry.shortcut === undefined || entry.shortcut === "") {
    return null;
  }
  return <MenuShortcut {...stylex.props(listStyles.itemEnd)} />;
};

const Action = ({
  entry,
  failedLabel,
  slot,
}: {
  entry: MenuAction;
  failedLabel: string;
  slot: boolean;
}) => (
  <MenuItem
    value={entry.value}
    label={entry.label}
    disabled={entry.disabled}
    destructive={entry.danger}
    shortcut={entry.shortcut}
    className={(state: MenuItemState) =>
      className(
        listStyles.item,
        listStyles.menuItem,
        state.highlighted && listStyles.itemHighlighted,
        // Danger keeps its colour under the highlight.
        entry.danger === true && listStyles.itemDanger,
        state.disabled && !state.pending && listStyles.itemDisabled,
        state.pending && styles.pending
      )
    }
  >
    {(state: MenuItemState) => (
      <>
        {entry.icon && (
          <MenuItemIcon
            {...stylex.props(
              listStyles.itemIcon,
              entry.danger === true && listStyles.itemIconDanger
            )}
          >
            <Icon icon={entry.icon} />
          </MenuItemIcon>
        )}
        <span
          {...stylex.props(
            listStyles.itemWords,
            slot && entry.icon === undefined && styles.wordsBare
          )}
        >
          {entry.label}
        </span>
        <ActionEnd entry={entry} state={state} failedLabel={failedLabel} />
      </>
    )}
  </MenuItem>
);

const Checkbox = ({ entry, slot }: { entry: MenuCheckbox; slot: boolean }) => (
  <MenuCheckboxItem
    value={entry.value}
    label={entry.label}
    defaultChecked={entry.defaultChecked}
    disabled={entry.disabled}
    className={(state: MenuCheckboxItemState) =>
      className(
        listStyles.item,
        listStyles.menuItem,
        state.highlighted && listStyles.itemHighlighted,
        state.disabled && listStyles.itemDisabled
      )
    }
  >
    <span {...stylex.props(listStyles.itemWords, slot && styles.wordsBare)}>
      {entry.label}
    </span>
    <MenuItemIndicator {...stylex.props(styles.indicator)}>
      <Icon icon={Tick} />
    </MenuItemIndicator>
  </MenuCheckboxItem>
);

const Radios = ({
  entry,
  slot,
}: {
  entry: MenuRadioGroupEntry;
  slot: boolean;
}) => (
  <MenuRadioGroup name={entry.name} defaultValue={entry.defaultValue}>
    {entry.label !== undefined && entry.label !== "" && (
      <MenuGroupLabel {...stylex.props(listStyles.groupLabel)}>
        {entry.label}
      </MenuGroupLabel>
    )}
    {entry.items.map((item) => (
      <MenuRadioItem
        key={item.value}
        value={item.value}
        label={item.label}
        disabled={item.disabled}
        className={(state: MenuRadioItemState) =>
          className(
            listStyles.item,
            listStyles.menuItem,
            state.highlighted && listStyles.itemHighlighted,
            state.disabled && listStyles.itemDisabled
          )
        }
      >
        <span {...stylex.props(listStyles.itemWords, slot && styles.wordsBare)}>
          {item.label}
        </span>
        <MenuItemIndicator {...stylex.props(styles.dot)} />
      </MenuRadioItem>
    ))}
  </MenuRadioGroup>
);

// Whether any action in the panel, in a group or not, has an icon: then the items without one keep
// its slot.
const hasIcon = (items: MenuEntries) =>
  items.some((entry) => {
    if (!("type" in entry)) {
      return entry.icon !== undefined;
    }
    return (
      entry.type === "group" &&
      entry.items.some((inner) => inner.icon !== undefined)
    );
  });

// One entry as its part. A separator has no value; its place in the menu is its key.
const entryView = (
  entry: MenuEntries[number],
  index: number,
  failedLabel: string,
  slot: boolean
) => {
  if (!("type" in entry)) {
    return (
      <Action
        key={entry.value}
        entry={entry}
        failedLabel={failedLabel}
        slot={slot}
      />
    );
  }
  if (entry.type === "separator") {
    return (
      <MenuSeparator
        key={`separator-${index}`}
        {...stylex.props(listStyles.separator)}
      />
    );
  }
  if (entry.type === "checkbox") {
    return <Checkbox key={entry.value} entry={entry} slot={slot} />;
  }
  if (entry.type === "radio-group") {
    return <Radios key={entry.name} entry={entry} slot={slot} />;
  }
  return (
    <MenuGroup key={`group-${entry.label}`}>
      <MenuGroupLabel {...stylex.props(listStyles.groupLabel)}>
        {entry.label}
      </MenuGroupLabel>
      {entry.items.map((inner) => (
        <Action
          key={inner.value}
          entry={inner}
          failedLabel={failedLabel}
          slot={slot}
        />
      ))}
    </MenuGroup>
  );
};

/** The items as parts, in the order they are given. */
export const MenuEntriesView = ({
  items,
  failedLabel = "Failed",
}: {
  items: MenuEntries;
  failedLabel?: string;
}) => {
  const slot = hasIcon(items);
  return items.map((entry, index) =>
    entryView(entry, index, failedLabel, slot)
  );
};

/** Every action by its value, groups included, for its failure words. */
export const actionsOf = (items: MenuEntries): Map<string, MenuAction> => {
  const map = new Map<string, MenuAction>();
  for (const entry of items) {
    if (!("type" in entry)) {
      map.set(entry.value, entry);
    } else if (entry.type === "group") {
      for (const inner of entry.items) {
        map.set(inner.value, inner);
      }
    }
  }
  return map;
};

// What a returned promise settles to, or the failure when it rejects.
const settled = async (pending: unknown, fail: () => never) => {
  try {
    return await pending;
  } catch {
    return fail();
  }
};

/**
 * Wraps `onAction` so a throw or a rejection fails with the action's failure words, and hands the
 * words to `say` for the menu's status line.
 */
export const withFailureWords =
  <D,>(
    actions: Map<string, MenuAction>,
    onAction?: (value: string, details: D) => unknown,
    say?: (words: string) => void,
    failedLabel = "Failed"
  ) =>
  (value: string, details: D) => {
    const words = actions.get(value)?.failedLabel ?? failedLabel;
    say?.("");
    const fail = () => {
      say?.(words);
      throw new Error(words);
    };
    let result: unknown;
    try {
      result = onAction?.(value, details);
    } catch {
      return fail();
    }
    const thenable =
      result !== null && typeof result === "object" && "then" in result;
    return thenable ? settled(result, fail) : result;
  };
