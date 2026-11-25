// Theme toggle: how a person chooses light, dark or the system's look, and, when the caller offers
// them, one of the themes the stylesheet defines. One part in three forms:
//
//   segmented  Light, Dark, System, with icons; the pill moves (the default, for a header or a menu)
//   icon       one button that cycles them, for a dense toolbar
//   picker     tiles that are real miniatures of the interface, modes and themes, for settings;
//              resting on a theme's tile tells the caller, which shows it until the pointer leaves
//
//   <ThemeToggle mode={mode} onModeChange={setMode} />
//
// It is controlled: the caller holds the mode (and the theme), writes `data-mode` and `data-theme`
// where it wants them, and keeps them where it wants (storage, an account). The toggle reads and
// writes nothing itself. On the page's agent bridge its value is the mode, one of three. Its words
// come from the I18nProvider; a theme's name comes with the theme. A caller may set layout only.
"use client";

import * as stylex from "@stylexjs/stylex";
import { definePrimitive } from "@ui-sdk/core";
import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import { useId } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { CheckIcon, Icon, MonitorIcon, MoonIcon, SunIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  focusRing,
  focusWithin,
  segmentedStyles,
  tapTarget,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars, ringInsetMarker } from "../lib/vars.stylex";

/** How a person chose to see it: light, dark, or whatever the system says. */
export const themeModes = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof themeModes)[number];

/** The themes the stylesheet defines (`data-theme`, styles/themes.css). */
export const themeIds = ["evergreen", "pine", "paper"] as const;
export type ThemeId = (typeof themeIds)[number];

/** A theme the picker offers: its id, and the words its tile shows, in the page's language. */
export interface Theme {
  /** Its id, as written in `data-theme`. */
  id: ThemeId;
  /** What a person sees. */
  name: string;
  /** A few words under its tile: what it is like, at a glance. */
  line?: string;
}

/** Whether a value read from somewhere (storage, an attribute) is a mode. */
export const isThemeMode = (value: unknown): value is ThemeMode =>
  themeModes.some((mode) => mode === value);

/** Whether a value read from somewhere is one of the stylesheet's themes. */
export const isThemeId = (value: unknown): value is ThemeId =>
  themeIds.some((id) => id === value);

/** What every ThemeToggle takes, whatever its variant. */
interface ThemeToggleBase {
  /**
   * The icon button's size.
   * @default "default"
   */
  size?: "sm" | "default";
  /** The chosen mode. */
  mode: ThemeMode;
  /** Called with the mode a person or an agent chose; the caller applies and keeps it. */
  onModeChange: (mode: ThemeMode) => void;
  /** The chosen theme, of those in `themes`. */
  theme?: ThemeId;
  /** Called with the theme a person or an agent chose; the caller applies and keeps it. */
  onThemeChange?: (theme: ThemeId) => void;
  /**
   * Called with a theme while the pointer rests on its tile in the picker or focus is on it, and
   * with nothing when it leaves: show that theme meanwhile, and the chosen one again after. Shown is
   * not chosen: `theme` stays the caller's.
   */
  onThemePreview?: (theme: ThemeId | undefined) => void;
  /** The themes the picker offers under the modes, each with its name. None: modes only. */
  themes?: readonly Theme[];
  /**
   * The picker shows the themes under the modes.
   * @default true
   */
  showThemes?: boolean;
  /**
   * How wide the picker's tiles grow: `fill` shares the row out among them; `default` keeps each
   * at a tile's own width, from the row's start, for a settings column.
   * @default "fill"
   */
  tileSize?: "fill" | "default";
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/**
 * A segmented control or an icon button, named by its `aria-label`.
 * @when segmented or icon
 */
interface ThemeToggleNamed extends ThemeToggleBase {
  /**
   * `segmented` for a header or a menu; `icon` where there is no room; `picker` on a settings page.
   * @default "segmented"
   */
  variant?: "segmented" | "icon";
  /**
   * Its name, said with the choice: the name of the group of modes.
   * @default "Theme" (I18nProvider themeToggle.label)
   */
  "aria-label"?: string;
  heading?: never;
}

/**
 * A picker: its heading over the modes names their group.
 * @when picker
 */
interface ThemeTogglePicker extends ThemeToggleBase {
  variant: "picker";
  /**
   * The heading over the modes, which names their group.
   * @default "Theme" (I18nProvider themeToggle.label)
   */
  heading?: string;
  "aria-label"?: never;
}

/** Every prop a ThemeToggle takes. */
export type ThemeToggleProps = ThemeToggleNamed | ThemeTogglePicker;

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;
const HOVER = media.hover;
const COARSE = media.pointerCoarse;

// A segment's corner nests inside the track's: the one corner less the track's padding.
const SEGMENT_CORNER = `calc(${radius.xl} - ${space.toggleTrackPadding})`;

const styles = stylex.create({
  root: {
    display: "grid",
    gap: space[4],
    minWidth: 0,
    fontFamily: font.sans,
  },
  rootInline: { display: "inline-flex" },

  // ---- The icon button: the three icons in one cell ----
  icon: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "transparent",
    color: colors.foreground,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
      ":active": colors.accentActive,
    },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
    WebkitTapHighlightColor: "transparent",
  },
  // Button's corner at each size: the one corner, capped at half the height.
  iconSm: {
    width: size.controlXs,
    height: size.controlXs,
    borderRadius: `min(${radius.xl}, calc(${size.controlXs} / 2))`,
    cornerShape: radius.shape,
  },
  iconDefault: {
    width: size.controlSm,
    height: size.controlSm,
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
  },
  // The shown icon is sharp; the others blurred, a little small, and gone.
  swap: {
    gridArea: "1 / 1",
    display: "flex",
    transitionProperty: "opacity, filter, transform",
    transitionDuration: motionVars.swap,
    transitionTimingFunction: duration.ease,
  },
  swapOut: {
    opacity: 0,
    filter: { default: size.swapBlur, [REDUCED]: "none" },
    transform: { default: `scale(${size.swapScale})`, [REDUCED]: "none" },
  },
  swapIn: { opacity: 1, filter: "none", transform: "none" },

  // ---- The segmented control: three equal segments on the segmented track (segmentedStyles), the
  // pill, drawn as the track's chosen one, moves by a whole segment ----
  // The pill and each segment nest inside the track, the track's corner less its padding.
  segments: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  },
  pill: {
    position: "absolute",
    insetBlock: space.toggleTrackPadding,
    insetInlineStart: space.toggleTrackPadding,
    width: `calc((100% - 2 * ${space.toggleTrackPadding}) / 3)`,
    borderRadius: SEGMENT_CORNER,
    cornerShape: radius.shape,
    transitionProperty: "transform",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  pill0: { transform: "translateX(0)" },
  // The pill starts at the inline start; in right to left that is the right, so it moves left.
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
    gap: space[1],
    minHeight: { default: size.controlXs, [COARSE]: size.tapTarget },
    paddingInline: space[3],
    borderWidth: 0,
    backgroundColor: "transparent",
    borderRadius: SEGMENT_CORNER,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "color",
    transitionDuration: duration.hover,
    WebkitTapHighlightColor: "transparent",
  },
  // Over the pill, which in forced colours is the system's highlight.
  segmentOn: {
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  // The radio itself: native, so the browser gives the keys (arrows, right to left) and a screen
  // reader its place in the group. It covers its label, unseen; the label draws it.
  native: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "pointer",
  },

  // ---- The picker: a row of mode tiles, a row of theme tiles ----
  group: { display: "grid", gap: space[2], minWidth: 0 },
  groupLabel: {
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  tiles: {
    display: "grid",
    // Two a row on a phone: one a row, a tile grew to a tall box with its miniature in the top third.
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 7.5rem), 1fr))",
    gap: space[4],
    minWidth: 0,
  },
  // Tiles at their own width, from the row's start (tileSize="default").
  tilesDefault: {
    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, 7.5rem), ${size.pickerTile}))`,
    justifyContent: "start",
  },
  tile: {
    // Its radio covers it, and only it.
    position: "relative",
    display: "grid",
    alignContent: "start",
    gap: space[2],
    minWidth: 0,
    // Room at its foot, so its focus ring (on its edge) passes under the words, not through them.
    padding: 0,
    paddingBlockEnd: space[2],
    borderWidth: 0,
    backgroundColor: "transparent",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    textAlign: "start",
    fontFamily: font.sans,
    color: colors.foreground,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  // The miniature's frame, in the page's own theme: it holds the selected mark (ring and badge), so
  // the mark reads the same on every tile, whatever the miniature draws. It stands the miniature in
  // by a ring and a gap, so the tile's focus ring (on the frame's edge) passes clear of the
  // selection ring, never on top of it.
  frame: {
    position: "relative",
    display: "grid",
    padding: space[1],
    pointerEvents: "none",
  },
  // The selection ring: 2px of the page's foreground round the miniature, 2px clear of the focus ring.
  ring: {
    position: "absolute",
    inset: space[1],
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    boxShadow: `0 0 0 2px ${colors.foreground}`,
  },
  // The miniature: the theme's own ground, a sidebar with its current row raised, a card with
  // lines, the main action and the light, drawn in that theme's tokens on its own element.
  mini: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "28% 1fr",
    // A picture: the pointer passes through to the tile's radio under it.
    pointerEvents: "none",
    aspectRatio: "16 / 10",
    overflow: "hidden",
    backgroundColor: colors.background,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    boxShadow: size.borderStrong,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    transitionProperty: "box-shadow",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // In forced colours the shadows are dropped: the chosen miniature is edged in the system's highlight.
  miniOn: {
    borderWidth: { default: 0, [FORCED]: 3 },
    borderColor: { default: "CanvasText", [FORCED]: "Highlight" },
  },
  // The System tile: two halves cut on the diagonal, each a layer of its own over no ground, so no
  // light ground lies under the dark half to show through at the miniature's rounded edge. The
  // light half reaches 2px past the diagonal, under the dark one, so the cut has no seam either.
  // Square, edgeless layers: the miniature's own corner clips them once.
  miniSystem: { backgroundColor: "transparent" },
  half: {
    position: "absolute",
    inset: 0,
    borderRadius: 0,
    boxShadow: "none",
    borderWidth: 0,
    transitionProperty: "none",
  },
  halfLight: {
    clipPath: "polygon(0 0, calc(100% + 2px) 0, 0 calc(100% + 2px))",
  },
  halfDark: { clipPath: "polygon(100% 0, 100% 100%, 0 100%)" },
  side: {
    display: "grid",
    alignContent: "start",
    gap: space[1],
    padding: space[2],
    backgroundColor: colors.muted,
  },
  main: {
    display: "grid",
    alignContent: "start",
    gap: space[2],
    padding: space[2],
  },
  card: {
    display: "grid",
    gap: space[1],
    padding: space[2],
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    boxShadow: shadow.sm,
  },
  bar: {
    height: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.subtleForeground,
  },
  barInk: { backgroundColor: colors.foreground },
  barCurrent: {
    height: space[2],
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
  },
  w80: { width: "80%" },
  w60: { width: "60%" },
  w45: { width: "45%" },
  foot: { display: "flex", alignItems: "center", gap: space[1] },
  action: {
    width: space[6],
    height: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  light: {
    width: space[2],
    height: space[2],
    borderRadius: radius.circle,
    backgroundColor: colors.mint,
  },
  tick: {
    [iconVars.size]: size.checkboxMark,
    position: "absolute",
    // The miniature's corner, in from the frame's padding.
    insetBlockStart: `calc(2 * ${space[1]})`,
    insetInlineEnd: `calc(2 * ${space[1]})`,
    display: "grid",
    placeItems: "center",
    width: size.checkboxBox,
    height: size.checkboxBox,
    borderRadius: radius.circle,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    // A ring of the page's ground, as wide as the gap the selection ring keeps, so the badge is cut
    // out of whatever the miniature draws behind it (the System tile's light half in dark).
    boxShadow: `0 0 0 ${size.ringOffsetMark} ${colors.background}`,
  },
  // The words stand in line with the miniature's inside, clear of the tile's focus ring.
  name: {
    paddingInline: space[3],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
  line: {
    paddingInline: space[3],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
});

const icons: Record<ThemeMode, IconData> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};
const pills = [styles.pill0, styles.pill1, styles.pill2] as const;
const noThemes: readonly Theme[] = [];

/** What a mode is called, and the line under its tile. */
interface ModeWords {
  name: string;
  line: string;
}

// ---- The agent bridge -------------------------------------------------------------------------
//
// Its value is the mode, one of its three items; `setValue` chooses a mode and `setTheme` a theme,
// each by its name or id. A name that is not one of them is refused with the real ones. (Not
// `closed`: that would check the theme's name against the modes too.)

interface ThemeToggleAgentOptions {
  value?: ThemeMode;
  theme?: ThemeId;
  items?: { value: string; label: string }[];
  themes?: { value: string; label: string }[];
  noMode?: (mode: string, modes: string[]) => string;
  noTheme?: (theme: string, known: string[]) => string;
  onValueChange?: (mode: ThemeMode) => void;
  onThemeChange?: (theme: ThemeId) => void;
}

const valueOf = (
  wanted: string,
  items: { value: string; label: string }[] | undefined
) =>
  items?.find(
    (item) =>
      item.value === wanted || item.label.toLowerCase() === wanted.toLowerCase()
  )?.value;

const themeToggleAgent = definePrimitive({
  name: "theme-toggle",
  options: {
    value: "string",
    theme: "string",
    items: "value",
    themes: "value",
    noMode: "value",
    noTheme: "value",
    onValueChange: "callback",
    onThemeChange: "callback",
  },
  state: (options: ThemeToggleAgentOptions) => ({
    value: options.value,
    theme: options.theme,
    items: options.items ?? [],
  }),
  api: (context) => {
    context.onOptions((options) => {
      context.store.set({
        value: options.value,
        theme: options.theme,
        items: options.items ?? [],
      });
    });
    return {
      /** Chooses a mode: Light, Dark or System. */
      setValue: (mode: string) => {
        const { items, noMode, onValueChange } = context.options();
        const value = valueOf(mode, items);
        if (!isThemeMode(value)) {
          throw new Error(
            noMode?.(
              mode,
              (items ?? []).map((item) => item.label)
            )
          );
        }
        onValueChange?.(value);
      },
      /** Chooses a theme, by its name or id. */
      setTheme: (theme: string) => {
        const { themes, noTheme, onThemeChange } = context.options();
        const value = valueOf(theme, themes);
        if (!isThemeId(value)) {
          throw new Error(
            noTheme?.(
              theme,
              (themes ?? []).map((item) => item.label)
            )
          );
        }
        onThemeChange?.(value);
      },
    };
  },
  // The group is the part that carries the name, so an agent knows the toggle by it: the radio
  // group of the modes, or, for the icon button, the root.
  slots: (slot) => ({
    root: slot({}),
    group: slot({}),
  }),
  agent: { actions: ["setValue", "setTheme"] },
});

// ---- The parts --------------------------------------------------------------------------------

/**
 * Home and End on a native radio: the browser gives the arrows, not these; they choose the first
 * or the last radio of the group, and move focus to it.
 */
const toEnds = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Home" && event.key !== "End") {
    return;
  }
  const radios = [
    ...document.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${CSS.escape(event.currentTarget.name)}"]`
    ),
  ];
  const target = event.key === "Home" ? radios[0] : radios.at(-1);
  if (target === undefined) {
    return;
  }
  event.preventDefault();
  target.focus();
  target.click();
};

/** Light, Dark, System as native radios: arrows move and choose, in the reading direction. */
const Segmented = ({
  mode,
  label,
  words,
  onChoose,
}: {
  mode: ThemeMode;
  label: string;
  words: (mode: ThemeMode) => ModeWords;
  onChoose: (mode: ThemeMode) => void;
}) => {
  const name = useId();
  const chosen = themeModes.indexOf(mode);
  return usePart(
    themeToggleAgent,
    "group",
    {},
    {
      role: "radiogroup",
      "aria-label": label,
      // The segments touch: each one's ring is drawn just inside it (ringInsetMarker).
      ...stylex.props(segmentedStyles.track, styles.segments, ringInsetMarker),
      children: (
        <>
          {chosen !== -1 && (
            <span
              aria-hidden="true"
              {...stylex.props(
                segmentedStyles.chosen,
                styles.pill,
                pills[chosen]
              )}
            />
          )}
          {themeModes.map((each) => (
            <label
              key={each}
              {...stylex.props(
                styles.segment,
                each === mode && segmentedStyles.chosenWords,
                focusWithin
              )}
            >
              <input
                type="radio"
                name={name}
                value={each}
                checked={each === mode}
                onChange={() => {
                  onChoose(each);
                }}
                onKeyDown={toEnds}
                {...stylex.props(styles.native)}
              />
              <Icon icon={icons[each]} />
              {words(each).name}
            </label>
          ))}
        </>
      ),
    }
  );
};

/**
 * One icon button that cycles Light, Dark, System. The three icons stand in one cell and swap by
 * fading through a small blur; its name says where it is and where a press takes it.
 */
const IconButton = ({
  mode,
  size: buttonSize,
  name,
  onChoose,
}: {
  mode: ThemeMode;
  size: "sm" | "default";
  name: (current: ThemeMode, next: ThemeMode) => string;
  onChoose: (mode: ThemeMode) => void;
}) => {
  const index = themeModes.indexOf(mode);
  const next = themeModes[(index + 1) % themeModes.length] ?? "light";
  return (
    <button
      type="button"
      aria-label={name(mode, next)}
      onClick={() => {
        onChoose(next);
      }}
      {...stylex.props(
        styles.icon,
        buttonSize === "sm" ? styles.iconSm : styles.iconDefault,
        focusRing
      )}
    >
      <span aria-hidden="true" {...stylex.props(tapTarget)} />
      {themeModes.map((each) => (
        <span
          key={each}
          aria-hidden="true"
          {...stylex.props(
            styles.swap,
            each === mode ? styles.swapIn : styles.swapOut
          )}
        >
          <Icon icon={icons[each]} />
        </span>
      ))}
    </button>
  );
};

/**
 * A real miniature of the interface, drawn in the tokens of whatever theme and mode hold it. It is
 * a picture, so it is hidden from screen readers; its tile's name says what it is.
 */
const Miniature = () => (
  <>
    <span {...stylex.props(styles.side)}>
      <span {...stylex.props(styles.bar, styles.barInk, styles.w60)} />
      <span {...stylex.props(styles.bar, styles.barCurrent)} />
      <span {...stylex.props(styles.bar, styles.w80)} />
      <span {...stylex.props(styles.bar, styles.w60)} />
    </span>
    <span {...stylex.props(styles.main)}>
      <span {...stylex.props(styles.bar, styles.barInk, styles.w45)} />
      <span {...stylex.props(styles.card)}>
        <span {...stylex.props(styles.bar, styles.barInk, styles.w60)} />
        <span {...stylex.props(styles.bar, styles.w80)} />
        <span {...stylex.props(styles.foot)}>
          <span {...stylex.props(styles.action)} />
          <span {...stylex.props(styles.light)} />
        </span>
      </span>
    </span>
  </>
);

interface TileProps {
  group: string;
  value: string;
  chosen: boolean;
  theme: ThemeId | undefined;
  mode: ThemeMode;
  name: string;
  line: string;
  onChoose: () => void;
  /** A theme's tile: called as the pointer or focus comes to it, and as it leaves. */
  onPreview?: (on: boolean) => void;
  children?: ReactNode;
}

/** One tile of the picker: a native radio over a miniature, its name and its line. */
const Tile = ({
  group,
  value,
  chosen,
  theme,
  mode,
  name,
  line,
  onChoose,
  onPreview,
  children,
}: TileProps) => (
  <label
    onPointerEnter={() => {
      onPreview?.(true);
    }}
    onPointerLeave={() => {
      onPreview?.(false);
    }}
    {...stylex.props(styles.tile, focusWithin)}
  >
    <input
      type="radio"
      name={group}
      value={value}
      checked={chosen}
      onChange={onChoose}
      onKeyDown={toEnds}
      onFocus={() => {
        onPreview?.(true);
      }}
      onBlur={() => {
        onPreview?.(false);
      }}
      {...stylex.props(styles.native)}
    />
    <span aria-hidden="true" {...stylex.props(styles.frame)}>
      <span
        data-theme={theme}
        data-mode={mode}
        {...stylex.props(
          styles.mini,
          children !== undefined && styles.miniSystem,
          chosen && styles.miniOn
        )}
      >
        {children ?? <Miniature />}
      </span>
      {chosen && (
        <span
          data-slot="theme-toggle-focus-ring"
          {...stylex.props(styles.ring)}
        />
      )}
      {chosen && (
        <span {...stylex.props(styles.tick)}>
          <Icon icon={CheckIcon} />
        </span>
      )}
    </span>
    <span {...stylex.props(styles.name)}>{name}</span>
    {line !== "" && <span {...stylex.props(styles.line)}>{line}</span>}
  </label>
);

/** A row of mode tiles and, when given, a row of theme tiles. The System tile shows both halves. */
const Picker = ({
  mode,
  theme,
  themes,
  modeLabel,
  themeLabel,
  tileSize,
  words,
  onChooseMode,
  onChooseTheme,
  onPreviewTheme,
}: {
  mode: ThemeMode;
  theme: ThemeId | undefined;
  themes: readonly Theme[];
  modeLabel: string;
  themeLabel: string;
  tileSize: "fill" | "default";
  words: (mode: ThemeMode) => ModeWords;
  onChooseMode: (mode: ThemeMode) => void;
  onChooseTheme: (theme: ThemeId) => void;
  onPreviewTheme: ((theme: ThemeId | undefined) => void) | undefined;
}) => {
  const modesName = useId();
  const themesName = useId();
  const modesHeading = useId();
  const themesHeading = useId();
  const modes = usePart(
    themeToggleAgent,
    "group",
    {},
    {
      role: "radiogroup",
      "aria-labelledby": modesHeading,
      ...stylex.props(
        styles.tiles,
        tileSize === "default" && styles.tilesDefault
      ),
      children: (
        <>
          {themeModes.map((each) => (
            <Tile
              key={each}
              group={modesName}
              value={each}
              chosen={each === mode}
              theme={theme}
              mode={each === "dark" ? "dark" : "light"}
              name={words(each).name}
              line={words(each).line}
              onChoose={() => {
                onChooseMode(each);
              }}
            >
              {each === "system" ? (
                <>
                  <span
                    data-theme={theme}
                    data-mode="light"
                    {...stylex.props(
                      styles.mini,
                      styles.half,
                      styles.halfLight
                    )}
                  >
                    <Miniature />
                  </span>
                  <span
                    data-theme={theme}
                    data-mode="dark"
                    {...stylex.props(styles.mini, styles.half, styles.halfDark)}
                  >
                    <Miniature />
                  </span>
                </>
              ) : undefined}
            </Tile>
          ))}
        </>
      ),
    }
  );
  return (
    <>
      <div {...stylex.props(styles.group)}>
        <p id={modesHeading} {...stylex.props(styles.groupLabel)}>
          {modeLabel}
        </p>
        {modes}
      </div>
      {themes.length > 0 && (
        <div {...stylex.props(styles.group)}>
          <p id={themesHeading} {...stylex.props(styles.groupLabel)}>
            {themeLabel}
          </p>
          <div
            role="radiogroup"
            aria-labelledby={themesHeading}
            {...stylex.props(
              styles.tiles,
              tileSize === "default" && styles.tilesDefault
            )}
          >
            {themes.map((each) => (
              <Tile
                key={each.id}
                group={themesName}
                value={each.id}
                chosen={each.id === theme}
                theme={each.id}
                mode={mode}
                name={each.name}
                line={each.line ?? ""}
                onChoose={() => {
                  onChooseTheme(each.id);
                }}
                onPreview={(on) => {
                  onPreviewTheme?.(on ? each.id : undefined);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
};

/** Light, dark or the system's look, and the caller's themes: segmented, an icon button or a picker. */
export const ThemeToggle = ({
  variant = "segmented",
  size: buttonSize = "default",
  mode,
  onModeChange,
  theme,
  onThemeChange,
  onThemePreview,
  themes = noThemes,
  showThemes = true,
  tileSize = "fill",
  "aria-label": labelGiven,
  heading,
  style,
}: ThemeToggleProps) => {
  const { themeToggle: words } = useI18n();
  const label = heading ?? labelGiven ?? words.label;
  const wordsOf = (each: ThemeMode): ModeWords => words[each];
  const shownThemes = showThemes ? themes : [];
  const chooseTheme = (next: ThemeId) => {
    onThemeChange?.(next);
  };

  const agent = usePrimitive(themeToggleAgent, {
    value: mode,
    theme,
    items: themeModes.map((each) => ({
      value: each,
      label: wordsOf(each).name,
    })),
    themes: themes.map((each) => ({ value: each.id, label: each.name })),
    noMode: words.noMode,
    noTheme: words.noTheme,
    onValueChange: onModeChange,
    onThemeChange: chooseTheme,
  });

  const body = () => {
    if (variant === "icon") {
      return (
        <IconButton
          mode={mode}
          size={buttonSize}
          name={(current, next) =>
            words.icon(label, wordsOf(current).name, wordsOf(next).name)
          }
          onChoose={onModeChange}
        />
      );
    }
    if (variant === "picker") {
      return (
        <Picker
          mode={mode}
          theme={theme}
          themes={shownThemes}
          modeLabel={label}
          themeLabel={words.themes}
          tileSize={tileSize}
          words={wordsOf}
          onChooseMode={onModeChange}
          onChooseTheme={chooseTheme}
          onPreviewTheme={onThemePreview}
        />
      );
    }
    return (
      <Segmented
        mode={mode}
        label={label}
        words={wordsOf}
        onChoose={onModeChange}
      />
    );
  };

  return usePart(
    agent,
    "root",
    {},
    {
      // The name once: on the radio group inside, or, round the icon button, on the root as a group.
      ...(variant === "icon" ? { role: "group", "aria-label": label } : {}),
      ...stylex.props(
        styles.root,
        variant !== "picker" && styles.rootInline,
        style
      ),
      children: body(),
    }
  );
};
