import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
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
import type { ReactNode } from "react";

import { GraspLogo } from "../connections/brand-logos.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { useNarrow } from "../onboarding/use-narrow.ts";

// The frame every screen of someone's interview link stands in, full
// screen, outside the app, as the sign-in page before it: Grasp's mark at
// the window's top start, the language at its top end with what the screen
// adds before it, Damsko's calm dither behind the header, and the page.

const styles = stylex.create({
  frame: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "auto 1fr",
    boxSizing: "border-box",
    height: "100svh",
    overflow: "hidden",
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
    opacity: size.pageHeaderDitherStrength,
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
      <SelectTrigger aria-label={t`Language`} size="sm" variant="ghost">
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

/** The calm dither laid over a surface (the suggested reminder time): the header's touch, nothing new. */
export const DitherOver = () => (
  <span aria-hidden="true" {...stylex.props(styles.texture, styles.over)} />
);

/**
 * The frame: the header across the window, the calm dither behind it on
 * every screen but the read-back, and the screen.
 */
export const Frame = ({
  strip = true,
  actions,
  children,
}: {
  /** The texture behind the header. */
  strip?: boolean;
  /** More at the header's end, before the language. */
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.frame)}>
    <header {...stylex.props(styles.header)}>
      {/* Grasp's mark alone: "Grasp" is its name. */}
      <span {...stylex.props(styles.brand)}>
        <Icon icon={GraspLogo} label="Grasp" />
      </span>
      <div {...stylex.props(styles.end)}>
        {actions}
        <Language />
      </div>
    </header>
    {strip ? (
      <div aria-hidden="true" {...stylex.props(styles.field, styles.strip)}>
        <span {...stylex.props(styles.texture)} />
      </div>
    ) : null}
    <main {...stylex.props(styles.main)}>{children}</main>
  </div>
);
