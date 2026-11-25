import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { motionVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { sceneKinds } from "../../chat/backdrop/look.ts";
import type { BackdropScene as Scene } from "../../chat/backdrop/look.ts";

// An App card's drawn ground: one of the backdrop's scenes (chat/backdrop/shader.ts), dithered
// from night to lime and turned to a hue of its own, drawn once as a still picture when the card
// first comes into view and never again. The page's grounds draw one at a time, so they hold one
// WebGL context at most. The backdrop's own still drawer, as the reference's cards use theirs,
// from each scene's small picture.

/** The hues a drawn ground can be turned to; left out, the light's own green. */
export type AppCardGroundHue = "rose" | "coral" | "olive" | "teal";

/** Every hue, in order round the wheel. */
const hues: readonly AppCardGroundHue[] = ["rose", "coral", "olive", "teal"];

/** The light's stops, as the drawer reads them, night to paper: Damsko's brand colours. */
const STOPS = ["night", "ink", "pine", "mint", "sea", "lime", "paper"] as const;

/** The mint stop's own hue: the others keep their drift from it when the ramp is turned. */
const MINT_HUE = 165.25;

/** Where the scenes' pictures are served (apps/web/public/backdrops). */
const SCENES = "/backdrops/";

/** How long a card may be out of view before it counts as gone: a quick scroll past keeps it. */
const GRACE = 300;

const styles = stylex.create({
  // Fills the frame under the window, behind it; the light's night until its picture stands.
  ground: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    overflow: "hidden",
    pointerEvents: "none",
    backgroundColor: colors.brandNight,
  },
  picture: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    imageRendering: "pixelated",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: motionVars.ui,
  },
  shown: { opacity: 1 },
  // Each hue's turn of the light's ramp, kept to the few Ruben chose (19 Nov: "don't go overboard
  // with colouring"): the green, rose, coral, olive and teal.
  rose: { "--app-card-ground-hue": "5" },
  coral: { "--app-card-ground-hue": "35" },
  olive: { "--app-card-ground-hue": "115" },
  teal: { "--app-card-ground-hue": "195" },
});

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

let shared: IntersectionObserver | undefined;
const watched = new Map<Element, (inView: boolean) => void>();

/** The page's one observer, made on first use. */
const observer = () => {
  shared ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      watched.get(entry.target)?.(entry.isIntersecting);
    }
  });
  return shared;
};

/** Whether `box` is in view: at once when it comes in, `GRACE` after it leaves; one observer for the page. */
const useInView = (box: Element | null) => {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (box === null) {
      return keep;
    }
    let leaving: ReturnType<typeof setTimeout> | undefined;
    watched.set(box, (seen) => {
      clearTimeout(leaving);
      if (seen) {
        setInView(true);
        return;
      }
      leaving = setTimeout(() => {
        setInView(false);
      }, GRACE);
    });
    observer().observe(box);
    return () => {
      clearTimeout(leaving);
      watched.delete(box);
      shared?.unobserve(box);
    };
  }, [box]);
  return inView;
};

/**
 * The light's seven stops as they resolve on `box`, turned to the hue it carries (each stop keeping
 * its lightness and chroma): the colours a drawing on it takes.
 */
const paletteOf = (box: HTMLElement): string[] => {
  const style = getComputedStyle(box);
  const given = style.getPropertyValue("--app-card-ground-hue").trim();
  const hue = Number(given);
  const turned = given !== "" && Number.isFinite(hue);
  return STOPS.map((stop) => {
    const value = style.getPropertyValue(`--damsko-brand-${stop}`).trim();
    const parts =
      /^oklch\(\s*(?<lightness>[\d.]+)\s+(?<chroma>[\d.]+)\s+(?<own>[\d.]+)/u.exec(
        value
      )?.groups;
    if (
      !turned ||
      parts?.lightness === undefined ||
      parts.chroma === undefined ||
      parts.own === undefined
    ) {
      return value;
    }
    return `oklch(${parts.lightness} ${parts.chroma} ${hue + Number(parts.own) - MINT_HUE})`;
  });
};

/** Hands `keepPicture` the still picture of `scene` on `box`; none if it drew nothing. */
const drawGround = async (
  box: HTMLElement,
  scene: Scene,
  keepPicture: (picture: string | null) => void
) => {
  // Loaded only once a ground first comes into view.
  const { stillPictureOf } = await import("../../chat/backdrop/shader.ts");
  const { width, height } = box.getBoundingClientRect();
  stillPictureOf(
    scene,
    // A scene draws no dither: its pattern and tone are not read.
    { pattern: "bayer", tone: "light" },
    {
      scenes: SCENES,
      small: true,
      width,
      height,
      palette: paletteOf(box),
      flat: getComputedStyle(box).color,
    },
    keepPicture
  );
};

/** The drawn ground: its still picture, made when the card first comes into view. */
export const AppCardGround = ({
  scene,
  hue,
}: {
  scene: Scene;
  hue: AppCardGroundHue | undefined;
}) => {
  const [box, setBox] = useState<HTMLSpanElement | null>(null);
  const inView = useInView(box);
  const [picture, setPicture] = useState<string>();
  const [shown, setShown] = useState(false);
  const wanted = inView && picture === undefined && box !== null;
  useEffect(() => {
    if (!wanted || box === null) {
      return keep;
    }
    let gone = false;
    void drawGround(box, scene, (drawn) => {
      if (!gone && drawn !== null) {
        setPicture(drawn);
      }
    });
    return () => {
      gone = true;
    };
  }, [wanted, box, scene]);
  return (
    <span
      aria-hidden="true"
      ref={setBox}
      {...stylex.props(styles.ground, hue !== undefined && styles[hue])}
    >
      {picture === undefined ? null : (
        <img
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => {
            setShown(true);
          }}
          src={picture}
          {...stylex.props(styles.picture, shown && styles.shown)}
        />
      )}
    </span>
  );
};

/** A ground for each App, kept by its ID: one of the six scenes in one of five ramps (the green and the four hues). */
export const appCardGroundOf = (
  id: string
): { scene: Scene; hue: AppCardGroundHue | undefined } => {
  let hash = 0;
  for (const letter of id) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  const scene = sceneKinds[hash % sceneKinds.length] ?? "wave";
  const ramp = Math.floor(hash / sceneKinds.length) % (hues.length + 1);
  return { scene, hue: ramp === 0 ? undefined : hues[ramp - 1] };
};
