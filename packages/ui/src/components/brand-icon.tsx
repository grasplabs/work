// BrandIcon: another company's mark, for an integration, a source or a way to sign in, filled and in
// its own colours, on its own or on a small tile with the system's edge, at Avatar's sizes. The
// marks are the product's: Damsko draws none. A logo is an IconData made with lib/icons'
// `filledMark`, a part in `currentColor` following the ink (a black or white mark, so it stands in
// both themes) and a part keyed `knockout` the white inside a mark.
//
//   <BrandIcon logo={SlackLogo} name="Slack" />                 a 40px tile, named "Slack"
//   <BrandIcon logo={GoogleLogo} name="Google" tile={false} size="xs" />  the mark alone, beside words
//   <BrandIcon logo={NotionLogo} name="Notion" decorative />    its name is in the words beside it
//   <BrandIcon logo={SlackLogo} name="Slack" variant="mono" />  the same shape in the text colour
//   <BrandIcon name="Acme CRM" />                               no mark: its first letter on the tile
//
//   <BrandIconGroup items={[{ logo: SlackLogo, name: "Slack" }, …]} max={3} />
//
// A group is a few brands as one row of tiles, then "+N" for the rest, named once for a screen
// reader with Avatar group's words ("Slack, Google Drive and 2 others"). The tiles stand side by
// side a step apart, never over each other: a tile's corner is not a face's circle, and a cut would
// show. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";

import { useI18n } from "../lib/i18n";
import { filledMark, Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { tileEdge } from "../lib/styles";
import { colors, font, radius, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";

/** The tile's size, as Avatar's: `xs` 24px, `sm` 32px, `default` 40px, `lg` 48px. */
export type BrandIconSize = "xs" | "sm" | "default" | "lg";

/** `brand` the mark's own colours; `mono` the same shape in the text colour. */
export type BrandIconVariant = "brand" | "mono";

/** Every prop a BrandIcon takes. */
export interface BrandIconProps {
  /**
   * The brand's mark, from the product's logos (an IconData made with `filledMark`). Leave it out
   * for a brand with no mark: the tile shows the first letter of `name` on its quiet ground.
   */
  logo?: IconData;
  /**
   * Whose mark it is, in the brand's own words ("Slack", "Google Drive"): its name for a screen
   * reader unless it is `decorative`, and the letter a brand with no mark shows.
   */
  name: string;
  /**
   * `brand`, the mark's own colours (a black or white mark follows the ink, so it stands in both
   * themes); `mono`, the same shape in the text colour, where colour would be too loud.
   * @default "brand"
   */
  variant?: BrandIconVariant;
  /**
   * The tile's size, as Avatar's: `xs` 24px, `sm` 32px, `default` 40px, `lg` 48px. The mark is
   * half of it. Without a tile, the mark alone is that half.
   * @default "default"
   */
  size?: BrandIconSize;
  /**
   * On a small tile with the system's edge, as in a list of integrations. Without it, the mark
   * alone, as beside words in a button.
   * @default true
   */
  tile?: boolean;
  /**
   * Hidden from screen readers and agents, when the brand's name is already in the words beside
   * it ("Sign in with Google").
   * @default false
   */
  decorative?: boolean;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** One brand in a group: its mark, or none for its first letter, and its name. */
export interface BrandIconGroupItem {
  /** The brand's mark; left out, the tile shows its first letter. */
  logo?: IconData;
  /** The brand's name, said in the group's name. */
  name: string;
}

/** Every prop a BrandIconGroup takes. */
export interface BrandIconGroupProps {
  /** The brands, in the order their tiles stand. */
  items: readonly BrandIconGroupItem[];
  /**
   * How many tiles show before "+N" stands for the rest.
   * @default 3
   */
  max?: number;
  /**
   * The tiles' size, as BrandIcon's.
   * @default "xs"
   */
  size?: BrandIconSize;
  /**
   * The marks' colours, as BrandIcon's: their own, or the text colour.
   * @default "brand"
   */
  variant?: BrandIconVariant;
  /**
   * Its name for a screen reader, when the brands' names are not the right one ("Connected to 5
   * tools"). Otherwise Avatar group's words (`avatar.groupName`) make it from the names it shows.
   */
  "aria-label"?: string;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  tile: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    verticalAlign: "middle",
    backgroundColor: colors.card,
    cornerShape: radius.shape,
    color: colors.foreground,
  },
  bare: {
    display: "inline-flex",
    flexShrink: 0,
    verticalAlign: "middle",
    color: "inherit",
  },
  // The tile's size, its corner (the one corner, capped at half; the mark corner under 32px) and
  // the mark at half of it.
  xs: {
    width: size.avatarXs,
    height: size.avatarXs,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    [iconVars.size]: `calc(${size.avatarXs} / 2)`,
  },
  sm: {
    width: size.avatarSm,
    height: size.avatarSm,
    borderRadius: `min(${radius.xl}, calc(${size.avatarSm} / 2))`,
    [iconVars.size]: `calc(${size.avatarSm} / 2)`,
  },
  default: {
    width: size.avatarDefault,
    height: size.avatarDefault,
    borderRadius: `min(${radius.xl}, calc(${size.avatarDefault} / 2))`,
    [iconVars.size]: `calc(${size.avatarDefault} / 2)`,
  },
  lg: {
    width: size.avatarLg,
    height: size.avatarLg,
    borderRadius: `min(${radius.xl}, calc(${size.avatarLg} / 2))`,
    [iconVars.size]: `calc(${size.avatarLg} / 2)`,
  },
  // A brand with no mark: its first letter on the tile's quiet ground, the letter at half the
  // tile, as the mark would be.
  fallback: {
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    lineHeight: 1,
    userSelect: "none",
  },
  letterXs: { fontSize: `calc(${size.avatarXs} / 2)` },
  letterSm: { fontSize: `calc(${size.avatarSm} / 2)` },
  letterDefault: { fontSize: `calc(${size.avatarDefault} / 2)` },
  letterLg: { fontSize: `calc(${size.avatarLg} / 2)` },
  // Without a tile only the mark's size counts.
  bareXs: { [iconVars.size]: `calc(${size.avatarXs} / 2)` },
  bareSm: { [iconVars.size]: `calc(${size.avatarSm} / 2)` },
  bareDefault: { [iconVars.size]: `calc(${size.avatarDefault} / 2)` },
  bareLg: { [iconVars.size]: `calc(${size.avatarLg} / 2)` },
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
    verticalAlign: "middle",
  },
  // The rest, as a tile of its own: at least a tile wide and wider for a long count, the tile's
  // corner and the system's edge, its soft fill and the count in muted ink.
  count: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    paddingInline: space["1"],
    backgroundColor: colors.muted,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
  },
  countXs: {
    minWidth: size.avatarXs,
    height: size.avatarXs,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    fontSize: `max(10px, calc(${size.avatarXs} * 0.4))`,
  },
  countSm: {
    minWidth: size.avatarSm,
    height: size.avatarSm,
    borderRadius: `min(${radius.xl}, calc(${size.avatarSm} / 2))`,
    fontSize: `max(10px, calc(${size.avatarSm} * 0.4))`,
  },
  countDefault: {
    minWidth: size.avatarDefault,
    height: size.avatarDefault,
    borderRadius: `min(${radius.xl}, calc(${size.avatarDefault} / 2))`,
    fontSize: `max(10px, calc(${size.avatarDefault} * 0.4))`,
  },
  countLg: {
    minWidth: size.avatarLg,
    height: size.avatarLg,
    borderRadius: `min(${radius.xl}, calc(${size.avatarLg} / 2))`,
    fontSize: `max(10px, calc(${size.avatarLg} * 0.4))`,
  },
});

const tiles = {
  xs: styles.xs,
  sm: styles.sm,
  default: styles.default,
  lg: styles.lg,
} as const;
const bares = {
  xs: styles.bareXs,
  sm: styles.bareSm,
  default: styles.bareDefault,
  lg: styles.bareLg,
} as const;
const letters = {
  xs: styles.letterXs,
  sm: styles.letterSm,
  default: styles.letterDefault,
  lg: styles.letterLg,
} as const;
const counts = {
  xs: styles.countXs,
  sm: styles.countSm,
  default: styles.countDefault,
  lg: styles.countLg,
} as const;

// The one-colour form of each mark, made once: its parts in `currentColor`, the gradient and the
// knockout (the white inside a mark) left out, so it is a hole there.
const monos = new WeakMap<IconData, IconData>();
const monoOf = (logo: IconData): IconData => {
  const known = monos.get(logo);
  if (known !== undefined) {
    return known;
  }
  const mono = filledMark(
    logo
      .filter(
        ([tag, attrs]) =>
          tag !== "linearGradient" && !String(attrs.key).startsWith("knockout")
      )
      .map(([tag, attrs]) => [tag, { ...attrs, fill: "currentColor" }] as const)
  );
  monos.set(logo, mono);
  return mono;
};

// The first character as a person sees it (an accent with its letter, an emoji whole), as Avatar's.
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const firstLetter = (name: string) =>
  (
    segmenter.segment(name.trim())[Symbol.iterator]().next().value?.segment ??
    ""
  ).toLocaleUpperCase();

/** A brand's mark, on a tile or alone, named by the brand unless it is decorative; a brand with no mark, its first letter on the tile. */
export const BrandIcon = ({
  logo,
  name,
  variant = "brand",
  size: sized = "default",
  tile = true,
  decorative = false,
  style,
}: BrandIconProps) => {
  const named = {
    role: decorative ? undefined : "img",
    "aria-label": decorative ? undefined : name,
    "aria-hidden": decorative || undefined,
  } as const;
  if (logo === undefined) {
    return (
      <span
        {...named}
        data-slot="brand-icon"
        data-fallback=""
        {...stylex.props(
          styles.tile,
          tileEdge,
          tiles[sized],
          styles.fallback,
          letters[sized],
          style
        )}
      >
        <span aria-hidden="true">{firstLetter(name)}</span>
      </span>
    );
  }
  return (
    <span
      {...named}
      data-slot="brand-icon"
      data-variant={variant}
      {...stylex.props(
        tile
          ? [styles.tile, tileEdge, tiles[sized]]
          : [styles.bare, bares[sized]],
        style
      )}
    >
      <Icon icon={variant === "mono" ? monoOf(logo) : logo} />
    </span>
  );
};

/** A few brands as one row of tiles, then "+N", named once. */
export const BrandIconGroup = ({
  items,
  max = 3,
  size: sized = "xs",
  variant = "brand",
  "aria-label": label,
  style,
}: BrandIconGroupProps) => {
  // Avatar group's words: the same "+N", and the same way of naming a few and how many more.
  const { avatar: words } = useI18n();
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const name =
    label ??
    words.groupName(
      shown.map((item) => item.name),
      rest
    );
  return (
    <span
      // A row of marks is one picture with one name.
      role="img"
      aria-label={name}
      data-slot="brand-icon-group"
      {...stylex.props(styles.group, style)}
    >
      {shown.map((item, index) => (
        <BrandIcon
          key={`${item.name}-${index}`}
          logo={item.logo}
          name={item.name}
          size={sized}
          variant={variant}
          decorative
        />
      ))}
      {rest > 0 && (
        <span
          aria-hidden="true"
          data-slot="brand-icon-group-count"
          {...stylex.props(styles.count, tileEdge, counts[sized])}
        >
          {words.groupCount(rest)}
        </span>
      )}
    </span>
  );
};
