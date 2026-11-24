import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { CheckIcon, ChevronRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { focusRingInset, menuStyles } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { popup } from "@grasp-os/ui/lib/tokens.values";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
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
} from "@ui-sdk/react/menu";
import type { KeyboardEvent, ReactElement } from "react";

// The person menu's panel, as the reference's (#2503's
// grasp/sidebar/profile.tsx), on UI SDK's menu, as Damsko's DropdownMenu
// is, with the reference's look on Damsko's tokens: as wide as the
// person's row, over it, on the sidebar's card, an 8px corner, items a
// row tall in the regular weight, the theme as three icon segments at the
// end of Appearance's row, a submenu of choices with a tick. Damsko's
// DropdownMenu draws a 20px corner, 36px items in the medium weight and no
// segmented row (registry gap of 24 Nov 2026).

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const HIGHLIGHTED = ":is([data-highlighted])";

/** How far the menu stands off the person's row, and a submenu off its menu. */
const MENU_GAP = 6;
const SUB_GAP = popup.gap;

const styles = stylex.create({
  // As wide as the person's row, on the sidebar's card (lighter in dark).
  panel: {
    width: "var(--anchor-width)",
    minWidth: 0,
    maxWidth: `calc(100vw - 2 * ${space.popupGutter})`,
    backgroundColor: `light-dark(${colors.sidebarCard}, oklch(0.26 0 0))`,
    borderRadius: "8px",
    cornerShape: "round",
    fontWeight: font.weightNormal,
  },
  // A submenu is as wide as its longest choice.
  subPanel: {
    width: "auto",
    minWidth: 0,
    backgroundColor: `light-dark(${colors.sidebarCard}, oklch(0.26 0 0))`,
    borderRadius: "8px",
    cornerShape: "round",
    fontWeight: font.weightNormal,
  },
  item: {
    [iconVars.size]: size.sidebarIcon,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    minHeight: {
      default: size.sidebarMenuButtonHeight,
      [COARSE]: size.tapTarget,
    },
    paddingBlock: "6px",
    paddingInline: size.sidebarRowInline,
    borderRadius: radius.sm,
    color: {
      default: colors.foreground,
      [FORCED]: { default: "CanvasText", [HIGHLIGHTED]: "HighlightText" },
    },
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "default",
    userSelect: "none",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
    backgroundColor: {
      default: "transparent",
      [HIGHLIGHTED]: { default: colors.accentHighlight, [FORCED]: "Highlight" },
    },
  },
  danger: {
    color: {
      default: colors.destructive,
      [FORCED]: { default: "CanvasText", [HIGHLIGHTED]: "HighlightText" },
    },
  },
  // A choice keeps room at its end for the tick.
  choice: {
    paddingInlineEnd: `calc(${size.sidebarRowInline} + ${size.sidebarIcon} + ${space["2"]})`,
  },
  icon: { display: "inline-flex", flexShrink: 0, color: "inherit" },
  words: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  end: { display: "inline-flex", flexShrink: 0, marginInlineStart: "auto" },
  tick: {
    position: "absolute",
    insetInlineEnd: size.sidebarRowInline,
    display: "inline-flex",
  },
  // The theme's row: its words at the start, the segments at the end.
  themeRow: {
    [iconVars.size]: size.sidebarIcon,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minHeight: {
      default: size.sidebarMenuButtonHeight,
      [COARSE]: size.tapTarget,
    },
    paddingInlineStart: size.sidebarRowInline,
    color: { default: colors.foreground, [FORCED]: "CanvasText" },
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  themeWords: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The segments, one per theme, each its icon, on a pill track.
  segments: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-grid",
    flexShrink: 0,
    gridAutoFlow: "column",
    gridAutoColumns: "minmax(0, 1fr)",
    padding: space["1"],
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  pill: {
    position: "absolute",
    insetBlock: space["1"],
    insetInlineStart: space["1"],
    width: `calc((100% - 2 * ${space["1"]}) / 3)`,
    boxSizing: "border-box",
    backgroundColor: `light-dark(${colors.sidebarCard}, oklch(0.26 0 0))`,
    borderRadius: radius.full,
    boxShadow: shadow.sm,
    borderWidth: { default: 0, [FORCED]: 2 },
    borderStyle: "solid",
    borderColor: "Highlight",
    transitionProperty: "transform",
    transitionDuration: duration.mark,
    transitionTimingFunction: duration.ease,
  },
  pill0: { transform: "translateX(0)" },
  pill1: {
    transform: {
      default: "translateX(100%)",
      ":dir(rtl)": "translateX(-100%)",
    },
  },
  pill2: {
    transform: {
      default: "translateX(200%)",
      ":dir(rtl)": "translateX(-200%)",
    },
  },
  segment: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: { default: space["5"], [COARSE]: size.tapTarget },
    paddingInline: space["1"],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: "transparent",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
    outline: "none",
    outlineStyle: {
      default: "none",
      ":is([data-highlighted]):focus-visible": "solid",
    },
    outlineWidth: size.ringWidth,
    outlineColor: colors.ring,
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
    color: {
      default: colors.mutedForeground,
      [HIGHLIGHTED]: colors.foreground,
      [HOVER]: { default: null, ":hover": colors.foreground },
      [FORCED]: "CanvasText",
    },
    transitionProperty: "color",
    transitionDuration: duration.hover,
    WebkitTapHighlightColor: "transparent",
  },
  segmentOn: { color: colors.foreground },
  separator: {
    height: size.hairline,
    marginBlock: space["1"],
    marginInline: `calc(-1 * ${space.popupPadding})`,
    backgroundColor: { default: colors.sidebarBorder, [FORCED]: "CanvasText" },
  },
});

const pills = [styles.pill0, styles.pill1, styles.pill2] as const;

/** A press of the menu: Settings, Support, Sign out. */
export interface ProfileAction {
  label: string;
  icon: IconData;
  /** The element the item is drawn as, for a link (`<Link to="/settings/profile" />`). */
  render?: ReactElement;
  onSelect?: () => void;
  danger?: boolean;
}

/** One choice of a submenu or of the theme's row. */
export interface ProfileChoice {
  label: string;
  value: string;
  icon?: IconData;
  /** Its picture: initials when true. */
  avatar?: boolean;
}

/** A submenu of choices, one of them chosen (Switch organization). */
export interface ProfileChoices {
  label: string;
  icon: IconData;
  choices: readonly ProfileChoice[];
  value: string;
  onValueChange?: (value: string) => void;
}

/** One entry of the menu: a press, a submenu, the theme's row, or a line. */
export type ProfileEntry =
  | { action: ProfileAction }
  | { choices: ProfileChoices }
  | {
      theme: {
        label: string;
        icon: IconData;
        value: string;
        choices: readonly ProfileChoice[];
        onValueChange: (value: string) => void;
      };
    }
  | "separator";

const itemClass = (danger = false) =>
  stylex.props(styles.item, danger && styles.danger, focusRingInset).className;

const Action = ({ action }: { action: ProfileAction }) => (
  <MenuItem
    className={itemClass(action.danger)}
    destructive={action.danger}
    label={action.label}
    onSelect={() => action.onSelect?.()}
    render={action.render}
  >
    <MenuItemIcon {...stylex.props(styles.icon)}>
      <Icon icon={action.icon} />
    </MenuItemIcon>
    <span {...stylex.props(styles.words)}>{action.label}</span>
  </MenuItem>
);

const Choices = ({ entry }: { entry: ProfileChoices }) => (
  <MenuSub>
    <MenuSubTrigger className={itemClass()}>
      <MenuItemIcon {...stylex.props(styles.icon)}>
        <Icon icon={entry.icon} />
      </MenuItemIcon>
      <span {...stylex.props(styles.words)}>{entry.label}</span>
      <span aria-hidden="true" {...stylex.props(styles.end)}>
        <Icon icon={ChevronRightIcon} />
      </span>
    </MenuSubTrigger>
    <MenuSubContent
      alignOffset={-popup.gap}
      collisionPadding={popup.gutter}
      sideOffset={SUB_GAP}
      {...stylex.props(menuStyles.panel, menuStyles.motion, styles.subPanel)}
    >
      <MenuRadioGroup
        onValueChange={(value: string) => entry.onValueChange?.(value)}
        value={entry.value}
      >
        {entry.choices.map((choice) => (
          <MenuRadioItem
            className={
              stylex.props(styles.item, styles.choice, focusRingInset).className
            }
            key={choice.value}
            label={choice.label}
            value={choice.value}
          >
            {choice.avatar === true ? (
              <Avatar decorative name={choice.label} size="xs">
                <AvatarFallback />
              </Avatar>
            ) : null}
            <span {...stylex.props(styles.words)}>{choice.label}</span>
            <MenuItemIndicator {...stylex.props(styles.tick)}>
              <Icon icon={CheckIcon} />
            </MenuItemIndicator>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuSubContent>
  </MenuSub>
);

/** ←/→ move along the theme's segments and choose; ↑/↓ stay the menu's. */
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

const ThemeRow = ({
  theme,
}: {
  theme: Extract<ProfileEntry, { theme: unknown }>["theme"];
}) => {
  const chosen = theme.choices.findIndex(({ value }) => value === theme.value);
  const pill = pills[chosen];
  return (
    <MenuRadioGroup
      aria-label={theme.label}
      data-slot="sidebar-theme-row"
      onValueChange={(value: string) => {
        theme.onValueChange(value);
      }}
      value={theme.value}
      {...stylex.props(styles.themeRow)}
    >
      <span aria-hidden="true" {...stylex.props(styles.themeWords)}>
        <Icon icon={theme.icon} />
        {theme.label}
      </span>
      <span {...stylex.props(styles.segments)}>
        {pill === undefined ? null : (
          <span aria-hidden="true" {...stylex.props(styles.pill, pill)} />
        )}
        {theme.choices.map((choice) => (
          <MenuRadioItem
            aria-label={choice.label}
            className={
              stylex.props(
                styles.segment,
                choice.value === theme.value && styles.segmentOn
              ).className
            }
            key={choice.value}
            label={choice.label}
            onKeyDown={alongRow}
            title={choice.label}
            value={choice.value}
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

/** The person menu's panel, over the person's row. */
export const ProfileMenu = ({
  entries,
}: {
  entries: readonly ProfileEntry[];
}) => (
  <MenuContent
    align="start"
    collisionPadding={popup.gutter}
    side="top"
    sideOffset={MENU_GAP}
    {...stylex.props(menuStyles.panel, menuStyles.motion, styles.panel)}
  >
    {entries.map((entry, index) => {
      if (entry === "separator") {
        return (
          <MenuSeparator
            key={`separator-${index}`}
            {...stylex.props(styles.separator)}
          />
        );
      }
      if ("action" in entry) {
        return <Action action={entry.action} key={entry.action.label} />;
      }
      if ("choices" in entry) {
        return <Choices entry={entry.choices} key={entry.choices.label} />;
      }
      return <ThemeRow key={entry.theme.label} theme={entry.theme} />;
    })}
  </MenuContent>
);
