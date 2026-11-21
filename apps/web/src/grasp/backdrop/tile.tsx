// One look as a picker's tile shows it: a still drawn once, by Backdrop's own drawers, into a
// picture (tiles.ts, written by scripts/backdrop-tiles.ts), so no tile draws. The pictures are
// loaded with import() the first time a tile is shown, so a page that only draws a Backdrop never
// loads them; until they arrive a tile shows what Backdrop's first paint does (a scene's night, a
// dither's glow in its tone). A scene, and a dither in a run of colours, is its picture. A dither in a flat tone and sand
// are where their ink lies: the tile lays the theme's own colour through it, as the canvas draws in
// it, so one picture serves light and dark. Filled to its box, each cell crisp, as the canvas is.
// A tile is a sample of the look, not a page with words on it, so it never carries the dither's
// fade behind the words (grasp.backdropDitherMask): every cell shows at full strength.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { Still, toneColours } from "./field";
import { isDither, isSand, isScene } from "./look";
import type { BackdropLook, BackdropTone } from "./look";

const styles = stylex.create({
  fill: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
  },
  crisp: {
    imageRendering: "pixelated",
  },
  // Sand's colours, as the canvas draws in them: its grains, and its sparks.
  grain: { color: grasp.backdropGrain },
  spark: { color: grasp.backdropSpark },
  // A scene until its picture arrives: night, as its canvas starts.
  night: { backgroundColor: grasp.night },
});

type Tiles = Readonly<Record<string, string>>;

/** The pictures once loaded, and their one load, shared by every tile on the page. */
let loaded: Tiles | undefined;
let loading: Promise<{ backdropTiles: Tiles }> | undefined;
/** The pictures, or undefined if their chunk failed to load: the tile keeps its still, and the next tile to mount tries again. */
const loadTiles = async (): Promise<Tiles | undefined> => {
  loading ??= import("./tiles");
  try {
    const { backdropTiles } = await loading;
    loaded = backdropTiles;
    return backdropTiles;
  } catch {
    loading = undefined;
    return undefined;
  }
};

/** The pictures: at once if a tile has loaded them, else after this tile loads them. */
const useTiles = (): Tiles | undefined => {
  const [tiles, setTiles] = useState(loaded);
  useEffect(() => {
    let gone = false;
    const arrive = async (): Promise<void> => {
      const arrived = await loadTiles();
      if (!gone && arrived !== undefined) {
        setTiles(arrived);
      }
    };
    if (tiles === undefined) {
      void arrive();
    }
    return () => {
      gone = true;
    };
  }, [tiles]);
  return tiles;
};

/** The tones drawn as a run of the light's colours: their tiles are pictures, not ink to tint. */
const runTones: ReadonlySet<BackdropTone> = new Set(["rim", "core", "aurora"]);

/** Where ink lies (a picture's alpha), laid in its colour. */
interface Ink {
  picture: string | undefined;
  colour: StyleXStyles;
}

/** Each picture's ink in its colour, one over the other. */
const Tinted = ({ inks }: { inks: Ink[] }) => {
  const id = useId().replaceAll(/[^\w-]/gu, "");
  return (
    <svg
      aria-hidden="true"
      data-slot="backdrop-tile-picture"
      {...stylex.props(styles.fill)}
    >
      {inks.map(({ picture, colour }, index) => (
        <g key={picture ?? index}>
          <mask id={`${id}-${index}`}>
            <image
              href={picture}
              width="100%"
              height="100%"
              preserveAspectRatio="none"
              {...stylex.props(styles.crisp)}
            />
          </mask>
          <rect
            width="100%"
            height="100%"
            fill="currentColor"
            mask={`url(#${id}-${index})`}
            {...stylex.props(colour)}
          />
        </g>
      ))}
    </svg>
  );
};

/** One look's still, filling its box: its picture, or nothing for `"none"`. */
export const BackdropTile = ({ look }: { look: BackdropLook }) => {
  const backdropTiles = useTiles();
  const { backdrop, pattern, tone } = look;
  if (backdropTiles === undefined) {
    return isScene(backdrop) ? (
      <span aria-hidden="true" {...stylex.props(styles.fill, styles.night)} />
    ) : (
      <Still look={look} />
    );
  }
  if (isScene(backdrop)) {
    return (
      <img
        alt=""
        data-slot="backdrop-tile-picture"
        src={backdropTiles[backdrop]}
        {...stylex.props(styles.fill, styles.crisp)}
      />
    );
  }
  if (isDither(backdrop) && runTones.has(tone)) {
    return (
      <img
        alt=""
        data-slot="backdrop-tile-picture"
        src={backdropTiles[`${backdrop}:${pattern}:${tone}`]}
        {...stylex.props(styles.fill, styles.crisp)}
      />
    );
  }
  if (isDither(backdrop)) {
    return (
      <Tinted
        inks={[
          {
            picture: backdropTiles[`${backdrop}:${pattern}`],
            colour: toneColours[tone],
          },
        ]}
      />
    );
  }
  if (isSand(backdrop)) {
    return (
      <Tinted
        inks={[
          { picture: backdropTiles[backdrop], colour: styles.grain },
          {
            picture: backdropTiles[`${backdrop}:sparks`],
            colour: styles.spark,
          },
        ]}
      />
    );
  }
  return null;
};
