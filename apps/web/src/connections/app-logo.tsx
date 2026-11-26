import { tileEdge } from "@grasp-os/ui/lib/styles";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

// An app's tile, as the prototype draws it (`components/app-logo.tsx`): its
// own logo on a light tile, or its first letter when it has none. Damsko's
// BrandIcon draws a brand's vector mark; a logo here is a picture core
// serves, so the tile is the product's, on BrandIcon's ground, edge and
// corners.

const styles = stylex.create({
  tile: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    // A brand's picture is drawn for a light ground: the tile stays light
    // in dark too, its tokens read on the light side.
    colorScheme: "light",
    backgroundColor: colors.card,
    color: colors.foreground,
  },
  // `xs` sits inside a chip, a line of text.
  xs: {
    display: "inline-flex",
    width: space["4"],
    height: space["4"],
    overflow: "hidden",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  sm: {
    width: space["7"],
    height: space["7"],
    padding: space["1"],
    borderRadius: `min(${radius.xl}, calc(${space["7"]} / 2))`,
    cornerShape: radius.shape,
  },
  default: {
    width: `calc(${space["8"]} + ${space["1"]})`,
    height: `calc(${space["8"]} + ${space["1"]})`,
    padding: `calc(${space["3"]} / 2)`,
    borderRadius: `min(${radius.xl}, calc((${space["8"]} + ${space["1"]}) / 2))`,
    cornerShape: radius.shape,
  },
  // `lg` stands on its own, as on a block.
  lg: {
    width: `calc(${space["12"]} + ${space["2"]})`,
    height: `calc(${space["12"]} + ${space["2"]})`,
    padding: space["3"],
    borderRadius: radius.xl,
    cornerShape: radius.shape,
  },
  letter: {
    fontFamily: font.sans,
    fontSize: font.textXs,
    fontWeight: font.weightMedium,
  },
  letterInText: { lineHeight: 1 },
  letterLg: { fontSize: font.headingMd },
  image: { width: "100%", height: "100%", objectFit: "contain" },
});

type TileSize = "xs" | "sm" | "default" | "lg";

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
  /** `xs` sits inside a chip; `lg` stands on its own. */
  size?: TileSize;
}) => {
  const { t } = useLingui();
  const [missing, setMissing] = useState<string>();
  const image = logo === null || logo === missing ? undefined : logo;
  const inText = size === "xs";
  const Tile = inText ? "span" : "div";
  return (
    <Tile {...stylex.props(styles.tile, !inText && tileEdge, styles[size])}>
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
