// The one way a flag is drawn in Damsko. The drawings come from country-flag-icons (only from
// there), 3 by 2; this rounds them to our corner and draws the system's edge inside them, so a white
// flag (Japan, Finland) keeps its rim on a white ground. Import flags from "src/flags", never from
// country-flag-icons directly.
//
// A flag stands for a region, not a language. Where a language has no fair flag (Arabic,
// Esperanto, Catalan), show its code instead, in a tile of the same shape: <Flag code="AR" />.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

/** A flag's drawing: one of the exports of src/flags. */
export type FlagData = string;

/** How tall a flag stands; flags are 3 by 2. */
export type FlagSize = "sm" | "md" | "lg";

const FORCED = media.forced;

// The corner follows the flag's height, so every size has the same roundness; the squircle softens
// it as it does every corner in the system.
const box = (height: string) => ({
  height,
  width: `calc(${height} * 3 / 2)`,
  borderRadius: `calc(${height} / 4)`,
});

const styles = stylex.create({
  flag: {
    position: "relative",
    display: "inline-block",
    flexShrink: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    cornerShape: grasp.cornerShape,
    verticalAlign: "middle",
    lineHeight: 0,
    // The drawing never catches a click meant for the control it is in.
    pointerEvents: "none",
    // The edge, over the picture: drawn inside, so it adds nothing to the size. In forced colours
    // the system's own line.
    "::after": {
      content: "''",
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
      boxShadow: {
        default: grasp.flagEdge,
        [FORCED]: "inset 0 0 0 1px CanvasText",
      },
    },
  },
  sm: box(grasp.flagSm),
  md: box(grasp.flagMd),
  lg: box(grasp.flagLg),
  picture: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  // The code tile: the language's code on a quiet ground, in the shape of a flag.
  tile: {
    display: "inline-grid",
    placeItems: "center",
    backgroundColor: grasp.quietFill,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.trackingTag,
    textTransform: "uppercase",
  },
  tileSm: { fontSize: `calc(${grasp.flagSm} * 0.58)` },
  tileMd: { fontSize: `calc(${grasp.flagMd} * 0.56)` },
  // Leading a row, the code is words people read: the smallest text there is, text-xs.
  tileLg: { fontSize: grasp.textXs },
});

const tileText = { sm: styles.tileSm, md: styles.tileMd, lg: styles.tileLg };

interface FlagBaseProps {
  /**
   * How tall it stands: `sm` (12px) beside small words, `md` (16px) where an icon would stand,
   * `lg` (20px) leading a list row.
   * @default "md"
   */
  size?: FlagSize;
  /**
   * What it stands for ("Netherlands"), when nothing beside it says so. Leave it out when words
   * beside it say the same (the usual case): it is then hidden from screen readers.
   */
  label?: string;
  /** Layout only, from the holder (a margin, an alignment). */
  style?: stylex.StyleXStyles<{
    alignSelf?: string | number | null;
    marginBlock?: string | number | null;
    marginInline?: string | number | null;
    marginInlineStart?: string | number | null;
    marginInlineEnd?: string | number | null;
  }>;
}

/** Every prop a Flag takes: a region's flag, or a code for a language with no fair flag. */
export type FlagProps = FlagBaseProps &
  (
    | {
        /** The region's flag: one of the exports of src/flags (`NL`, `GB`, `BR`). */
        flag: FlagData;
        code?: never;
      }
    | {
        /** Two or three letters for a language with no fair flag ("AR", "EO"), in a tile of the same shape. */
        code: string;
        flag?: never;
      }
  );

// The drawing goes in as a data address, so no markup is written into the page.
const address = (drawing: FlagData) =>
  `data:image/svg+xml,${encodeURIComponent(drawing)}`;

/** A region's flag, rounded to our corner with the system's edge, or a code in its shape. */
export const Flag = ({ flag, code, size = "md", label, style }: FlagProps) => {
  if (flag === undefined) {
    return (
      <span
        role={label === undefined ? undefined : "img"}
        aria-label={label}
        aria-hidden={label === undefined ? true : undefined}
        {...stylex.props(
          styles.flag,
          styles[size],
          styles.tile,
          tileText[size],
          style
        )}
      >
        {code}
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.flag, styles[size], style)}>
      <img
        src={address(flag)}
        alt={label ?? ""}
        draggable={false}
        {...stylex.props(styles.picture)}
      />
    </span>
  );
};
