import { Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

// An app's tile, as the prototype draws it (`components/app-logo.tsx`): its
// own logo on a light tile, or its first letter when it has none. The tile
// stays light in the dark theme too: a brand's logo is drawn for a light
// ground.

const styles = stylex.create({
  tile: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    overflow: "hidden",
    backgroundColor: colors.brandPaper,
    color: colors.brandInk,
    cornerShape: radius.shape,
  },
  inText: {
    display: "inline-flex",
    verticalAlign: "middle",
  },
  edged: {
    boxShadow: sizes.borderStrong,
  },
  /**
   * The tile around a logo, by size. `xs` and `inline` sit inside a line of
   * text; `lg` stands on its own, as on a block; `bare` is the logo alone,
   * with no tile behind it, cut round so a row of them has one shape.
   */
  bare: {
    width: space["4"],
    height: space["4"],
    borderRadius: radius.circle,
    backgroundColor: "transparent",
    color: colors.foreground,
  },
  lg: {
    width: `calc(${space["12"]} + ${space["2"]})`,
    height: `calc(${space["12"]} + ${space["2"]})`,
    padding: space["3"],
    borderRadius: radius.base,
  },
  default: {
    width: `calc(${space["8"]} + ${space["1"]})`,
    height: `calc(${space["8"]} + ${space["1"]})`,
    padding: `calc(${space["1"]} + ${space["1"]} / 2)`,
    borderRadius: radius.mark,
  },
  sm: {
    width: space["7"],
    height: space["7"],
    padding: space["1"],
    borderRadius: radius.mark,
  },
  xs: {
    width: space["4"],
    height: space["4"],
    borderRadius: `calc(${radius.mark} / 2)`,
  },
  inline: {
    width: space["5"],
    height: space["5"],
    padding: `calc(${space["1"]} / 2)`,
    borderRadius: radius.mark,
  },
  letter: {
    fontFamily: font.sans,
    fontSize: font.textXs,
    fontWeight: font.weightMedium,
    lineHeight: font.textXsLine,
  },
  letterInText: {
    lineHeight: 1,
  },
  letterLg: {
    fontSize: font.textLg,
    lineHeight: font.textLgLine,
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
});

type TileSize = "bare" | "lg" | "default" | "sm" | "xs" | "inline";

/** The sizes drawn with the system's edge: the ones that stand as a tile. */
const edgedSizes = new Set<TileSize>(["lg", "default", "sm", "inline"]);

/**
 * A brand's own logo on a light tile, or its first letter when it has no
 * logo. `logo` is where core serves it, on the deployment's own origin
 * (`CatalogEntry.logo`), never its provider's address. A logo that does
 * not load makes way for the letter, and one further down a long list is
 * fetched only as it comes near.
 */
export const AppLogo = ({
  name,
  logo,
  size = "default",
}: {
  name: string;
  logo?: string | null;
  /** `xs` sits inside a chip; `inline` inside a sentence. */
  size?: TileSize;
}) => {
  const { t } = useLingui();
  const [missing, setMissing] = useState<string>();
  const image = logo === null || logo === missing ? undefined : logo;
  const inText = size === "xs" || size === "inline" || size === "bare";
  const Tile = inText ? "span" : "div";
  return (
    <Tile
      {...stylex.props(
        styles.tile,
        inText && styles.inText,
        edgedSizes.has(size) && styles.edged,
        styles[size]
      )}
    >
      {image === undefined ? (
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.letter,
            inText && styles.letterInText,
            size === "lg" && styles.letterLg
          )}
        >
          {name.charAt(0)}
        </span>
      ) : (
        <img
          alt={inText ? "" : t`${name} logo`}
          decoding="async"
          loading="lazy"
          onError={() => {
            setMissing(image);
          }}
          src={image}
          {...stylex.props(styles.image)}
        />
      )}
    </Tile>
  );
};

const addStyles = stylex.create({
  // The default tile, dashed and without its light ground: a place for something still to add.
  tile: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: `calc(${space["8"]} + ${space["1"]})`,
    height: `calc(${space["8"]} + ${space["1"]})`,
    borderWidth: sizes.hairline,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    color: colors.mutedForeground,
  },
});

/**
 * The tile of something still to add, beside the logos of what is there:
 * the same tile, dashed and empty, with a plus.
 */
export const AddLogo = () => (
  <span aria-hidden="true" {...stylex.props(addStyles.tile)}>
    <Icon icon={PlusIcon} />
  </span>
);
