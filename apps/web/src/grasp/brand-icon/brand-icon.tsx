import * as stylex from "@stylexjs/stylex";

import {
  BrandApple,
  BrandChatGpt,
  BrandClaude,
  BrandChrome,
  BrandDiscord,
  BrandDropbox,
  BrandFacebook,
  BrandFigma,
  BrandFirefox,
  BrandGemini,
  BrandGitHub,
  BrandGoogle,
  BrandGoogleDocs,
  BrandGoogleDrive,
  BrandGoogleSheets,
  BrandHubSpot,
  BrandInstagram,
  BrandLinkedIn,
  BrandMicrosoft,
  BrandMistral,
  BrandNotion,
  BrandOpenRouter,
  BrandPerplexity,
  BrandSafari,
  BrandShopify,
  BrandSlack,
  BrandStripe,
  BrandTeams,
  BrandTrello,
  BrandWhatsApp,
  BrandX,
  BrandYouTube,
  BrandZoom,
  Icon,
  monoMark,
} from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/** Every brand, its mark and the name it is called by. */
export const brands = {
  apple: { mark: BrandApple, name: "Apple" },
  chatgpt: { mark: BrandChatGpt, name: "ChatGPT" },
  chrome: { mark: BrandChrome, name: "Google Chrome" },
  claude: { mark: BrandClaude, name: "Claude" },
  discord: { mark: BrandDiscord, name: "Discord" },
  dropbox: { mark: BrandDropbox, name: "Dropbox" },
  facebook: { mark: BrandFacebook, name: "Facebook" },
  figma: { mark: BrandFigma, name: "Figma" },
  firefox: { mark: BrandFirefox, name: "Firefox" },
  gemini: { mark: BrandGemini, name: "Gemini" },
  github: { mark: BrandGitHub, name: "GitHub" },
  google: { mark: BrandGoogle, name: "Google" },
  "google-docs": { mark: BrandGoogleDocs, name: "Google Docs" },
  "google-drive": { mark: BrandGoogleDrive, name: "Google Drive" },
  "google-sheets": { mark: BrandGoogleSheets, name: "Google Sheets" },
  hubspot: { mark: BrandHubSpot, name: "HubSpot" },
  instagram: { mark: BrandInstagram, name: "Instagram" },
  linkedin: { mark: BrandLinkedIn, name: "LinkedIn" },
  microsoft: { mark: BrandMicrosoft, name: "Microsoft" },
  mistral: { mark: BrandMistral, name: "Mistral AI" },
  notion: { mark: BrandNotion, name: "Notion" },
  openrouter: { mark: BrandOpenRouter, name: "OpenRouter" },
  perplexity: { mark: BrandPerplexity, name: "Perplexity" },
  safari: { mark: BrandSafari, name: "Safari" },
  shopify: { mark: BrandShopify, name: "Shopify" },
  slack: { mark: BrandSlack, name: "Slack" },
  stripe: { mark: BrandStripe, name: "Stripe" },
  teams: { mark: BrandTeams, name: "Microsoft Teams" },
  trello: { mark: BrandTrello, name: "Trello" },
  whatsapp: { mark: BrandWhatsApp, name: "WhatsApp" },
  x: { mark: BrandX, name: "X" },
  youtube: { mark: BrandYouTube, name: "YouTube" },
  zoom: { mark: BrandZoom, name: "Zoom" },
} as const satisfies Record<string, { mark: IconData; name: string }>;

/** A brand that has a mark. */
export type Brand = keyof typeof brands;

export type BrandIconSize = "xs" | "sm" | "md" | "lg";

export type BrandIconTone = "brand" | "mono";

/** Every prop a BrandIcon takes. */
export interface BrandIconProps {
  /** Whose mark: `slack`, `google`, `linkedin`, `chatgpt` and the rest of the set. Leave it out for a brand the set has no mark for, and give `name`. */
  brand?: Brand;
  /**
   * A brand with no mark in the set ("Acme CRM"): the tile shows its first letter on the tile's quiet
   * ground, in the same squircle, and the name is the tile's name for a screen reader. Ignored when
   * `brand` is given.
   */
  name?: string;
  /**
   * The tile's size, as Avatar's: `xs` 24px, `sm` 32px, `md` 40px, `lg` 48px. The mark is half of
   * it. Without a tile, the mark alone is that half.
   * @default "sm"
   */
  size?: BrandIconSize;
  /**
   * On a small tile with the system's edge, as in a list of integrations. Without it, the mark
   * alone, as beside words in a button.
   * @default true
   */
  tile?: boolean;
  /**
   * `brand`, the brand's own colours (a black or white mark follows the ink, so it stands in both
   * themes); `mono`, the same shape in the text colour, where colour would be too loud.
   * @default "brand"
   */
  tone?: BrandIconTone;
  /**
   * Hidden from screen readers and agents, when the brand's name is already in the words beside
   * it ("Sign in with Google").
   * @default false
   */
  decorative?: boolean;
}

const styles = stylex.create({
  tile: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    verticalAlign: "middle",
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
  },
  bare: {
    display: "inline-flex",
    flexShrink: 0,
    verticalAlign: "middle",
    color: "inherit",
  },
  // The tile's size, its corner (the one corner, capped at half; the mark corner under 24px) and
  // the mark at half of it.
  xs: {
    width: grasp.avatarXs,
    height: grasp.avatarXs,
    borderRadius: grasp.cornerMark,
    [iconVars.size]: `calc(${grasp.avatarXs} / 2)`,
  },
  sm: {
    width: grasp.avatarSm,
    height: grasp.avatarSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.avatarSm} / 2))`,
    [iconVars.size]: `calc(${grasp.avatarSm} / 2)`,
  },
  md: {
    width: grasp.avatarMd,
    height: grasp.avatarMd,
    borderRadius: `min(${grasp.corner}, calc(${grasp.avatarMd} / 2))`,
    [iconVars.size]: `calc(${grasp.avatarMd} / 2)`,
  },
  lg: {
    width: grasp.avatarLg,
    height: grasp.avatarLg,
    borderRadius: `min(${grasp.corner}, calc(${grasp.avatarLg} / 2))`,
    [iconVars.size]: `calc(${grasp.avatarLg} / 2)`,
  },
  // A brand with no mark: its first letter on the tile's quiet ground, the tile's own corner and edge,
  // the letter at half the tile, as the mark would be.
  fallback: {
    backgroundColor: grasp.soft,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    lineHeight: 1,
    userSelect: "none",
  },
  letterXs: { fontSize: `calc(${grasp.avatarXs} / 2)` },
  letterSm: { fontSize: `calc(${grasp.avatarSm} / 2)` },
  letterMd: { fontSize: `calc(${grasp.avatarMd} / 2)` },
  letterLg: { fontSize: `calc(${grasp.avatarLg} / 2)` },
  // Without a tile only the mark's size counts.
  bareXs: { [iconVars.size]: `calc(${grasp.avatarXs} / 2)` },
  bareSm: { [iconVars.size]: `calc(${grasp.avatarSm} / 2)` },
  bareMd: { [iconVars.size]: `calc(${grasp.avatarMd} / 2)` },
  bareLg: { [iconVars.size]: `calc(${grasp.avatarLg} / 2)` },
});

const bareSizes = {
  xs: styles.bareXs,
  sm: styles.bareSm,
  md: styles.bareMd,
  lg: styles.bareLg,
} as const;

const letterSizes = {
  xs: styles.letterXs,
  sm: styles.letterSm,
  md: styles.letterMd,
  lg: styles.letterLg,
} as const;

// The first character as a person sees it (an accent with its letter, an emoji whole), as Avatar's.
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const firstLetter = (name: string) =>
  (
    segmenter.segment(name.trim())[Symbol.iterator]().next().value?.segment ??
    ""
  ).toLocaleUpperCase();

/** A brand's mark, on a tile or alone, named by the brand unless it is decorative; a brand with no mark, its first letter on the tile. */
export const BrandIcon = ({
  brand,
  name: given,
  size = "sm",
  tile = true,
  tone = "brand",
  decorative = false,
}: BrandIconProps) => {
  if (brand === undefined) {
    const name = given ?? "";
    return (
      <span
        data-slot="brand-icon"
        data-fallback=""
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative || undefined}
        {...stylex.props(
          styles.tile,
          styles[size],
          styles.fallback,
          letterSizes[size]
        )}
      >
        <span aria-hidden="true">{firstLetter(name)}</span>
      </span>
    );
  }
  const { mark, name } = brands[brand];
  return (
    <span
      data-slot="brand-icon"
      data-brand={brand}
      data-tone={tone}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      {...stylex.props(
        tile ? [styles.tile, styles[size]] : [styles.bare, bareSizes[size]]
      )}
    >
      <Icon icon={tone === "mono" ? monoMark(mark) : mark} />
    </span>
  );
};
