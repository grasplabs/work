"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { defaultScenes } from "../backdrop/backdrop";
import { nothingDrawn } from "../backdrop/drawing";
import type { Drawing } from "../backdrop/drawing";
import { isSand, sceneKinds } from "../backdrop/look";
import type { BackdropLook, BackdropSand } from "../backdrop/look";
import { simply } from "../motion/simply.stylex";
import { grasp } from "../tokens/tokens.stylex";
import { useInView } from "./watch";

/** The hues a drawn ground can be turned to; left out, the light's own green. */
export type AppCardGroundHue = "rose" | "coral" | "olive" | "teal";

/** Every hue, in order round the wheel. */
export const appCardGroundHues: readonly AppCardGroundHue[] = [
  "rose",
  "coral",
  "olive",
  "teal",
];

/** The light's stops, as the drawer reads them (backdrop/shader.ts). */
const STOPS = ["night", "ink", "pine", "mint", "sea", "lime", "paper"] as const;

/** The mint stop's own hue: the others keep their drift from it when the ramp is turned. */
const MINT_HUE = 165.25;

const styles = stylex.create({
  // Fills the frame under the window, behind it; the light's night until its picture stands.
  ground: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    overflow: "hidden",
    pointerEvents: "none",
    backgroundColor: grasp.lightNight,
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
    transitionDuration: simply.ui,
  },
  shown: { opacity: 1 },
  rose: { "--app-card-ground-hue": grasp.appCardGroundHueRose },
  coral: { "--app-card-ground-hue": grasp.appCardGroundHueCoral },
  olive: { "--app-card-ground-hue": grasp.appCardGroundHueOlive },
  teal: { "--app-card-ground-hue": grasp.appCardGroundHueTeal },
});

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** A drawing in the page's line: it calls `handOn` once it has let its canvas go. */
type Job = (handOn: () => void) => void;

/** The page's one line of sand grounds: each starts when the one before has let its canvas go. */
const waiting: Job[] = [];
let busy = false;
const startNext = () => {
  const job = waiting.shift();
  busy = job !== undefined;
  job?.(startNext);
};
const inLine = (job: Job) => {
  waiting.push(job);
  if (!busy) {
    startNext();
  }
};

/** Nothing stands on a card's ground: no box is kept clear on its picture. */
const noBoxes = new Map<string, DOMRect>();
const nowhere = () => noBoxes.get("");

/** A drawing given up on: its canvas drew nothing in this long. */
const LIMIT = 6000;

/**
 * The light's seven stops as they resolve on `box`, turned to the hue it carries (each stop keeping
 * its lightness and chroma), and its text colour: the colours a drawing on it takes.
 */
const coloursOf = (box: HTMLElement) => {
  const style = getComputedStyle(box);
  const given = style.getPropertyValue("--app-card-ground-hue").trim();
  const hue = Number(given);
  const turned = given !== "" && Number.isFinite(hue);
  const palette = STOPS.map((stop) => {
    const value = style.getPropertyValue(`--grasp-light-${stop}`).trim();
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
  return { palette, flat: style.color };
};

/**
 * Draws the sand `kind` once on a canvas in `box`, hands its picture to `keepPicture` (none if it drew
 * nothing), lets the canvas go, and then hands on to the next drawing.
 */
const drawSandOnce =
  (
    box: HTMLElement,
    kind: BackdropSand,
    keepPicture: (picture: string | null) => void
  ): Job =>
  (handOn) => {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;visibility:hidden";
    box.append(canvas);
    const drew = () => canvas.dataset.drawn !== undefined;
    let drawing: Drawing = nothingDrawn;
    let finished = false;
    // What waits on the drawing, let go once it has finished.
    const held: {
      watch?: MutationObserver;
      limit?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      held.watch?.disconnect();
      clearTimeout(held.limit);
      const picture = drew() ? canvas.toDataURL("image/png") : null;
      canvas.remove();
      drawing.stop();
      keepPicture(picture);
      handOn();
    };
    held.watch = new MutationObserver(() => {
      if (drew()) {
        finish();
      }
    });
    held.watch.observe(canvas, {
      attributes: true,
      attributeFilter: ["data-drawn"],
    });
    held.limit = setTimeout(finish, LIMIT);
    const start = async () => {
      try {
        const { startSand } = await import("../backdrop/sand");
        drawing = await startSand(canvas, kind, {
          clear: nowhere,
          still: true,
          progress: () => 0,
        });
      } catch {
        drawing = nothingDrawn;
      }
      if (finished) {
        drawing.stop();
      } else if (drew() || drawing === nothingDrawn) {
        finish();
      }
    };
    void start();
  };

/** Hands `keepPicture` the still picture of `look` on `box`; none if it drew nothing. */
const makePicture = (
  box: HTMLElement,
  look: BackdropLook,
  scenes: string,
  keepPicture: (picture: string | null) => void
) => {
  const { backdrop } = look;
  if (backdrop === "none") {
    keepPicture(null);
    return;
  }
  if (isSand(backdrop)) {
    inLine(drawSandOnce(box, backdrop, keepPicture));
    return;
  }
  const draw = async () => {
    const { stillPictureOf } = await import("../backdrop/shader");
    const { width, height } = box.getBoundingClientRect();
    stillPictureOf(
      backdrop,
      { pattern: look.pattern, tone: look.tone },
      { scenes, small: true, width, height, ...coloursOf(box) },
      keepPicture
    );
  };
  void draw();
};

interface AppCardGroundProps {
  look: BackdropLook;
  hue: AppCardGroundHue | undefined;
  /** Where the scenes' pictures are served. @default "/backdrops/" */
  scenes?: string;
}

/** The drawn ground: its still picture, made when the card first comes into view. */
export const AppCardGround = ({
  look,
  hue,
  scenes = defaultScenes,
}: AppCardGroundProps) => {
  const [box, setBox] = useState<HTMLSpanElement | null>(null);
  const inView = useInView(box);
  const [picture, setPicture] = useState<string>();
  const [shown, setShown] = useState(false);
  const { backdrop, pattern, tone } = look;
  const wanted =
    inView && picture === undefined && box !== null && backdrop !== "none";
  useEffect(() => {
    if (!wanted || box === null) {
      return keep;
    }
    let gone = false;
    makePicture(box, { backdrop, pattern, tone }, scenes, (drawn) => {
      if (!gone && drawn !== null) {
        setPicture(drawn);
      }
    });
    return () => {
      gone = true;
    };
  }, [wanted, box, backdrop, pattern, tone, scenes]);
  return (
    <span
      ref={setBox}
      aria-hidden="true"
      data-slot="app-card-ground"
      data-drawn={picture === undefined ? undefined : ""}
      {...stylex.props(styles.ground, hue !== undefined && styles[hue])}
    >
      {picture === undefined ? null : (
        <img
          src={picture}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => {
            setShown(true);
          }}
          {...stylex.props(styles.picture, shown && styles.shown)}
        />
      )}
    </span>
  );
};

/** A ground for each app, kept by its ID: one of the six scenes in one of five ramps (the green and the four hues). */
export const appCardGroundOf = (
  id: string
): { ground: BackdropLook; groundHue: AppCardGroundHue | undefined } => {
  let hash = 0;
  for (const letter of id) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  const scene = sceneKinds[hash % sceneKinds.length] ?? "wave";
  const ramp =
    Math.floor(hash / sceneKinds.length) % (appCardGroundHues.length + 1);
  return {
    ground: { backdrop: scene, pattern: "bayer", tone: "aurora" },
    groundHue: ramp === 0 ? undefined : appCardGroundHues[ramp - 1],
  };
};
