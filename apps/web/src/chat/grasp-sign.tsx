import { useEffect, useRef } from "react";

import { ALPHAS, bucketOf, HEATS, palette } from "../brain/dot-ink.ts";
import {
  formed,
  moveBody,
  newBody,
  seeded,
  slotsOf,
  standIn,
  takeFigure,
} from "./sign-body.ts";
import type { PenPose, SignBody } from "./sign-body.ts";
import { PEN_TIP, SIGN_FIGURES, SIGN_PITCH } from "./sign-figures.ts";
import type { SignFigure } from "./sign-figures.ts";
import { figureFor } from "./sign.ts";
import type { SignState } from "./sign.ts";

// Grasp in the chat, under its newest answer while it works on it
// (grasplabs/prototype `components/chat/grasp-sign.tsx`): a few hundred
// dots in the onboarding's ink that take the figure of what it is doing.
// They are the brain while it reads the workspace (warmth runs down it)
// and while it thinks (ripples run through it); a pen over the line it
// writes, at the pace the words come in; a workflow of two steps while its
// code runs; a warm exclamation mark, shaken once, when it failed.
//
// It is always the same dots, and smooth at all times: from one figure
// into the next every dot flows on a soft spring (sign-body.ts), so a
// figure deforms as one mass. Warmth comes up only once a figure has
// formed, and a figure, once taken, is kept for a while (`hold`): when
// Grasp is quicker than that, the sign leaves out what came and went in
// between rather than flicker through it. It turns to the pointer when
// that comes near, and its dots swell and warm under it.
//
// There is one sign, and it goes when the answer is done: the thread never
// shows it at rest, so the prototype's moments of being done (the check
// mark, the nod and the ring) and its dozing have nothing to mark here.
// From the line that says Grasp reads to the answer, it goes on from where
// the last one was. Decorative: the answer says what happened. With less
// motion it takes each figure at once and holds still.

const tau = Math.PI * 2;
/** How large the sign is in the line of an answer, and how much room it has around that, in pixels (`size-10` in `size-15`). */
const box = 40;
const bleed = 10;
const field = box + bleed * 2;
const middle = field / 2;
/** The figure's units in pixels, and with that the distance between neighbouring dots. */
const scale = (box / 2) * 0.94;
const gap = SIGN_PITCH * scale;
/** Dot sizes as shares of that distance, lightest to darkest and never larger than `most`; each dot also has a size of its own, by `variety`. */
const dotLook = { light: 0.2, dark: 0.45, most: 0.48, variety: 0.22 };
/** A figure, once taken, is kept at least this long, in seconds. */
const hold = 1.7;
/** How far the pointer is noticed from, in pixels, and for how long after it last moved; and how far the sign turns towards it, in radians. */
const notice = { within: 170, seconds: 3.5, yaw: 0.6, pitch: 0.42 };
/** Each word that comes in moves the pen: how much one character adds, and how long the push lasts. */
const voiceLook = { character: 0.05, seconds: 0.4 };
/** The pen writes its line in about this long, up to `quick` times faster while words come in, then lifts back in `back` of that. */
const writingLook = { seconds: 2.4, quick: 1.8, back: 0.3 };
/** It breathes, and sways through its rows as the onboarding's brain does. */
const alive = { breath: 0.012, flow: 0.012, drift: 0.006 };
/** How far from the pointer the dots swell and warm, in pixels; and in about how many seconds any warmth comes up and goes. */
const reach = box * 0.42;
const warming = 0.09;
/** The brain thinking: ripples of warmth run out from a point that wanders about its middle. */
const thought = { x: 0.34, y: 0.26, rings: 7, speed: 4.6, reach: 0.95 };

const brainIndex = SIGN_FIGURES.indexOf("brain");
const penIndex = SIGN_FIGURES.indexOf("pen");

const clamp = (value: number, least = -1, most = 1): number =>
  Math.min(most, Math.max(least, value));

/** Slow out, fast through the middle, slow in. */
const ease = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** Reads a typed array where the index is known to be inside it. */
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/**
 * Everything about the sign that lasts from frame to frame: its dots, what
 * it shows it is doing and since when, how it is turned, and how far its
 * pen is.
 */
interface Life {
  body: SignBody;
  /** Each dot's warmth. */
  heat: Float32Array;
  /** What it shows it is doing, which runs behind what Grasp does by the time a figure is kept. */
  doing: SignState | undefined;
  doingAt: number;
  /** How it is turned, sideways and up or down, on a spring. */
  yaw: number;
  pitch: number;
  yawSpeed: number;
  pitchSpeed: number;
  /** How far the pen is in its line, and how loud the words come in. */
  written: number;
  voice: number;
}

const newLife = (): Life => {
  const body = newBody();
  return {
    body,
    heat: new Float32Array(body.count),
    doing: undefined,
    doingAt: 0,
    yaw: 0,
    pitch: 0,
    yawSpeed: 0,
    pitchSpeed: 0,
    written: 0,
    voice: 0,
  };
};

/**
 * The sign as it was when the last one went, for the next one to go on
 * with: it is one sign that moves from the line that says Grasp reads to
 * its answer, and on to the next. Good for a moment only, and once.
 */
let handed: { when: number; life: Life } | null = null;
const handedFor = 700;

/** What a frame shares with every dot in it. */
interface Moment {
  now: number;
  still: boolean;
  doing: SignState;
  /** How formed the figure is, 0 to 1, and how softly warmth follows a change. */
  settled: number;
  soft: number;
  /** Whether the pen writes, and where its point is. */
  writing: boolean;
  tipX: number;
  /** How long the figure has shown what it does, and where the brain's thinking ripples out from. */
  shownFor: number;
  thoughtX: number;
  thoughtY: number;
}

/** Warmth that runs through a figure along its line, over and over. */
const sweep = (shownFor: number, speed: number): number =>
  ((shownFor * speed) % 1.3) - 0.15;

/** The warmth of what Grasp is doing, at a dot of the figure it is part of. */
const warmthOf = (
  index: number,
  dot: number,
  x: number,
  y: number,
  seed: number,
  moment: Moment
): number => {
  const { doing, still, now, shownFor } = moment;
  if (still) {
    return doing === "error" ? 0.6 : 0;
  }
  const table = slotsOf(index);
  const where = at(table.along, dot);
  if (index === penIndex) {
    // The line is warm where it was just written.
    return moment.writing && at(table.part, dot) === 0
      ? 0.85 * Math.exp(-(((moment.tipX - at(table.x, dot)) / 0.26) ** 2))
      : 0;
  }
  if (index === brainIndex && doing === "thinking") {
    const far = Math.hypot(x - moment.thoughtX, y - moment.thoughtY);
    return (
      (0.12 +
        0.8 *
          Math.max(
            0,
            Math.sin(far * thought.rings - shownFor * thought.speed)
          ) **
            2) *
      Math.max(0, 1 - far / thought.reach)
    );
  }
  if (doing === "reading") {
    return 0.9 * Math.exp(-(((where - sweep(shownFor, 0.75)) / 0.1) ** 2));
  }
  if (doing === "working" && index !== brainIndex) {
    return 0.9 * Math.exp(-(((where - sweep(shownFor, 0.85)) / 0.16) ** 2));
  }
  if (doing === "error" && index !== brainIndex) {
    return 0.62 + 0.06 * Math.sin(now * 2.1 + seed * 6);
  }
  return 0;
};

/** Draws every dot's path in its colour: one fill per colour. */
const paint = (
  context: CanvasRenderingContext2D,
  styles: readonly string[],
  drawn: readonly number[][]
): void => {
  context.clearRect(0, 0, field, field);
  for (const [bucket, list] of drawn.entries()) {
    if (list.length > 0) {
      context.fillStyle = styles[bucket] ?? "transparent";
      context.beginPath();
      for (let index = 0; index < list.length; index += 3) {
        const x = at(list, index);
        const y = at(list, index + 1);
        const r = at(list, index + 2);
        context.moveTo(x + r, y);
        context.arc(x, y, r, 0, tau);
      }
      context.fill();
    }
  }
};

/** What the drawing needs to know, as the page last said it. */
interface Said {
  state: SignState;
}

/** The running sign: told when Grasp does something new, and when words come in. */
interface Engine {
  wake: () => void;
  speak: (characters: number) => void;
  stop: () => void;
}

/** Draws the sign on `element`, following what `latest` says, until it is stopped. */
const animate = (
  element: HTMLCanvasElement,
  latest: { current: Said }
): Engine | undefined => {
  const context = element.getContext("2d");
  const host = element.parentElement;
  if (context === null || host === null) {
    return undefined;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 4);
  element.width = field * dpr;
  element.height = field * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Whether the person asks for less motion: followed as it changes.
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let still = motion.matches;
  let styles = palette(element);

  // The sign the last one left, or a new one: its dots in a small cloud,
  // to gather into its first figure. A sign that starts failed is not
  // going on with what the last one did.
  const life =
    !still &&
    handed !== null &&
    performance.now() - handed.when < handedFor &&
    latest.current.state !== "error"
      ? handed.life
      : newLife();
  handed = null;
  const { body, heat } = life;

  // Every dot keeps its own grain and its own pace, so the print is
  // uneven, like ink.
  const random = seeded(7);
  const seed = new Float32Array(body.count);
  const grain = new Float32Array(body.count);
  for (let dot = 0; dot < body.count; dot += 1) {
    seed[dot] = random();
    grain[dot] = random() ** 2;
  }

  // The pointer on the page and when it last moved; whether it is over
  // the sign, and the warm spot that follows it there.
  const pointer = { x: 0, y: 0, moved: Number.NEGATIVE_INFINITY, over: false };
  const spot = { strength: 0, x: middle, y: middle };

  const drawn: number[][] = Array.from({ length: ALPHAS * HEATS }, () => []);
  const print = (
    x: number,
    y: number,
    r: number,
    alpha: number,
    warmth: number
  ): void => {
    const bucket = bucketOf(alpha, warmth);
    if (bucket > 0) {
      drawn[bucket]?.push(x, y, r);
    }
  };

  /** Takes up what Grasp is doing; failing shakes it once. */
  const takeUp = (next: SignState, now: number): void => {
    const before = life.doing;
    life.doing = next;
    if (before === next) {
      return;
    }
    life.doingAt = now;
    if (!still && before !== undefined && next === "error") {
      life.yawSpeed += 9;
    }
  };

  let visible = true;

  let frame = 0;
  let running = false;
  let then = -1;

  /** Where the pen stands, and moves it on while Grasp writes. */
  const penPose = (
    wanted: SignFigure,
    settled: number,
    since: number
  ): PenPose => {
    const writing = wanted === "pen" && !still;
    // It writes only while Grasp does: kept on show after the words have
    // stopped, it rests on its line.
    if (
      writing &&
      settled > 0.5 &&
      life.doing === "writing" &&
      latest.current.state === "writing"
    ) {
      const pace = 1 + (writingLook.quick - 1) * Math.min(1, life.voice * 1.5);
      life.written =
        (life.written + (since * pace) / writingLook.seconds) %
        (1 + writingLook.back);
    }
    const lift =
      writing && life.written > 1 ? (life.written - 1) / writingLook.back : 0;
    if (!writing) {
      return { at: 0.5, lift, writing };
    }
    return {
      at: life.written <= 1 ? life.written : 1 - ease(lift),
      lift,
      writing,
    };
  };

  /** Turns it towards the pointer when that is near and moving, or as what it does has it look. */
  const turn = (now: number, since: number, rect: DOMRect): void => {
    const dx = pointer.x - (rect.left + rect.width / 2);
    const dy = pointer.y - (rect.top + rect.height / 2);
    let wantYaw = 0;
    let wantPitch = 0;
    const shownFor = now - life.doingAt;
    if (
      pointer.over ||
      (now - pointer.moved < notice.seconds &&
        Math.hypot(dx, dy) < notice.within)
    ) {
      wantYaw = clamp(dx / 90) * notice.yaw;
      wantPitch = clamp(dy / 90) * notice.pitch;
    } else if (life.doing === "reading") {
      // Side to side, and a little down, as eyes go over a page.
      wantYaw = 0.22 * Math.sin(shownFor * 2.2);
      wantPitch = 0.12;
    } else if (life.doing === "thinking") {
      wantYaw = 0.3 * Math.sin(shownFor * 0.9);
    } else if (life.doing === "working") {
      wantYaw = 0.16 * Math.sin(shownFor * 1.5);
    }
    if (still) {
      life.yaw = 0;
      life.pitch = 0;
      return;
    }
    life.yawSpeed += ((wantYaw - life.yaw) * 90 - life.yawSpeed * 13) * since;
    life.pitchSpeed +=
      ((wantPitch - life.pitch) * 90 - life.pitchSpeed * 13) * since;
    life.yaw += life.yawSpeed * since;
    life.pitch += life.pitchSpeed * since;
  };

  /** Prints one dot: where the turn puts it, as warm and as large as it is now. */
  const printDot = (dot: number, moment: Moment, size: number): void => {
    const index = at(body.aim, dot);
    if (index >= SIGN_FIGURES.length) {
      return;
    }
    let x = at(body.x, dot);
    const y = at(body.y, dot);
    const z = at(body.z, dot);
    const shown = at(body.there, dot);
    const own = at(seed, dot);
    const { now, still: held } = moment;
    // Dots under way stay plain; warmth comes up once the figure has
    // formed, and softly whenever it changes.
    const warmth = warmthOf(index, dot, x, y, own, moment);
    heat[dot] =
      at(heat, dot) + (warmth * moment.settled - at(heat, dot)) * moment.soft;
    if (shown < 0.02) {
      return;
    }
    // Alive, not heaving: a faint sway through the rows, so neighbouring
    // dots move together.
    if (!held) {
      x +=
        alive.flow *
          (Math.sin(now * 1.3 + y * 4) + 0.4 * Math.sin(now * 2.2 + y * 11)) +
        alive.drift * Math.sin(now * 2.1 + own * tau);
    }
    // Turned about the middle of the sign.
    const rx = x * Math.cos(life.yaw * 0.6) + z * Math.sin(life.yaw * 0.6);
    const depth = -x * Math.sin(life.yaw * 0.6) + z * Math.cos(life.yaw * 0.6);
    const nod = life.pitch * 0.6;
    const ry = y * Math.cos(nod) - depth * Math.sin(nod);
    const rz = y * Math.sin(nod) + depth * Math.cos(nod);
    const perspective = 3.4 / (3.4 - rz);
    const sx = middle + rx * perspective * size;
    const sy = middle - ry * perspective * size;

    // Under the pointer the dots swell and warm.
    let warm = at(heat, dot);
    let near = 0;
    if (spot.strength > 0.01) {
      const far = Math.hypot(sx - spot.x, sy - spot.y);
      if (far < reach) {
        const t = 1 - far / reach;
        near = spot.strength * t * t * (3 - 2 * t);
        warm = Math.max(warm, 0.5 * near);
      }
    }
    const printed = at(body.ink, dot);
    let alpha = (0.6 + 0.36 * printed) * shown;
    if (!held) {
      alpha *= 0.93 + 0.07 * Math.sin(now * 1.4 + own * 60);
    }
    if (warm > 0.12) {
      alpha = Math.max(alpha, (0.45 + 0.5 * warm) * shown);
    }
    // Sized against the spacing, so dots stand apart; a dot that goes into
    // another shrinks as it goes.
    const ownSize =
      1 - 0.55 * dotLook.variety + 1.3 * dotLook.variety * at(grain, dot);
    const share = Math.min(
      dotLook.most,
      (dotLook.light + (dotLook.dark - dotLook.light) * printed) * ownSize
    );
    print(
      sx,
      sy,
      gap *
        share *
        perspective *
        (0.45 + 0.55 * shown) *
        Math.min(1 + 0.2 * warm + 0.45 * near, dotLook.most / share),
      alpha,
      warm
    );
  };

  /** Moves the sign on to what Grasp does, and its dots on by `since` seconds. */
  const step = (
    now: number,
    since: number
  ): { doing: SignState; settled: number; pen: PenPose } => {
    const real = latest.current.state;

    // What it shows follows what Grasp does, but a figure on show is first
    // given its time.
    if (life.doing === undefined || still) {
      takeUp(real, now);
    } else if (
      real !== life.doing &&
      (now - body.since >= hold || figureFor(real) === body.figure)
    ) {
      takeUp(real, now);
    }
    const doing = life.doing ?? real;
    const wanted = figureFor(doing);

    // Words coming in fade out as a voice does.
    life.voice *= Math.exp(-since / voiceLook.seconds);
    if (wanted === "pen" && body.figure !== "pen") {
      life.written = 0;
    }
    if (!still) {
      takeFigure(body, wanted, now);
    }
    const settled = still ? 1 : formed(body, now);
    const pen = penPose(wanted, settled, since);
    if (still) {
      standIn(body, wanted, pen);
    } else {
      moveBody(body, now, since, pen);
    }
    return { doing, settled, pen };
  };

  /** The warm spot glides after the pointer over the sign and fades in and out, so it never jumps. */
  const glide = (rect: DOMRect): void => {
    const by = still ? 1 : 0.3;
    if (pointer.over) {
      spot.x += (pointer.x - rect.left - spot.x) * by;
      spot.y += (pointer.y - rect.top - spot.y) * by;
    }
    spot.strength +=
      ((pointer.over ? 1 : 0) - spot.strength) * (still ? 1 : 0.16);
  };

  const draw = (ms: number): void => {
    running = !still;
    if (running) {
      frame = requestAnimationFrame(draw);
    }
    if (!visible) {
      return;
    }
    const now = ms / 1000;
    const since = then < 0 ? 1 / 60 : Math.min(now - then, 0.1);
    then = now;
    const { doing, settled, pen } = step(now, since);
    const rect = element.getBoundingClientRect();
    turn(now, since, rect);
    glide(rect);

    const shownFor = now - life.doingAt;
    const moment: Moment = {
      now,
      still,
      doing,
      settled,
      soft: still ? 1 : 1 - Math.exp(-since / warming),
      writing: pen.writing,
      tipX: PEN_TIP.x + (pen.at - 0.5) * 2 * PEN_TIP.travel,
      shownFor,
      thoughtX: thought.x * Math.sin(shownFor * 0.9),
      thoughtY: 0.05 + thought.y * Math.sin(shownFor * 0.7 + 1),
    };
    const size = scale * (still ? 1 : 1 + alive.breath * Math.sin(now * 1.1));
    for (const list of drawn) {
      list.length = 0;
    }
    for (let dot = 0; dot < body.count; dot += 1) {
      printDot(dot, moment, size);
    }
    paint(context, styles, drawn);
  };

  const wake = (): void => {
    if (running) {
      return;
    }
    running = true;
    frame = requestAnimationFrame(draw);
  };

  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    // A held sign drew nothing while out of sight: it draws what Grasp
    // does now once it is back.
    if (visible) {
      wake();
    }
  });
  watcher.observe(element);

  const onPointer = (event: PointerEvent): void => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.moved = performance.now() / 1000;
  };
  const onEnter = (event: PointerEvent): void => {
    pointer.over = true;
    onPointer(event);
    wake();
  };
  const onMove = (event: PointerEvent): void => {
    onPointer(event);
    wake();
  };
  const onLeave = (): void => {
    pointer.over = false;
    wake();
  };
  host.addEventListener("pointerenter", onEnter);
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  if (!still) {
    window.addEventListener("pointermove", onPointer);
  }
  // Asking for less motion while it moves holds it still at once, and
  // the other way round.
  const onMotion = (): void => {
    still = motion.matches;
    if (still) {
      window.removeEventListener("pointermove", onPointer);
    } else {
      window.addEventListener("pointermove", onPointer);
    }
    wake();
  };
  motion.addEventListener("change", onMotion);
  // It prints in the brain's colours, which change with the theme.
  const repaint = (): void => {
    styles = palette(element);
    wake();
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", repaint);
  const themes = new MutationObserver(repaint);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  wake();

  return {
    wake,
    speak: (characters) => {
      life.voice = Math.min(1, life.voice + characters * voiceLook.character);
    },
    stop: () => {
      cancelAnimationFrame(frame);
      watcher.disconnect();
      window.removeEventListener("pointermove", onPointer);
      motion.removeEventListener("change", onMotion);
      scheme.removeEventListener("change", repaint);
      themes.disconnect();
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      // It goes on in the next sign. One that never drew has nothing to
      // hand on.
      if (body.figure !== null) {
        handed = { when: performance.now(), life };
      }
    },
  };
};

/**
 * Grasp's sign: the figure of what it is doing (`state`). `said` is how
 * much of the answer has come in, in characters: as it grows, the pen
 * writes on.
 */
export const GraspSign = ({
  state,
  said = 0,
}: {
  state: SignState;
  said?: number;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef<Said>({ state });
  const engine = useRef<Engine | null>(null);
  const heard = useRef(said);

  // The page says something new: the drawing takes it up, at once also
  // where it holds still.
  useEffect(() => {
    if (latest.current.state !== state) {
      latest.current = { state };
      engine.current?.wake();
    }
  }, [state]);
  useEffect(() => {
    const grown = said - heard.current;
    heard.current = said;
    if (grown > 0) {
      engine.current?.speak(grown);
    }
  }, [said]);
  useEffect(() => {
    const element = canvas.current;
    const started = element === null ? undefined : animate(element, latest);
    engine.current = started ?? null;
    return () => {
      started?.stop();
      engine.current = null;
    };
  }, []);

  return (
    <span className="relative block size-10 flex-none">
      <canvas
        aria-hidden="true"
        className="pointer-events-none absolute -inset-2.5 size-15"
        ref={canvas}
      />
    </span>
  );
};
