import { useEffect, useRef } from "react";

import {
  ALPHAS,
  bucketOf,
  CANVAS,
  DOT_MOST,
  dotAlpha,
  dotShare,
  HEATS,
  LOOK,
  MORPH_S,
  palette,
  patchAt,
  REACH,
  shimmerAt,
  SPREAD_S,
} from "../brain/dot-ink.ts";
import { headDotCount, headDots, headEar, headPitch } from "./head-dots.ts";

// Grasp's buddy: the head from the prototype's onboarding, Stephen in dots,
// small (grasplabs/prototype `components/grasp-buddy.tsx`). Rows of dots
// sized by the photo's shading; alive the same way: its dots gather from a
// small cloud when the page opens, sway faintly through the rows, fade and
// return in drifting patches, and swell and warm under the pointer. While
// the person types, its ear warms. A warm ring runs through it once it has
// gathered, and when it is clicked. Decorative only. With less motion it
// stands still and only answers the pointer.

/** How large the buddy is on screen, in pixels, and drawn at that size. */
const size = 128;
/** The onboarding's own drawing size: the buddy's reach and ring scale from it. */
const small = size / CANVAS;
const tau = Math.PI * 2;
/** This small, its patches of faintness go this deep at most. */
const tideDepth = 0.5;
/** The sway through its rows and each dot's own drift, in the figure's units. */
const flow = 0.007;
const drift = 0.003;
/** Its ear warms this much with every key, and cools in about this long. */
const heard = { key: 0.45, seconds: 0.9 };
/** The warm ring: how fast and how wide it runs, in pixels, and how long it lasts. */
const ringLook = { speed: 240 * small, width: 22 * small, seconds: 1.8 };

interface Head {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  tone: Float32Array;
  ink: Float32Array;
}

let decoded: Head | undefined;

/** The head's dots, read from their numbers once. */
const head = (): Head => {
  if (decoded !== undefined) {
    return decoded;
  }
  const bytes = Uint8Array.from(
    atob(headDots),
    (char) => char.codePointAt(0) ?? 0
  );
  const view = new DataView(bytes.buffer);
  const read = (at: number, low: number, high: number): number =>
    low + (view.getUint16(at * 2, true) / 65_535) * (high - low);
  const x = new Float32Array(headDotCount);
  const y = new Float32Array(headDotCount);
  const z = new Float32Array(headDotCount);
  const tone = new Float32Array(headDotCount);
  const ink = new Float32Array(headDotCount);
  for (let at = 0; at < headDotCount; at += 1) {
    x[at] = read(at * 5, -1.5, 1.5);
    y[at] = read(at * 5 + 1, -1.5, 1.5);
    z[at] = read(at * 5 + 2, -1.5, 1.5);
    tone[at] = read(at * 5 + 3, 0, 1);
    ink[at] = read(at * 5 + 4, 0, 1);
  }
  decoded = { x, y, z, tone, ink };
  return decoded;
};

/** A small seeded random (Park–Miller), so the head gathers the same way each time. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

interface Cloud {
  seed: Float32Array;
  grain: Float32Array;
  delay: Float32Array;
  lift: Float32Array;
  from: Float32Array;
  ear: Float32Array;
}

/**
 * Every dot's own chance, grain, delay and lift, so the head gathers
 * unevenly, like ink; where it starts in the small cloud; and how much of
 * the ear it is.
 */
const cloudOf = (shape: Head): Cloud => {
  const count = headDotCount;
  const random = seeded(7);
  const seed = new Float32Array(count);
  const grain = new Float32Array(count);
  const delay = new Float32Array(count);
  const lift = new Float32Array(count);
  const from = new Float32Array(count * 3);
  const ear = new Float32Array(count);
  const [earX, earY, earZ] = headEar.at;
  for (let at = 0; at < count; at += 1) {
    seed[at] = random();
    grain[at] = random() ** 2;
    delay[at] = random() * SPREAD_S;
    lift[at] = 0.12 + random() * 0.4;
    const angle = random() * tau;
    const far = Math.sqrt(random()) * 0.35;
    from[at * 3] = Math.cos(angle) * far;
    from[at * 3 + 1] = Math.sin(angle) * far;
    from[at * 3 + 2] = (random() - 0.5) * 0.3;
    const off =
      ((shape.x[at] ?? 0) - earX) ** 2 +
      ((shape.y[at] ?? 0) - earY) ** 2 +
      ((shape.z[at] ?? 0) - earZ) ** 2;
    const weight = Math.exp(-off / (headEar.radius * headEar.radius));
    ear[at] = weight < 0.02 ? 0 : weight;
  }
  return { seed, grain, delay, lift, from, ear };
};

/** What a frame shares with every dot in it. */
interface Moment {
  now: number;
  age: number;
  morphing: boolean;
  still: boolean;
  /** How deep the patches of faintness go now, and where they are. */
  tide: number;
  /** How hard it listens to typing. */
  listening: number;
  /** How much of the warm ring is left, and how far it has run. */
  ringLeft: number;
  travelled: number;
}

interface Dot {
  x: number;
  y: number;
  z: number;
  lit: number;
  printed: number;
}

/** Eases in and out, cubically. */
const easeInOut = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** Dot `at` now: flying in from the cloud while it gathers, then swaying. */
const gathered = (
  shape: Head,
  cloud: Cloud,
  at: number,
  { now, age, morphing, still }: Moment
): Dot => {
  let x = shape.x[at] ?? 0;
  let y = shape.y[at] ?? 0;
  let z = shape.z[at] ?? 0;
  let lit = shape.tone[at] ?? 0;
  let printed = shape.ink[at] ?? 0;
  if (morphing) {
    const eased = easeInOut((age - (cloud.delay[at] ?? 0)) / MORPH_S);
    const fromX = cloud.from[at * 3] ?? 0;
    const fromY = cloud.from[at * 3 + 1] ?? 0;
    const fromZ = cloud.from[at * 3 + 2] ?? 0;
    x = fromX + (x - fromX) * eased;
    y = fromY + (y - fromY) * eased;
    z =
      fromZ +
      (z - fromZ) * eased +
      Math.sin(Math.PI * eased) * (cloud.lift[at] ?? 0);
    lit = 0.4 + (lit - 0.4) * eased;
    printed = 0.4 + (printed - 0.4) * eased;
  }
  // Alive, not heaving, and only sideways: a faint sway through the rows.
  if (!still) {
    x +=
      flow *
        (Math.sin(now * 1.3 + y * 4) + 0.4 * Math.sin(now * 2.2 + y * 11)) +
      drift * Math.sin(now * 2.1 + (cloud.seed[at] ?? 0) * tau);
  }
  return { x, y, z, lit, printed };
};

/** How much a dot `distance` pixels from the warm spot swells and glows. */
const nearness = (distance: number, reach: number, spot: number): number => {
  if (distance >= reach) {
    return 0;
  }
  const t = 1 - distance / reach;
  return spot * t * t * (3 - 2 * t);
};

/** A dot's warmth: under the pointer, at the ear while typing, and in the ring. */
const heatOf = (
  near: number,
  ear: number,
  own: number,
  ringOff: number,
  { now, still, listening, ringLeft }: Moment
): number => {
  let heat = LOOK.warm * near;
  if (ear > 0 && listening > 0.02) {
    const pulse = still ? 0.6 : 0.75 + 0.25 * Math.sin(now * 9 + own * 3);
    heat = Math.max(heat, ear * listening * pulse);
  }
  if (ringLeft > 0 && ringOff * ringOff < 4) {
    heat = Math.max(heat, 0.75 * ringLeft * Math.exp(-ringOff * ringOff));
  }
  return heat;
};

/** How strongly a dot is printed: its ink, the tide, and its warmth. */
const alphaOf = (
  { x, y, lit, printed }: Dot,
  own: number,
  near: number,
  heat: number,
  { now, still, tide }: Moment
): number => {
  let alpha = dotAlpha(printed, lit, true);
  if (!still) {
    alpha *= shimmerAt(own, now);
  }
  alpha *= Math.min(1, Math.max(0, (1.3 - Math.hypot(x, y)) / 0.35));
  if (tide > 0) {
    const shown = 1 - tide * (1 - patchAt(x, y, now));
    // The pointer finds what the tide hides.
    alpha *= shown + (1 - shown) * LOOK.reveal * near;
  }
  return heat > 0.12 ? Math.max(alpha, 0.45 + 0.5 * heat) : alpha;
};

/** A dot's radius as a share of the spacing, so dots always stand apart. */
const radiusOf = (
  printed: number,
  grain: number,
  near: number,
  heat: number
): number => {
  const share = dotShare(printed, true, grain);
  return share * Math.min(1 + 0.25 * heat + LOOK.grow * near, DOT_MOST / share);
};

/** Where a frame put every dot, how large, and in which colour. */
interface Frame {
  screenX: Float32Array;
  screenY: Float32Array;
  radius: Float32Array;
  bucket: Uint16Array;
  counts: Uint32Array;
  starts: Uint32Array;
  order: Uint32Array;
}

/** Draws a frame: one path per colour, every dot of that ink and warmth in one fill. */
const paint = (
  context: CanvasRenderingContext2D,
  styles: readonly string[],
  dpr: number,
  { screenX, screenY, radius, bucket, counts, starts, order }: Frame
): void => {
  let offset = 0;
  for (let b = 0; b < counts.length; b += 1) {
    starts[b] = offset;
    offset += counts[b] ?? 0;
  }
  for (let at = 0; at < bucket.length; at += 1) {
    const b = bucket[at] ?? 0;
    const place = starts[b] ?? 0;
    order[place] = at;
    starts[b] = place + 1;
  }
  context.clearRect(0, 0, size, size);
  let next = 0;
  for (let b = 0; b < counts.length; b += 1) {
    const many = counts[b] ?? 0;
    // The faintest colour is not printed at all.
    if (many > 0 && b % ALPHAS !== 0) {
      context.fillStyle = styles[b] ?? "transparent";
      context.beginPath();
      for (let k = next; k < next + many; k += 1) {
        const at = order[k] ?? 0;
        const r = radius[at] ?? 0;
        const cx = screenX[at] ?? 0;
        const cy = screenY[at] ?? 0;
        // Round wherever a screen can show it; a dot of a pixel is a square.
        if (r * dpr < 1.1) {
          context.rect(cx - r, cy - r, r * 2, r * 2);
        } else {
          context.moveTo(cx + r, cy);
          context.arc(cx, cy, r, 0, tau);
        }
      }
      context.fill();
    }
    next += many;
  }
};

/** Draws the buddy on `element` until the returned function stops it. */
const animate = (element: HTMLCanvasElement): (() => void) => {
  const context = element.getContext("2d");
  if (context === null) {
    return () => {
      // Nothing to stop.
    };
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  element.width = size * dpr;
  element.height = size * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let styles = palette(element);
  const repaint = (): void => {
    styles = palette(element);
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", repaint);
  const themes = new MutationObserver(repaint);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  const shape = head();
  const count = headDotCount;
  const cloud = cloudOf(shape);

  const screenX = new Float32Array(count);
  const screenY = new Float32Array(count);
  const radius = new Float32Array(count);
  const bucket = new Uint16Array(count);
  const counts = new Uint32Array(ALPHAS * HEATS);
  const starts = new Uint32Array(ALPHAS * HEATS);
  const order = new Uint32Array(count);

  const scale = size * 0.43 * LOOK.air;
  const middle = size / 2;
  const gap = headPitch * scale;
  const reach = REACH * LOOK.reach * small;

  // The warm spot glides after the pointer and fades in and out.
  const pointer = { x: middle, y: middle, inside: false };
  let spotX = middle;
  let spotY = middle;
  let spot = 0;
  let listening = 0;
  const ring = { x: middle, y: middle, at: -Infinity };
  let greeted = false;

  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  watcher.observe(element);

  let frame = 0;
  let born = -1;
  let then = -1;
  const draw = (ms: number): void => {
    frame = requestAnimationFrame(draw);
    if (!visible) {
      return;
    }
    const now = ms / 1000;
    if (born < 0) {
      born = now;
    }
    const since = then < 0 ? 1 / 60 : Math.min(now - then, 0.1);
    then = now;
    const age = now - born;
    const morphing = !still && age < MORPH_S + SPREAD_S;
    if (!still && !greeted && age > MORPH_S + SPREAD_S + 0.15) {
      greeted = true;
      ring.x = middle;
      ring.y = middle;
      ring.at = now;
    }
    const tide = still
      ? 0
      : tideDepth * smoothstep(0.12, 0.6, 0.5 - 0.5 * Math.cos(age * 0.21));
    const follow = still ? 1 : 0.22;
    if (pointer.inside) {
      spotX += (pointer.x - spotX) * follow;
      spotY += (pointer.y - spotY) * follow;
    }
    spot += ((pointer.inside ? 1 : 0) - spot) * (still ? 1 : 0.12);
    const hovering = spot > 0.01;
    listening *= Math.exp(-since / heard.seconds);
    const travelled = (now - ring.at) * ringLook.speed;
    const ringLeft = 1 - (now - ring.at) / ringLook.seconds;

    counts.fill(0);
    const moment: Moment = {
      now,
      age,
      morphing,
      still,
      tide,
      listening,
      ringLeft,
      travelled,
    };
    for (let at = 0; at < count; at += 1) {
      const dot = gathered(shape, cloud, at, moment);
      const own = cloud.seed[at] ?? 0;
      const perspective = 3.4 / (3.4 - dot.z);
      const sx = middle + dot.x * perspective * scale;
      const sy = middle - dot.y * perspective * scale;
      const near = hovering
        ? nearness(Math.hypot(sx - spotX, sy - spotY), reach, spot)
        : 0;
      const ringOff =
        (Math.hypot(sx - ring.x, sy - ring.y) - travelled) / ringLook.width;
      const heat = heatOf(near, cloud.ear[at] ?? 0, own, ringOff, moment);
      const alpha = alphaOf(dot, own, near, heat, moment);
      screenX[at] = sx;
      screenY[at] = sy;
      radius[at] =
        radiusOf(dot.printed, cloud.grain[at] ?? 0, near, heat) *
        gap *
        perspective;
      const b = bucketOf(alpha, heat);
      bucket[at] = b;
      counts[b] = (counts[b] ?? 0) + 1;
    }

    paint(context, styles, dpr, {
      screenX,
      screenY,
      radius,
      bucket,
      counts,
      starts,
      order,
    });
  };
  frame = requestAnimationFrame(draw);

  const place = (event: PointerEvent): { x: number; y: number } => {
    const box = element.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * size,
      y: ((event.clientY - box.top) / box.height) * size,
    };
  };
  const onMove = (event: PointerEvent): void => {
    Object.assign(pointer, place(event), { inside: true });
  };
  const onLeave = (): void => {
    pointer.inside = false;
  };
  const onDown = (event: PointerEvent): void => {
    if (!still) {
      Object.assign(ring, place(event), { at: performance.now() / 1000 });
    }
  };
  // It listens while the person types, wherever on the page that is.
  const onInput = (event: Event): void => {
    if (
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    ) {
      listening = Math.min(1, listening + heard.key);
    }
  };
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerleave", onLeave);
  element.addEventListener("pointerdown", onDown);
  document.addEventListener("input", onInput);

  return () => {
    cancelAnimationFrame(frame);
    watcher.disconnect();
    themes.disconnect();
    scheme.removeEventListener("change", repaint);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerleave", onLeave);
    element.removeEventListener("pointerdown", onDown);
    document.removeEventListener("input", onInput);
  };
};

/**
 * The buddy, 128px. `aligned` pulls it a little to the left, so its
 * shoulders line up with words under it, as on the chat's start.
 */
export const GraspBuddy = ({ aligned = false }: { aligned?: boolean }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : animate(element);
  }, []);
  return (
    <canvas
      aria-hidden="true"
      className={aligned ? "-ml-4 size-32 flex-none" : "size-32 flex-none"}
      ref={canvas}
    />
  );
};
