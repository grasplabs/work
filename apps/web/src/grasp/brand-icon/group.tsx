// Brand icon group: a few brands as one row of tiles, then "+N" for the rest, named once for a
// screen reader ("Slack, Google Drive and 2 others"): the tools an agent or a workflow reaches, in a
// table's row or a card's foot. As Avatar group does, with its words; the tiles stand side by side
// a step apart, never over each other, since a tile's corner is not a face's circle and a cut
// would show. Every value is a token.
//
//   <BrandIconGroup brands={["slack", "google-drive", "notion", "stripe", "github"]} max={3} />
"use client";

import * as stylex from "@stylexjs/stylex";

import { groupMoreStyles } from "../avatar/more.styles";
import { avatarGroupWords } from "../avatar/words";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { BrandIcon, brands } from "./brand-icon";
import type { Brand, BrandIconSize, BrandIconTone } from "./brand-icon";

/** One brand in a group: a key of the set, or a brand with no mark by its name. */
export type BrandIconGroupEntry = Brand | { name: string };

/** Every prop a BrandIconGroup takes. */
export interface BrandIconGroupProps {
  /**
   * The brands, in the order their tiles stand: a brand in the set by its key (`"slack"`), or one with
   * no mark by its name (`{ name: "Acme CRM" }`), which shows its first letter on the tile.
   */
  brands: readonly BrandIconGroupEntry[];
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
  tone?: BrandIconTone;
  /** Its name for a screen reader, when the brands' names are not the right one ("Connected to 5 tools"). */
  "aria-label"?: string;
}

const sizes: Record<BrandIconSize, string> = {
  xs: grasp.avatarXs,
  sm: grasp.avatarSm,
  md: grasp.avatarMd,
  lg: grasp.avatarLg,
};

const styles = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
    verticalAlign: "middle",
  },
  // The rest, as a tile of its own (Avatar group's "+N", src/components/avatar/more.styles.ts): at
  // least a tile wide and wider for a long count, the tile's corner and the system's edge.
  more: (tile: string, corner: string) => ({
    minWidth: tile,
    borderRadius: corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
  }),
});

/** A few brands as one row of tiles, then "+N", named once. */
export const BrandIconGroup = ({
  brands: list,
  max = 3,
  size = "xs",
  tone = "brand",
  "aria-label": label,
}: BrandIconGroupProps) => {
  // Avatar group's words: the same "+N", and the same way of naming a few and how many more.
  const words = useWords("avatarGroup", avatarGroupWords);
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  const name =
    label ??
    words.name(
      shown.map((entry) =>
        typeof entry === "string" ? brands[entry].name : entry.name
      ),
      rest
    );
  // BrandIcon's corner for the size: the mark corner under 32px, else the one corner capped at half.
  const tile = sizes[size];
  const corner =
    size === "xs"
      ? grasp.cornerMark
      : `min(${grasp.corner}, calc(${tile} / 2))`;
  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a row of marks is one picture with one name
      role="img"
      aria-label={name}
      data-slot="brand-icon-group"
      {...stylex.props(styles.group)}
    >
      {shown.map((entry, index) =>
        typeof entry === "string" ? (
          <BrandIcon
            key={`${entry}-${index}`}
            brand={entry}
            size={size}
            tone={tone}
            decorative
          />
        ) : (
          <BrandIcon
            key={`${entry.name}-${index}`}
            name={entry.name}
            size={size}
            decorative
          />
        )
      )}
      {rest > 0 && (
        <span
          aria-hidden="true"
          data-slot="brand-icon-group-more"
          {...stylex.props(
            groupMoreStyles.more(tile),
            styles.more(tile, corner)
          )}
        >
          {words.more(rest)}
        </span>
      )}
    </span>
  );
};
