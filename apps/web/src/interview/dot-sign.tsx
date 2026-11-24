import { useEffect, useRef } from "react";

import {
  bucketOf,
  CANVAS,
  DOT_MOST,
  dotAlpha,
  dotShare,
  LOOK,
  palette,
  patchAt,
  REACH,
  shimmerAt,
  swayAt,
  tideOut,
} from "../brain/dot-ink.ts";
import { PITCH } from "../brain/dot-shapes.ts";
import { useLessMotion } from "../brain/less-motion.ts";
import { signColumns, signDots } from "./dot-signs.ts";
import type { DotSign as Sign } from "./dot-signs.ts";

// A small sign beside Stephen: what he is doing, or the little he feels,
// ported from the prototype (grasplabs/prototype, packages/grasp:
// src/components/interviews/dot-sign.tsx). It is the same print as his
// head, by the same rules (`dot-ink`): dots of mixed sizes, inked ones and
// ones still grey, more of them inked as he fills; each breathing a
// little, swaying through the rows with his, fading some where a patch of
// faintness passes, and swelling and warming under the pointer. Its dots
// come up one after another, the way the sign is written, and go
// together; while he thinks, three dots come up in turn. Still for people
// who ask for less motion. It lies over the head's square, drawn in the
// same units, so both grow and shrink as one. It says nothing by itself:
// what it shows is said in words where it matters.

const tau = Math.PI * 2;
/** The figure's units in the head's drawing pixels, and the spacing of its dots: a sign is printed at the very same. */
const scale = CANVAS * 0.43 * LOOK.air;
const gap = PITCH * scale;
/** A sign's square in those pixels, and the room it is drawn in with its swaying, swelling dots. */
const box = signColumns * gap;
const field = 104;
/** Where that room stands on the head's square: up and to the right of his head, where a thought would be drawn. */
const place = { left: 0.72, top: 0 };
const middle = {
  x: place.left * CANVAS + field / 2,
  y: place.top * CANVAS + field / 2,
};
const at = {
  x: (middle.x - CANVAS / 2) / scale,
  y: (CANVAS / 2 - middle.y) / scale,
};

/** How lit a sign's dots are: it is flat, so all the same. */
const lit = 0.6;
/** A sign is written out in about this long, each dot coming up in `rise`; it goes in `fade`, all together. */
const write = { seconds: 0.4, rise: 0.3, fade: 0.2 };
/** While he thinks, the three dots come up in turn in this long; between turns a dot keeps this much of itself. */
const think = { seconds: 1.2, rest: 0.25 };
/** The signs that are a feeling of his are printed warm, this warm. */
const warmSigns: ReadonlySet<Sign> = new Set(["aha", "smile", "heart"]);
const warmth = 0.6;
/** How much of the patches of faintness a sign takes: of the same print, never unreadable. */
const tideShare = 0.4;
/** A sign fills with ink as he does, from this share when he is empty: never less, so it can be read. */
const least = 0.5;

/** A dot coming up: quick at first, then settling. */
const rise = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  return t >= 1 ? 1 : 1 - (1 - t) ** 3;
};

interface Latest {
  sign: Sign | null;
  fill: number;
  still: boolean;
}

/** Draws the sign on `element` until the returned function stops it. */
const animate = (
  element: HTMLCanvasElement,
  latest: { current: Latest }
): (() => void) => {
  const context = element.getContext("2d");
  const host = element.parentElement;
  if (context === null || host === null) {
    return () => {
      // Nothing to stop.
    };
  }
  // As sharp as the head under it: by how dense the screen is and how large it is shown.
  let sharp = 0;
  const sharpen = (): void => {
    const shown = element.clientWidth / CANVAS;
    const needed =
      Math.min(window.devicePixelRatio || 1, 2) * Math.max(shown, 0.5);
    if (Math.abs(needed - sharp) < 0.01) {
      return;
    }
    sharp = needed;
    element.width = Math.round(CANVAS * sharp);
    element.height = Math.round(CANVAS * sharp);
    context.setTransform(sharp, 0, 0, sharp, 0, 0);
  };
  let styles = palette(element);
  const pointer = { x: 0, y: 0, inside: false };
  let spotX = middle.x;
  let spotY = middle.y;
  let spot = 0;
  let shown: Sign | null = null;
  let since = 0;
  let present = 1;
  let then = -1;
  let full = latest.current.fill;
  const lists = new Map<number, number[]>();

  const gather = (now: number, still: boolean): void => {
    for (const list of lists.values()) {
      list.length = 0;
    }
    if (shown === null) {
      return;
    }
    const warm = warmSigns.has(shown);
    const thinking = shown === "thinking" && !still;
    const level = least + (1 - least) * full;
    const reach = REACH * LOOK.reach;
    const tide = still ? 0 : tideOut(now) * tideShare;
    for (const dot of signDots(shown)) {
      const y = at.y + (dot.y * box) / 2 / scale;
      const x =
        at.x +
        (dot.x * box) / 2 / scale +
        (still ? 0 : swayAt(y, dot.seed, now));
      const sx = CANVAS / 2 + x * scale;
      const sy = CANVAS / 2 - y * scale;
      let there =
        present *
        (still
          ? 1
          : rise((now - since - dot.along * write.seconds) / write.rise));
      if (thinking) {
        there *=
          think.rest +
          (1 - think.rest) *
            (0.5 -
              0.5 *
                Math.cos(tau * ((now - since) / think.seconds - dot.part / 3)));
      }
      let near = 0;
      if (spot > 0.01) {
        const far = Math.hypot(sx - spotX, sy - spotY);
        if (far < reach) {
          const t = 1 - far / reach;
          near = spot * t * t * (3 - 2 * t);
        }
      }
      const inked = dot.seed < level;
      let alpha = dotAlpha(dot.ink, lit, inked) * there;
      if (!still) {
        alpha *= shimmerAt(dot.seed, now);
      }
      if (tide > 0) {
        const clear = 1 - tide * (1 - patchAt(x, y, now));
        alpha *= clear + (1 - clear) * LOOK.reveal * near;
      }
      const heat = Math.max(warm ? warmth : 0, LOOK.warm * near);
      if (heat > 0.12) {
        alpha = Math.max(alpha, (0.45 + 0.5 * heat) * there);
      }
      const share = dotShare(dot.ink, inked, dot.grain);
      const radius =
        gap *
        share *
        (0.5 + 0.5 * there) *
        Math.min(1 + 0.25 * heat + LOOK.grow * near, DOT_MOST / share);
      const bucket = bucketOf(alpha, heat);
      if (there >= 0.01 && bucket !== 0) {
        const list = lists.get(bucket) ?? [];
        lists.set(bucket, list);
        list.push(sx, sy, radius);
      }
    }
  };

  const paint = (): void => {
    context.clearRect(0, 0, CANVAS, CANVAS);
    const smallest = 0.75 / Math.max(1, sharp);
    for (const [bucket, list] of lists) {
      if (list.length > 0) {
        context.fillStyle = styles[bucket] ?? "transparent";
        context.beginPath();
        for (let index = 0; index < list.length; index += 3) {
          const cx = list[index] ?? 0;
          const cy = list[index + 1] ?? 0;
          const r = list[index + 2] ?? 0;
          if (r < smallest) {
            context.rect(cx - r, cy - r, r * 2, r * 2);
          } else {
            context.moveTo(cx + r, cy);
            context.arc(cx, cy, r, 0, tau);
          }
        }
        context.fill();
      }
    }
  };

  const draw = (now: number): void => {
    const { sign, fill, still } = latest.current;
    sharpen();
    const elapsed = then < 0 ? 1 / 60 : Math.min(now - then, 0.1);
    then = now;
    if (shown === sign) {
      present = still ? 1 : Math.min(1, present + elapsed / write.fade);
    } else {
      // A sign no longer wanted goes first, all of it together; then the next is written.
      present =
        shown === null || still
          ? 0
          : Math.max(0, present - elapsed / write.fade);
      if (present === 0) {
        shown = sign;
        since = now;
        present = 1;
      }
    }
    full += (fill - full) * (still ? 1 : 1 - (1 - 0.035) ** (elapsed * 60));
    if (pointer.inside) {
      spotX += (pointer.x - spotX) * (still ? 1 : 0.22);
      spotY += (pointer.y - spotY) * (still ? 1 : 0.22);
    }
    spot += ((pointer.inside ? 1 : 0) - spot) * (still ? 1 : 0.12);
    gather(now, still);
    paint();
  };

  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  watcher.observe(element);
  let frame = 0;
  const run = (ms: number): void => {
    frame = requestAnimationFrame(run);
    if (visible) {
      draw(ms / 1000);
    }
  };
  frame = requestAnimationFrame(run);

  const onMove = (event: PointerEvent): void => {
    const rect = host.getBoundingClientRect();
    if (rect.width > 0) {
      pointer.x = ((event.clientX - rect.left) / rect.width) * CANVAS;
      pointer.y = ((event.clientY - rect.top) / rect.height) * CANVAS;
      pointer.inside = true;
    }
  };
  const onLeave = (): void => {
    pointer.inside = false;
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  // It prints in the brain's colours, which change with the theme.
  const repaint = (): void => {
    styles = palette(element);
  };
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", repaint);
  const themes = new MutationObserver(repaint);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  return () => {
    cancelAnimationFrame(frame);
    watcher.disconnect();
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerleave", onLeave);
    scheme.removeEventListener("change", repaint);
    themes.disconnect();
  };
};

/** The sign over the head's square: `fill` is how full he is. */
export const DotSign = ({
  sign,
  fill,
}: {
  sign: Sign | null;
  fill: number;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const still = useLessMotion();
  const latest = useRef<Latest>({ sign, fill, still });
  useEffect(() => {
    latest.current = { sign, fill, still };
  });
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : animate(element, latest);
  }, []);
  return (
    <canvas
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      ref={canvas}
    />
  );
};
