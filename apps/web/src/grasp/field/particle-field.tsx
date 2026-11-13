import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { grasp } from "../tokens/tokens.stylex.ts";
import type { SandKind } from "./look.ts";

// Sand backdrops, drawn on a 2D canvas over the page's own ground: grains
// on a shaken plate, as a Chladni figure. Each grain wanders where the
// plate moves and comes to rest where it is still, so the sand gathers
// along the still lines; the pointer stirs it. What differs is the plate:
//
// - sand: a square plate's own figures, rings and bars; every so often
//   its tone changes and the sand runs to its new lines.
// - dunes: ripples across, as wind leaves them, slowly drifting.
// - rings: rings round what stands on the page, slowly widening.
// - pixels: the plate's figures with every grain snapped to the dither's
//   grid: sand, set as a dither.
//
// The grains are fine pine dots, one in a few mint, as the website's brain
// is drawn. None stand on what is on the page (`clear`): they fade out
// towards it. Drawn about thirty times a second, only while the page is
// seen. With less motion each is one settled, still picture. Decorative
// only.

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the sand is drawn in and for: its size, its clock, the pointer and what to keep clear of. */
interface Scene {
  width: number;
  height: number;
  time: number;
  pointer: { x: number; y: number } | undefined;
  clear: Box | undefined;
}

interface Colours {
  grain: string;
  accent: string;
}

/** How much the plate moves at a point: the sand rests where this is nought. */
type Plate = (x: number, y: number, now: Scene) => number;

/** How far out from what they keep clear of the grains come back in. */
const clearSoft = 150;

const smooth = (value: number): number => {
  const k = Math.min(1, Math.max(0, value));
  return k * k * (3 - 2 * k);
};

/** How much shows at a point, 0 to 1: nothing on what is kept clear, all of it `clearSoft` away. */
const shownAt = (scene: Scene, x: number, y: number): number => {
  const { clear } = scene;
  if (clear === undefined) {
    return 1;
  }
  const dx = Math.max(clear.left - x, 0, x - clear.right);
  const dy = Math.max(clear.top - y, 0, y - clear.bottom);
  return smooth(Math.hypot(dx, dy) / clearSoft);
};

/** The plate's tones, as the pairs of a Chladni figure, played in turn. */
const tones: readonly (readonly [number, number])[] = [
  [1, 3],
  [2, 3],
  [1, 4],
  [3, 4],
  [2, 5],
];

/** How long the plate holds a tone, in seconds; it slides to the next over the last quarter. */
const toneSeconds = 14;

const toneAt = (index: number): readonly [number, number] =>
  tones[index % tones.length] ?? [1, 3];

/** A square plate's figure for the pair n, m: cos(nπu)cos(mπv) − cos(mπu)cos(nπv). */
const chladni = (u: number, v: number, n: number, m: number): number =>
  Math.cos(n * Math.PI * u) * Math.cos(m * Math.PI * v) -
  Math.cos(m * Math.PI * u) * Math.cos(n * Math.PI * v);

const plate: Plate = (x, y, now) => {
  const u = ((x - now.width / 2) / now.height) * 1.2;
  const v = ((y - now.height / 2) / now.height) * 1.2;
  const turn = now.time / toneSeconds;
  const index = Math.floor(turn);
  const blend = smooth((turn - index - 0.75) * 4);
  const [n, m] = toneAt(index);
  const first = chladni(u, v, n, m);
  if (blend <= 0) {
    return first;
  }
  const [n2, m2] = toneAt(index + 1);
  return first + (chladni(u, v, n2, m2) - first) * blend;
};

const dunes: Plate = (x, y, now) => {
  const u = (x / now.height) * 1.2;
  const v = (y / now.height) * 1.2;
  return Math.sin(
    v * 26 +
      2.2 * Math.sin(u * 3 + now.time * 0.05) +
      1.2 * Math.sin(u * 7.3 - now.time * 0.03) -
      now.time * 0.06
  );
};

const rings: Plate = (x, y, now) => {
  const { clear } = now;
  const cx =
    clear === undefined ? now.width / 2 : (clear.left + clear.right) / 2;
  const cy =
    clear === undefined ? now.height / 2 : (clear.top + clear.bottom) / 2;
  // Wider than tall, as what they stand round is.
  const away = Math.hypot((x - cx) * 0.78, y - cy);
  return Math.sin(away * 0.034 - now.time * 0.22);
};

const plates: Record<SandKind, Plate> = {
  sand: plate,
  dunes,
  rings,
  pixels: plate,
};

/** The dither's grid the pixel sand snaps to, and its mark, in CSS pixels. */
const pixelGrid = 4;
const pixelMark = 2;

/** How many frames the sand takes to settle, for its first and its still picture. */
const settleFrames = 150;

/** The sand on `field`: its grains, a step of them, and drawing them. */
const sandOn = (scene: Scene, field: Plate, pixel: boolean) => {
  const count = Math.min(9000, Math.round((scene.width * scene.height) / 140));
  const grains = Array.from({ length: count }, (_, index) => ({
    x: Math.random() * scene.width,
    y: Math.random() * scene.height,
    size: index % 3 === 0 ? 1.6 : 1.1,
    spark: index % 26 === 0,
  }));
  const step = (now: Scene): void => {
    for (const grain of grains) {
      // Down the slope of how much the plate moves, faster where it moves
      // more, with the shake of the plate on top.
      const value = field(grain.x, grain.y, now);
      const dx = field(grain.x + 2, grain.y, now) - value;
      const dy = field(grain.x, grain.y + 2, now) - value;
      const slope = Math.hypot(dx, dy);
      const moving = Math.min(1, Math.abs(value) * 1.5);
      const pull = slope > 0 ? (Math.sign(value) * moving * 3.6) / slope : 0;
      let shake = 0.5 + moving * 1.5;
      if (now.pointer !== undefined) {
        const away = Math.hypot(
          grain.x - now.pointer.x,
          grain.y - now.pointer.y
        );
        shake += Math.max(0, 1 - away / 110) * 7;
      }
      const angle = Math.random() * Math.PI * 2;
      grain.x += -dx * pull + Math.cos(angle) * shake;
      grain.y += -dy * pull + Math.sin(angle) * shake;
      const out =
        grain.x < 0 ||
        grain.y < 0 ||
        grain.x > now.width ||
        grain.y > now.height;
      if (out) {
        grain.x = Math.random() * now.width;
        grain.y = Math.random() * now.height;
      }
    }
  };
  /** The grains that are sparks, or those that aren't, in the colour set. */
  const pass = (
    ctx: CanvasRenderingContext2D,
    now: Scene,
    sparks: boolean
  ): void => {
    for (const grain of grains) {
      const shown = grain.spark === sparks ? shownAt(now, grain.x, grain.y) : 0;
      if (shown > 0.01) {
        ctx.globalAlpha = (sparks ? 0.9 : 0.5) * shown;
        if (pixel) {
          ctx.fillRect(
            Math.floor(grain.x / pixelGrid) * pixelGrid,
            Math.floor(grain.y / pixelGrid) * pixelGrid,
            pixelMark,
            pixelMark
          );
        } else {
          ctx.fillRect(grain.x, grain.y, grain.size, grain.size);
        }
      }
    }
  };
  const draw = (
    ctx: CanvasRenderingContext2D,
    now: Scene,
    colours: Colours
  ): void => {
    ctx.clearRect(0, 0, now.width, now.height);
    ctx.fillStyle = colours.grain;
    pass(ctx, now, false);
    ctx.fillStyle = colours.accent;
    pass(ctx, now, true);
  };
  /** Moves every grain with the field as it is resized, so the figure stays whole. */
  const stretch = (across: number, down: number): void => {
    for (const grain of grains) {
      grain.x *= across;
      grain.y *= down;
    }
  };
  return { step, draw, stretch };
};

/** How long a frame is, at most thirty a second. */
const frameMs = 1000 / 30;

/** Draws `kind` on `element` until the returned function is called. */
const startSand = (
  element: HTMLCanvasElement,
  kind: SandKind,
  clear: RefObject<HTMLElement | null> | undefined
): (() => void) => {
  const ctx = element.getContext("2d");
  if (ctx === null) {
    return () => {
      // Nothing to draw on.
    };
  }
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scene: Scene = {
    width: 1,
    height: 1,
    time: 0,
    pointer: undefined,
    clear: undefined,
  };
  const pixel = kind === "pixels";
  let sand: ReturnType<typeof sandOn> | undefined;
  const begun = performance.now();
  let last = begun;
  let frame = 0;
  // The canvas takes its colours from its own style, so they follow the
  // theme: its text colour for the grains, its outline's for the sparks.
  const colours = (): Colours => {
    const style = getComputedStyle(element);
    return { grain: style.color, accent: style.outlineColor };
  };
  /** Where what is kept clear stands, in the canvas's own space. */
  const place = (): void => {
    const box = element.getBoundingClientRect();
    const kept = clear?.current?.getBoundingClientRect();
    scene.clear =
      kept === undefined
        ? undefined
        : {
            left: kept.left - box.left,
            top: kept.top - box.top,
            right: kept.right - box.left,
            bottom: kept.bottom - box.top,
          };
  };
  const fit = (): void => {
    const box = element.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio, 2);
    element.width = Math.max(1, Math.round(box.width * ratio));
    element.height = Math.max(1, Math.round(box.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const before = { width: scene.width, height: scene.height };
    scene.width = box.width;
    scene.height = box.height;
    place();
    if (sand === undefined) {
      sand = sandOn(scene, plates[kind], pixel);
      // The settled picture: all there is with less motion, and the first
      // frame otherwise, so the sand is never seen as a plain scatter.
      for (let done = 0; done < settleFrames; done += 1) {
        sand.step(scene);
      }
    } else {
      // Resized (the sidebar folding, say): the same sand, moved with the
      // field, so it is never scattered and settled again.
      sand.stretch(scene.width / before.width, scene.height / before.height);
    }
    // Sizing the canvas clears it: drawn again at once, so no frame is bare.
    sand.draw(ctx, scene, colours());
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (now - last >= frameMs && document.visibilityState === "visible") {
      last = now;
      place();
      scene.time = (now - begun) / 1000;
      sand?.step(scene);
      sand?.draw(ctx, scene, colours());
    }
  };
  const point = (event: PointerEvent): void => {
    const box = element.getBoundingClientRect();
    scene.pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const leave = (): void => {
    scene.pointer = undefined;
  };
  const resized = new ResizeObserver(fit);
  resized.observe(element);
  fit();
  if (!still) {
    frame = requestAnimationFrame(loop);
    window.addEventListener("pointermove", point);
    document.documentElement.addEventListener("pointerleave", leave);
  }
  return () => {
    cancelAnimationFrame(frame);
    resized.disconnect();
    window.removeEventListener("pointermove", point);
    document.documentElement.removeEventListener("pointerleave", leave);
  };
};

const styles = stylex.create({
  // Its colours are what it draws in (startSand): pine grains, or sea on a
  // dark ground, and mint for the sparks.
  canvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    color: `light-dark(${grasp.lightPine}, ${grasp.lightSea})`,
    outlineStyle: "none",
    outlineColor: grasp.mintDeep,
  },
});

/**
 * The sand backdrop of `kind`, filling what it is placed in (a box with a
 * position of its own), clear round `clear`. Key it by its kind.
 */
export const ParticleField = ({
  kind,
  clear,
}: {
  kind: SandKind;
  clear?: RefObject<HTMLElement | null>;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) {
      return () => {
        // Nothing to draw on.
      };
    }
    return startSand(element, kind, clear);
  }, [kind, clear]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
