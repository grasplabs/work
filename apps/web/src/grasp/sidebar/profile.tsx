// The foot of the Sidebar, as Ruben drew it (the product repo, grasp/frame/profile-menu.tsx): the
// person signed in and their organisation, a button as wide as the sidebar that opens their menu
// above it, as wide as it. What the menu holds is the product's: a list of actions and links,
// submenus of choices (switching organisation), and the theme. Our DropdownMenu gives the menu its
// behaviour (the keys, focus, an agent's reach); this file gives it his look. Its icons stay
// still, as his frame keeps them.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MenuContent,
  MenuItem,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Fragment, createElement } from "react";
import type { JSX, ReactElement } from "react";

import { Avatar } from "../avatar";
import { DropdownMenu, menuStyles } from "../dropdown-menu";
import { focus } from "../focus/focus";
import { ChevronRight, Contrast, Icon, Tick, UpDown } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";

/** One option in a submenu of choices. */
export interface SidebarChoice {
  /** What the choice is called ("Dark"). */
  label: string;
  /** Its value, given to `onValueChange`. */
  value: string;
}

/** An item in the person's menu that does something, or goes somewhere. */
export interface SidebarMenuAction {
  /** Its words: a verb or a place ("Settings", "Sign out"). Typing its first letters finds it. */
  label: string;
  /** An icon before the words. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** Runs when it is chosen, by pointer, Enter or Space. The menu closes. */
  onSelect?: () => void;
  /** Where it goes, when it is a link. */
  href?: string;
  /** The link itself, when a router draws it, or an `<a>` with its own target. */
  render?: ReactElement;
  /**
   * An item that ends something (signing out): drawn in the danger colour.
   * @default false
   */
  danger?: boolean;
}

/** An item in the person's menu that opens a submenu of choices, one of them chosen. */
export interface SidebarMenuChoices {
  /** Its words ("Switch organisation"). */
  label: string;
  /** An icon before the words. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** The choices, in order. */
  choices: readonly SidebarChoice[];
  /** The value chosen now. */
  value: string;
  /** Called with the value the person chooses. */
  onValueChange?: (value: string) => void;
  /**
   * Shows the chosen choice after its words, quieter, cut short with an ellipsis when there is no
   * room. The theme's submenu shows it; switching organisation does not, as the name is under the
   * person's already.
   * @default false
   */
  showValue?: boolean;
}

/**
 * One entry of the person's menu: an action, a submenu of choices, `"separator"`, or
 * `"appearance"`, where the theme's submenu stands.
 */
export type SidebarMenuEntry =
  | SidebarMenuAction
  | SidebarMenuChoices
  | "separator"
  | "appearance";

/** Every prop the Sidebar's `profile` takes: the person signed in, and their menu. */
export interface SidebarProfileProps {
  /** The person's name. */
  name: string;
  /** The organisation they are in, under their name. */
  organisation?: string;
  /** The person's picture, in the avatar beside their name. Without one, the avatar shows their initials. */
  picture?: string;
  /** What the menu holds, top to bottom. */
  items?: readonly SidebarMenuEntry[];
  /**
   * The theme chosen now. With it, the menu has a submenu to choose it: where `items` has
   * `"appearance"`, or else before the first separator.
   */
  theme?: string;
  /** Called with the theme the person chooses. */
  onThemeChange?: (theme: string) => void;
  /**
   * The themes to choose from.
   * @default Light, Dark and System
   */
  themes?: readonly SidebarChoice[];
  /**
   * The words of the theme's submenu.
   * @default "Appearance"
   */
  themeLabel?: string;
}

const defaultThemes: readonly SidebarChoice[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

// How far the menu stands off the button: the frame's inset, as his. A submenu overlaps its menu
// by the panel's padding, so its first item lines up with the item that opened it.
const MENU_GAP = 6;
const SUB_GAP = -popup.gap;

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;
const HIGHLIGHTED = ":is([data-highlighted])";

const styles = stylex.create({
  button: {
    [iconVars.size]: grasp.shellIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.shellIconGap,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    minHeight: {
      default: `calc(${grasp.shellNameLine} + ${grasp.shellNoteLine} + 2 * ${grasp.shellInset})`,
      [COARSE]: grasp.tap,
    },
    margin: 0,
    paddingBlock: 0,
    paddingInline: grasp.shellInset,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.shellCorner,
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
      ":is([aria-expanded=true])": grasp.shellSelected,
    },
    color: grasp.shellText,
    fontFamily: grasp.fontSans,
    textAlign: "start",
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // Open, in forced colours the fill is dropped, so a border marks it.
  buttonForced: {
    borderWidth: {
      default: 0,
      [FORCED]: { default: 0, ":is([aria-expanded=true])": grasp.hairline },
    },
  },
  who: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textSm,
    lineHeight: grasp.shellNameLine,
    letterSpacing: grasp.shellTracking,
    fontWeight: grasp.weightMedium,
    color: grasp.shellText,
  },
  organisation: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: grasp.shellNoteLine,
    color: grasp.shellTextSecondary,
  },
  chevrons: { display: "flex", flexShrink: 0, color: grasp.shellTextTertiary },
  // The person with no menu: the same place and words, no hover, no pointer.
  still: { cursor: "default", backgroundColor: "transparent" },

  // The menu: as wide as the button, on the popup's fill at a menu's lift.
  panel: {
    width: "var(--anchor-width)",
    minWidth: 0,
    maxWidth: `calc(100vw - 2 * ${grasp.popupGutter})`,
    borderRadius: grasp.shellMenuCorner,
    cornerShape: "round",
    fontWeight: grasp.weightRegular,
  },
  // A submenu is as wide as its longest choice.
  subPanel: {
    width: "auto",
    minWidth: 0,
    borderRadius: grasp.shellMenuCorner,
    cornerShape: "round",
    fontWeight: grasp.weightRegular,
  },
  item: {
    [iconVars.size]: grasp.shellIcon,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: { default: grasp.shellRow, [COARSE]: grasp.tap },
    paddingBlock: grasp.shellRowBlock,
    paddingInline: grasp.shellRowInline,
    borderRadius: grasp.shellCorner,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "default",
    userSelect: "none",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
    backgroundColor: {
      default: "transparent",
      [HIGHLIGHTED]: {
        default: grasp.itemFillHighlight,
        [FORCED]: "Highlight",
      },
    },
  },
  itemForcedText: {
    color: {
      default: grasp.ink,
      [FORCED]: { default: "CanvasText", [HIGHLIGHTED]: "HighlightText" },
    },
  },
  danger: {
    color: {
      default: grasp.danger,
      [FORCED]: { default: "CanvasText", [HIGHLIGHTED]: "HighlightText" },
    },
  },
  // A choice keeps room at its end for the tick.
  choice: {
    paddingInlineEnd: `calc(${grasp.shellRowInline} + ${grasp.shellIcon} + ${grasp.space2})`,
  },
  icon: { display: "inline-flex", flexShrink: 0, color: "inherit" },
  words: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // What is chosen in a submenu, after its trigger's words: it gives way to them, cut short.
  value: {
    flexShrink: 100,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: { default: grasp.muted, [FORCED]: "inherit" },
  },
  end: { display: "inline-flex", flexShrink: 0, marginInlineStart: "auto" },
  tick: {
    position: "absolute",
    insetInlineEnd: grasp.shellRowInline,
    display: "inline-flex",
  },
  separator: {
    height: grasp.hairline,
    marginBlock: grasp.space1,
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
});

const isChoices = (
  entry: SidebarMenuAction | SidebarMenuChoices
): entry is SidebarMenuChoices => "choices" in entry;

const itemClass = (danger = false) =>
  stylex.props(styles.item, danger ? styles.danger : styles.itemForcedText)
    .className;

const Action = ({ entry }: { entry: SidebarMenuAction }) => {
  const { href } = entry;
  // A link item: the menu renders itself into this link and gives it its words and wiring.
  const link: JSX.Element | undefined =
    href === undefined ? undefined : createElement("a", { href });
  const render = entry.render ?? link;
  return (
    <MenuItem
      label={entry.label}
      destructive={entry.danger}
      onSelect={() => entry.onSelect?.()}
      render={render}
      className={itemClass(entry.danger)}
    >
      {entry.icon !== undefined && (
        <MenuItemIcon {...stylex.props(styles.icon)}>
          <Icon icon={entry.icon} />
        </MenuItemIcon>
      )}
      <span {...stylex.props(styles.words)}>{entry.label}</span>
    </MenuItem>
  );
};

const Choices = ({ entry }: { entry: SidebarMenuChoices }) => {
  const chosen = entry.choices.find((choice) => choice.value === entry.value);
  return (
    <MenuSub>
      <MenuSubTrigger className={itemClass()}>
        {entry.icon !== undefined && (
          <MenuItemIcon {...stylex.props(styles.icon)}>
            <Icon icon={entry.icon} />
          </MenuItemIcon>
        )}
        <span {...stylex.props(styles.words)}>{entry.label}</span>
        {entry.showValue === true && chosen !== undefined && (
          <span {...stylex.props(styles.value)}>{chosen.label}</span>
        )}
        <span aria-hidden="true" {...stylex.props(styles.end)}>
          <Icon icon={ChevronRight} />
        </span>
      </MenuSubTrigger>
      <MenuSubContent
        sideOffset={SUB_GAP}
        alignOffset={SUB_GAP}
        collisionPadding={popup.gutter}
        {...stylex.props(menuStyles.panel, menuStyles.motion, styles.subPanel)}
      >
        <MenuRadioGroup
          value={entry.value}
          onValueChange={(value: string) => entry.onValueChange?.(value)}
        >
          {entry.choices.map((choice) => (
            <MenuRadioItem
              key={choice.value}
              value={choice.value}
              label={choice.label}
              className={
                stylex.props(styles.item, styles.itemForcedText, styles.choice)
                  .className
              }
            >
              <span {...stylex.props(styles.words)}>{choice.label}</span>
              <MenuItemIndicator {...stylex.props(styles.tick)}>
                <Icon icon={Tick} />
              </MenuItemIndicator>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubContent>
    </MenuSub>
  );
};

const noItems: readonly SidebarMenuEntry[] = [];

/** One entry of the menu: an item, a submenu of choices, or a separator. */
const Entry = ({ entry }: { entry: SidebarMenuEntry }) => {
  if (entry === "appearance") {
    return null;
  }
  if (entry === "separator") {
    return <MenuSeparator {...stylex.props(styles.separator)} />;
  }
  return isChoices(entry) ? (
    <Choices entry={entry} />
  ) : (
    <Action entry={entry} />
  );
};

/** The person and their organisation, and their menu. */
export const SidebarProfile = ({
  name,
  organisation,
  picture,
  items = noItems,
  theme,
  onThemeChange,
  themes = defaultThemes,
  themeLabel = "Appearance",
}: SidebarProfileProps) => {
  // The theme's submenu stands where `items` says "appearance", or else before the first
  // separator, or at the end when there is none.
  const entries: SidebarMenuEntry[] = [...items];
  const placed = entries.indexOf("appearance");
  if (placed !== -1) {
    entries.splice(placed, 1);
  }
  if (theme !== undefined) {
    const at = placed === -1 ? entries.indexOf("separator") : placed;
    const themeEntry: SidebarMenuChoices = {
      label: themeLabel,
      icon: Contrast,
      choices: themes,
      value: theme,
      onValueChange: onThemeChange,
      showValue: true,
    };
    entries.splice(at === -1 ? entries.length : at, 0, themeEntry);
  }
  const who = (
    <>
      <Avatar decorative name={name} src={picture} size="sm" />
      <span {...stylex.props(styles.who)}>
        <span {...stylex.props(styles.name)}>{name}</span>
        {organisation !== undefined && (
          <span {...stylex.props(styles.organisation)}>{organisation}</span>
        )}
      </span>
    </>
  );
  // Nothing to choose: the person, said plainly, not a button that opens nothing.
  if (entries.length === 0) {
    return <div {...stylex.props(styles.button, styles.still)}>{who}</div>;
  }
  return (
    <DropdownMenu>
      <MenuTrigger
        render={(props: Record<string, unknown>) => (
          <button type="button" {...props} />
        )}
        {...stylex.props(styles.button, styles.buttonForced, focus.ring)}
      >
        {who}
        <span aria-hidden="true" {...stylex.props(styles.chevrons)}>
          <Icon icon={UpDown} />
        </span>
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        sideOffset={MENU_GAP}
        collisionPadding={popup.gutter}
        {...stylex.props(menuStyles.panel, menuStyles.motion, styles.panel)}
      >
        {entries.map((entry, index) => (
          <Fragment
            key={
              typeof entry === "string"
                ? `${entry}-${index}`
                : `${entry.label}-${index}`
            }
          >
            <Entry entry={entry} />
          </Fragment>
        ))}
      </MenuContent>
    </DropdownMenu>
  );
};
