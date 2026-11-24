import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { isThemeMode, ThemeToggle } from "@grasp-os/ui/components/theme-toggle";
import { Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars, pixel } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { GraspLogo } from "../connections/brand-logos.ts";
import {
  applyTheme,
  chooseTheme,
  onThemeChange,
  readTheme,
} from "../frame/theme.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import type { Pose } from "../onboarding/field/engine.ts";
import { aside } from "../onboarding/field/poses.ts";
import { StephenField } from "../onboarding/field/stephen-field.tsx";
import { useNarrow } from "../onboarding/use-narrow.ts";

// The frame every screen of someone's interview link stands in, full
// screen, outside the app, as the sign-in page before it: Grasp's mark at
// the window's top start, at its top end the language, light or dark and what the
// screen adds (as the setup's bar has them), Damsko's calm dither behind the header, and the page.
// A calm screen with nothing of its own to draw (the sign-in, a notice)
// stands on Stephen's living field instead, as the setup's screens do.

const styles = stylex.create({
  frame: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "auto 1fr",
    boxSizing: "border-box",
    height: "100svh",
    overflow: "hidden",
    // Stephen's field lies under the page, inside the frame.
    isolation: "isolate",
    backgroundColor: colors.background,
    color: colors.bodyForeground,
  },
  header: {
    position: "relative",
    zIndex: 1,
    gridColumn: "1 / -1",
    gridRow: "1",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
    height: { default: "4rem", [media.sm]: "5rem" },
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
  },
  // The header's controls: one quiet family, one gap.
  end: { display: "flex", alignItems: "center", gap: space["1"] },
  // The website's mark, as the sign-in page has it.
  brand: {
    display: "inline-flex",
    alignItems: "center",
    [iconVars.size]: "21px",
    color: colors.foreground,
    fontFamily: font.sans,
  },
  // The texture's room: the page's own ground, the texture over it.
  field: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
  },
  // The texture behind the header, across the window, at every width.
  strip: {
    gridColumn: "1 / -1",
    gridRow: "1",
    height: { default: "6rem", [media.sm]: "8rem" },
  },
  // Damsko's calm dither, as the page header's banner draws it: mint light from the top, seen
  // through the system's one pixel (a 2px square in every 3px), at the banner's faint strength, on
  // the page's own ground. Decoration: hidden from assistive tech, never moves, not drawn in forced
  // colours.
  texture: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    opacity: size.textureStrength,
    maskImage: pixel.mask,
    maskSize: "3px 3px",
    display: { default: "block", [media.forcedColors]: "none" },
    backgroundImage: `linear-gradient(to bottom, ${colors.mint}, transparent 95%)`,
  },
  // Over a surface rather than behind it: above its fill, never catching a press.
  over: { zIndex: 1 },
  main: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gridColumn: "1 / -1",
    gridRow: "2",
    minHeight: 0,
  },
});

/**
 * The size of every tool in the header, all Damsko's `sm` (32), as the
 * setup's bar has them (onboarding/calm-frame.tsx): the language, light or
 * dark, and what a screen adds (`actions`). Every tool takes its size from
 * here, never its own, so they can't drift apart.
 */
export const tool = {
  button: "icon-sm",
  select: "sm",
  toggle: "sm",
} as const;

/**
 * Whose light or dark the header keeps: the link opens outside the app,
 * before and after signing in, without the account's id, so the choice
 * made here is this browser's for the interview.
 */
const themeOwner = "interview";

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

/**
 * The language: the library's Select in its quiet form (ghost, small, no
 * box), as the setup's bar has it, so both flows share one control. Closed,
 * it says the language's own name; on a phone its short code ("EN"). Its
 * list names each in its own words.
 */
const Language = () => {
  const { t, i18n } = useLingui();
  const narrow = useNarrow();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const language = localeNames[locale];
  return (
    <Select
      items={languages.map(({ code, name }) => ({
        value: code,
        label: narrow ? code.toUpperCase() : name,
      }))}
      onValueChange={(value) => {
        if (isLocale(value)) {
          void chooseLocale(value);
        }
      }}
      value={locale}
    >
      <SelectTrigger
        aria-label={t`Language: ${language}`}
        size={tool.select}
        // Named on a pause, as the header's other tools are.
        tooltip={t`Language`}
        variant="ghost"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {languages.map(({ code, name }) => (
          <SelectItem key={code} label={name} value={code}>
            <span lang={code}>{name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/** Light, dark or the system's, as one quiet icon that steps through them, as the setup's bar has it. */
const Appearance = () => {
  const { t } = useLingui();
  // Read where it is kept, so a choice made in another tab shows here too.
  const mode = useSyncExternalStore(onThemeChange, () => readTheme(themeOwner));
  useEffect(() => {
    applyTheme(readTheme(themeOwner));
  }, []);
  return (
    <ThemeToggle
      aria-label={t`Appearance`}
      mode={mode}
      onModeChange={(next) => {
        if (isThemeMode(next)) {
          chooseTheme(themeOwner, next);
        }
      }}
      size={tool.toggle}
      tooltip={t`Light or dark`}
      variant="icon"
    />
  );
};

/** The calm dither laid over a surface (the suggested reminder time): the header's touch, nothing new. */
export const DitherOver = () => (
  <span aria-hidden="true" {...stylex.props(styles.texture, styles.over)} />
);

/**
 * The frame: the header across the window, the calm dither behind it on
 * every screen but the read-back, and the screen; on Stephen's field
 * instead, resting where `pose` says, for a calm screen.
 */
export const Frame = ({
  strip = true,
  pose,
  actions,
  children,
}: {
  /** The texture behind the header. */
  strip?: boolean;
  /** Where Stephen's field rests behind the screen; left out, he keeps out of the way and the header has its texture. */
  pose?: Pose;
  /** More at the header's end, after the language and light or dark, as the setup's bar ends with its way out. */
  actions?: ReactNode;
  children: ReactNode;
}) => {
  const screen = (
    <>
      <header {...stylex.props(styles.header)}>
        {/* Grasp's mark alone: "Grasp" is its name. */}
        <span {...stylex.props(styles.brand)}>
          <Icon icon={GraspLogo} label="Grasp" />
        </span>
        <div {...stylex.props(styles.end)}>
          <Language />
          <Appearance />
          {actions}
        </div>
      </header>
      {strip && pose === undefined ? (
        <div aria-hidden="true" {...stylex.props(styles.field, styles.strip)}>
          <span {...stylex.props(styles.texture)} />
        </div>
      ) : null}
      <main {...stylex.props(styles.main)}>{children}</main>
    </>
  );
  // Always on his field, so a screen that changes to or from the conversation never takes the
  // page out from under him (React lost track of it when it did).
  return (
    <div {...stylex.props(styles.frame)}>
      <StephenField pose={pose ?? aside}>{screen}</StephenField>
    </div>
  );
};
