import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Icon, Plus } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

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
    backgroundColor: grasp.lightPaper,
    color: grasp.lightInk,
    cornerShape: grasp.cornerShape,
  },
  inText: {
    display: "inline-flex",
    verticalAlign: "middle",
  },
  edged: {
    boxShadow: grasp.edge,
  },
  /**
   * The tile around a logo, by size. `xs` and `inline` sit inside a line of
   * text; `lg` stands on its own, as on a block; `bare` is the logo alone,
   * with no tile behind it, cut round so a row of them has one shape.
   */
  bare: {
    width: grasp.space4,
    height: grasp.space4,
    borderRadius: grasp.cornerCircle,
    backgroundColor: "transparent",
    color: grasp.ink,
  },
  lg: {
    width: `calc(${grasp.space12} + ${grasp.space2})`,
    height: `calc(${grasp.space12} + ${grasp.space2})`,
    padding: grasp.space3,
    borderRadius: grasp.corner,
  },
  default: {
    width: `calc(${grasp.space8} + ${grasp.space1})`,
    height: `calc(${grasp.space8} + ${grasp.space1})`,
    padding: `calc(${grasp.space1} + ${grasp.space1} / 2)`,
    borderRadius: grasp.cornerMark,
  },
  sm: {
    width: grasp.space7,
    height: grasp.space7,
    padding: grasp.space1,
    borderRadius: grasp.cornerMark,
  },
  xs: {
    width: grasp.space4,
    height: grasp.space4,
    borderRadius: `calc(${grasp.cornerMark} / 2)`,
  },
  inline: {
    width: grasp.space5,
    height: grasp.space5,
    padding: `calc(${grasp.space1} / 2)`,
    borderRadius: grasp.cornerMark,
  },
  letter: {
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    fontWeight: grasp.weightMedium,
    lineHeight: grasp.textXsLine,
  },
  letterInText: {
    lineHeight: 1,
  },
  letterLg: {
    fontSize: grasp.textLg,
    lineHeight: grasp.textLgLine,
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  // The default tile, dashed and without its light ground: a place for something still to add.
  add: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: `calc(${grasp.space8} + ${grasp.space1})`,
    height: `calc(${grasp.space8} + ${grasp.space1})`,
    borderWidth: grasp.hairline,
    borderStyle: "dashed",
    borderColor: grasp.line,
    borderRadius: grasp.cornerMark,
    color: grasp.muted,
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

/**
 * The tile of something still to add, beside the logos of what is there:
 * the same tile, dashed and empty, with a plus.
 */
export const AddLogo = () => (
  <div aria-hidden="true" {...stylex.props(styles.add)}>
    <Icon icon={Plus} />
  </div>
);
