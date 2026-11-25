import { focusWithin } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import {
  backdropKinds as backdrops,
  ditherPatterns,
  ditherTones,
  isDither as isDithered,
} from "../chat/backdrop/look.ts";
import type {
  BackdropKind as Backdrop,
  BackdropLook as Look,
  BackdropPattern as DitherPattern,
  BackdropTone as DitherTone,
} from "../chat/backdrop/look.ts";
import { BackdropTile } from "../chat/backdrop/tile.tsx";

// Choosing a look by sight (settings/backdrop-settings.tsx): every
// backdrop as a small still picture in one row to scroll through, and for
// a dither its patterns and colours as pictures of that dither too, so any
// look is one or two clicks. Each row is a group of radios, one tab stop,
// arrows to move. Each picture is the backdrop's tile
// (chat/backdrop/tile.tsx), a still loaded once for every tile; only the
// big preview above draws live. As the reference's (#2503's
// settings/look-tiles.tsx).

const styles = stylex.create({
  rows: {
    display: "grid",
    gap: space["3"],
    minWidth: 0,
  },
  group: {
    display: "grid",
    gap: space["2"],
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  label: {
    padding: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  // One row, scrolled sideways, with room for the tiles' focus rings.
  strip: {
    display: "flex",
    gap: space["2"],
    overflowX: "auto",
    paddingBlock: space["1"],
    paddingInline: space["1"],
    marginInline: `calc(-1 * ${space["1"]})`,
    scrollbarWidth: "thin",
  },
  tile: {
    position: "relative",
    display: "grid",
    flexShrink: 0,
    gap: space["1"],
    width: "7rem",
    borderRadius: radius.base,
    cursor: "pointer",
  },
  small: {
    width: "4.5rem",
  },
  native: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "pointer",
  },
  // The picture: the page's own ground under it, as a dither and sand are
  // drawn on it.
  picture: {
    position: "relative",
    overflow: "hidden",
    isolation: "isolate",
    display: "block",
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: radius.base,
    cornerShape: radius.shape,
    backgroundColor: colors.background,
    boxShadow: size.borderStrong,
  },
  chosen: {
    boxShadow: `0 0 0 ${size.ringWidth} ${colors.foreground}`,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  nameOn: {
    color: colors.foreground,
    fontWeight: font.weightMedium,
  },
});

/** One look as a tile: its picture, its name, and the radio that chooses it. */
const Tile = ({
  group,
  look,
  name,
  chosen,
  small = false,
  onChoose,
}: {
  group: string;
  look: Look;
  name: string;
  chosen: boolean;
  small?: boolean;
  onChoose: () => void;
}) => (
  <label {...stylex.props(styles.tile, small && styles.small, focusWithin)}>
    <input
      checked={chosen}
      name={group}
      onChange={onChoose}
      type="radio"
      {...stylex.props(styles.native)}
    />
    <span
      aria-hidden="true"
      {...stylex.props(styles.picture, chosen && styles.chosen)}
    >
      <BackdropTile look={look} />
    </span>
    <span {...stylex.props(styles.name, chosen && styles.nameOn)}>{name}</span>
  </label>
);

/** A labelled row of tiles. */
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <fieldset {...stylex.props(styles.group)}>
    <legend {...stylex.props(styles.label)}>{label}</legend>
    <div {...stylex.props(styles.strip)}>{children}</div>
  </fieldset>
);

/** What each tile and row is called, in the page's language. */
export interface LookTilesWords {
  backdropLabel: string;
  patternLabel: string;
  toneLabel: string;
  backdrops: Record<Backdrop, string>;
  patterns: Record<DitherPattern, string>;
  tones: Record<DitherTone, string>;
}

/** The person's look, chosen by sight: a backdrop, and a dither's pattern and colour. */
export const LookTiles = ({
  look,
  onLook,
  words,
}: {
  look: Look;
  onLook: (look: Look) => void;
  words: LookTilesWords;
}) => {
  const id = useId();
  return (
    <div {...stylex.props(styles.rows)}>
      <Row label={words.backdropLabel}>
        {backdrops.map((backdrop) => (
          <Tile
            chosen={look.backdrop === backdrop}
            group={`${id}-backdrop`}
            key={backdrop}
            look={{ ...look, backdrop }}
            name={words.backdrops[backdrop]}
            onChoose={() => {
              onLook({ ...look, backdrop });
            }}
          />
        ))}
      </Row>
      {isDithered(look.backdrop) ? (
        <>
          <Row label={words.patternLabel}>
            {ditherPatterns.map((pattern) => (
              <Tile
                chosen={look.pattern === pattern}
                group={`${id}-pattern`}
                key={pattern}
                look={{ ...look, pattern }}
                name={words.patterns[pattern]}
                onChoose={() => {
                  onLook({ ...look, pattern });
                }}
                small
              />
            ))}
          </Row>
          <Row label={words.toneLabel}>
            {ditherTones.map((tone) => (
              <Tile
                chosen={look.tone === tone}
                group={`${id}-tone`}
                key={tone}
                look={{ ...look, tone }}
                name={words.tones[tone]}
                onChoose={() => {
                  onLook({ ...look, tone });
                }}
                small
              />
            ))}
          </Row>
        </>
      ) : null}
    </div>
  );
};
