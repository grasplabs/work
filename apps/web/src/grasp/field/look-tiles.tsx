import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus.ts";
import { grasp } from "../tokens/tokens.stylex.ts";
import { LookPictureStage, useLookPicture } from "./look-picture.tsx";
import { backdrops, ditherPatterns, ditherTones, isDithered } from "./look.ts";
import type { Backdrop, DitherPattern, DitherTone, Look } from "./look.ts";

// Choosing a look by sight (settings/backdrop-settings.tsx): every
// backdrop as a small still picture in one row to scroll through, and for
// a dither its patterns and colours as pictures of that dither too, so any
// look is one or two clicks. Each row is a group of radios, one tab stop,
// arrows to move. The pictures come from look-picture.tsx; only the big
// preview above draws live. Its own part, so the library's Backdrop
// picker can take its place.

const styles = stylex.create({
  rows: {
    display: "grid",
    gap: grasp.space3,
    minWidth: 0,
  },
  group: {
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  label: {
    padding: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  // One row, scrolled sideways, with room for the tiles' focus rings.
  strip: {
    display: "flex",
    gap: grasp.space2,
    overflowX: "auto",
    paddingBlock: grasp.space1,
    paddingInline: grasp.space1,
    marginInline: `calc(-1 * ${grasp.space1})`,
    scrollbarWidth: "thin",
  },
  tile: {
    position: "relative",
    display: "grid",
    flexShrink: 0,
    gap: grasp.space1,
    width: "7rem",
    borderRadius: grasp.corner,
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
    display: "block",
    width: "100%",
    aspectRatio: "16 / 9",
    objectFit: "cover",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.paper,
    boxShadow: grasp.edge,
    imageRendering: "pixelated",
  },
  chosen: {
    boxShadow: `0 0 0 2px ${grasp.ink}`,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  nameOn: {
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
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
}) => {
  const picture = useLookPicture(look);
  return (
    <label {...stylex.props(styles.tile, small && styles.small, focus.within)}>
      <input
        checked={chosen}
        name={group}
        onChange={onChoose}
        type="radio"
        {...stylex.props(styles.native)}
      />
      {picture === undefined || picture === "" ? (
        <span
          aria-hidden="true"
          {...stylex.props(styles.picture, chosen && styles.chosen)}
        />
      ) : (
        <img
          alt=""
          src={picture}
          {...stylex.props(styles.picture, chosen && styles.chosen)}
        />
      )}
      <span {...stylex.props(styles.name, chosen && styles.nameOn)}>
        {name}
      </span>
    </label>
  );
};

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
      <LookPictureStage />
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
