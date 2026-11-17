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
import type { JSX, KeyboardEvent, ReactElement } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { DropdownMenu, menuStyles } from "../dropdown-menu";
import { focus } from "../focus/focus";
import {
  ChevronRight,
  Computer,
  Contrast,
  Icon,
  Moon,
  Sun,
  Tick,
  UpDown,
} from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { switchStyles } from "../theme-switch/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";

/** One option in a submenu of choices. */
export interface SidebarChoice {
  /** What the choice is called ("Dark"). */
  label: string;
  /** Its value, given to `onValueChange`. */
  value: string;
  /**
   * An icon before its words in a submenu of choices; in the theme's row, the icon its segment
   * shows (its words are then its name). From the icons entry (`@/components/grasp/icons`).
   */
  icon?: IconData;
  /**
   * Who or what the choice is, as a small avatar before its words: `true` draws the initials of
   * `label`, a string is its picture (an organisation's logo).
   */
  avatar?: boolean | string;
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
   * The theme chosen now. With it, the menu has a row to choose it, the Theme switch's segmented
   * look inline (its words at the start, a segment per theme at the end, each with its icon): where
   * `items` has `"appearance"`, or else before the first separator. Choosing changes it at once and
   * the menu stays open.
   */
  theme?: string;
  /** Called with the theme the person chooses. */
  onThemeChange?: (theme: string) => void;
  /**
   * The themes to choose from, each a segment of the row; give each an `icon`.
   * @default Light, Dark and System, with the Sun, Moon and Computer icons
   */
  themes?: readonly SidebarChoice[];
  /**
   * The words of the theme's row, at its start, and its name to a screen reader.
   * @default "Appearance"
   */
  themeLabel?: string;
}

const defaultThemes: readonly SidebarChoice[] = [
  { label: "Light", value: "light", icon: Sun },
  { label: "Dark", value: "dark", icon: Moon },
  { label: "System", value: "system", icon: Computer },
];

const MENU_GAP = 6;
const SUB_GAP = popup.gap;

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
    // A row's side room: the avatar starts where the rows' icons and the mark do, 16px in, and the
    // chevrons end where the rows' ink ends (FLAWS.md F27: 14px, 2px before them).
    paddingInline: grasp.shellRowInline,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "CanvasText",
    // At the sidebar's foot corner, its fill nests in the surface it stands on: that corner less the
    // foot's room. The window round the shell by default, 10px (App shell FRESH.md F71, batch 4; a
    // row's 6px before); a card where the sidebar is one (a peek, a sheet, a covering card), 4px
    // (F71b): the Sidebar says which (`--grasp-sidebar-corner`).
    borderRadius: `calc(var(--grasp-sidebar-corner, ${grasp.shellWindowCorner}) - ${grasp.shellGutter})`,
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

  // The menu: as wide as the button, on the shell's popup at a menu's lift (App shell FRESH.md F84:
  // the system's popup, tinted, stood on the shell's neutral greys). Said here too, so it holds where
  // a browser with no top layer puts the menu at the document's end, outside the sidebar.
  panel: {
    width: "var(--anchor-width)",
    backgroundColor: grasp.shellPopup,
    minWidth: 0,
    maxWidth: `calc(100vw - 2 * ${grasp.popupGutter})`,
    borderRadius: grasp.shellMenuCorner,
    cornerShape: "round",
    fontWeight: grasp.weightRegular,
  },
  // A submenu is as wide as its longest choice.
  subPanel: {
    width: "auto",
    backgroundColor: grasp.shellPopup,
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
  // The theme's row: its words at the start, the Theme switch's segments at the end, on one row.
  themeRow: {
    [iconVars.size]: grasp.shellIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: grasp.shellRow, [COARSE]: grasp.tap },
    paddingInlineStart: grasp.shellRowInline,
    color: { default: grasp.ink, [FORCED]: "CanvasText" },
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  themeWords: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The segments as many as the themes, each the icon alone.
  themeSegments: {
    flexShrink: 0,
    gridTemplateColumns: "none",
    gridAutoFlow: "column",
    gridAutoColumns: "minmax(0, 1fr)",
  },
  themeSegment: {
    minHeight: { default: grasp.space5, [COARSE]: grasp.tap },
    paddingInline: grasp.space1,
    outline: "none",
    // The menu moves its highlight by the keys: the highlighted segment takes the ring.
    outlineStyle: {
      default: "none",
      ":is([data-highlighted]):focus-visible": "solid",
    },
    outlineWidth: grasp.ringWidth,
    outlineColor: grasp.ring,
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
    color: {
      default: grasp.muted,
      [HIGHLIGHTED]: grasp.ink,
      [FORCED]: "CanvasText",
    },
  },
  // Chosen, when the pill cannot stand for it (other than three themes): the pill's own fill.
  themeChosen: { backgroundColor: grasp.shellPopup, boxShadow: grasp.liftLow },
  // The chosen theme's pill: the menu's own ground lifted, as a raised pill on a raised menu (F84).
  themePill: { backgroundColor: grasp.shellPopup },
  separator: {
    height: grasp.hairline,
    marginBlock: grasp.space1,
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    backgroundColor: { default: grasp.shellPopupLine, [FORCED]: "CanvasText" },
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
        alignOffset={-popup.gap}
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
              {choice.icon !== undefined && (
                <span aria-hidden="true" {...stylex.props(styles.icon)}>
                  <Icon icon={choice.icon} />
                </span>
              )}
              {choice.avatar !== undefined && choice.avatar !== false && (
                <Avatar decorative name={choice.label} size="xs">
                  {typeof choice.avatar === "string" && (
                    <AvatarImage src={choice.avatar} />
                  )}
                  <AvatarFallback />
                </Avatar>
              )}
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

const pills = [
  switchStyles.pill0,
  switchStyles.pill1,
  switchStyles.pill2,
] as const;

/** ←/→ move along the theme's segments and choose, as on the Theme switch; ↑/↓ stay the menu's. */
const alongRow = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  const row = event.currentTarget.closest("[role=group]");
  const all =
    row === null
      ? []
      : [...row.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
  const at = all.indexOf(event.currentTarget);
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const step = (event.key === "ArrowRight") === rtl ? -1 : 1;
  const next = all[at + step];
  if (at === -1 || next === undefined) {
    return;
  }
  event.preventDefault();
  next.focus();
  next.click();
};

/** The theme's row: its words, then the Theme switch's segments, one per theme, each its icon. */
const ThemeRow = ({
  label,
  theme,
  themes,
  onThemeChange,
}: {
  label: string;
  theme: string;
  themes: readonly SidebarChoice[];
  onThemeChange?: (theme: string) => void;
}) => {
  const chosen = themes.findIndex((choice) => choice.value === theme);
  const pill = themes.length === pills.length ? pills[chosen] : undefined;
  return (
    <MenuRadioGroup
      value={theme}
      onValueChange={(value: string) => onThemeChange?.(value)}
      aria-label={label}
      data-slot="sidebar-theme-row"
      {...stylex.props(styles.themeRow)}
    >
      <span aria-hidden="true" {...stylex.props(styles.themeWords)}>
        <Icon icon={Contrast} />
        {label}
      </span>
      <span {...stylex.props(switchStyles.segments, styles.themeSegments)}>
        {pill !== undefined && (
          <span
            aria-hidden="true"
            {...stylex.props(switchStyles.pill, pill, styles.themePill)}
          />
        )}
        {themes.map((choice) => (
          <MenuRadioItem
            key={choice.value}
            value={choice.value}
            label={choice.label}
            aria-label={choice.label}
            title={choice.label}
            onKeyDown={alongRow}
            className={
              stylex.props(
                switchStyles.segment,
                choice.value === theme && switchStyles.segmentOn,
                styles.themeSegment,
                pill === undefined &&
                  choice.value === theme &&
                  styles.themeChosen
              ).className
            }
          >
            {choice.icon === undefined ? (
              choice.label
            ) : (
              <Icon icon={choice.icon} />
            )}
          </MenuRadioItem>
        ))}
      </span>
    </MenuRadioGroup>
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
    entries.splice(at === -1 ? entries.length : at, 0, "appearance");
  }
  const who = (
    <>
      <Avatar decorative name={name} size="sm">
        <AvatarImage src={picture} />
        <AvatarFallback />
      </Avatar>
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
            {entry === "appearance" && theme !== undefined ? (
              <ThemeRow
                label={themeLabel}
                theme={theme}
                themes={themes}
                onThemeChange={onThemeChange}
              />
            ) : (
              <Entry entry={entry} />
            )}
          </Fragment>
        ))}
      </MenuContent>
    </DropdownMenu>
  );
};
