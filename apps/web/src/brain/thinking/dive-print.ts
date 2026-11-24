import { seeded } from "../reveal-motion.ts";
import { easeInOut, smooth } from "./dive-scene.ts";
import { SAG } from "./layout.ts";
import type { ThinkingMap, ThinkingNeuron } from "./layout.ts";
import {
  curveDots,
  designFor,
  NERVE,
  nerveCurve,
  nerveDots,
  nerveNow,
  neuronKind,
  placed,
  printAlpha,
  printPart,
  somaCount,
  somaDots,
} from "./neurons.ts";
import type { Thought } from "./shapes.ts";

// The dive's print (grasplabs/prototype `lib/dive-print.ts`): Grasp's
// thinking as dots in the dive's own pixels, the neurons from the set of
// designs (neurons.ts), the threads by the nerve printer, and how the
// shape moves from step to step. Pure: the painters (WebGL, or a 2D canvas
// where that won't start) only draw what this puts.

/**
 * A new step, in order (ms): what leaves fades in `leave`; what stays sets
 * off `after`, each a `stagger` after the one before but all within
 * `spread`, and takes `travel` to arrive; what is new grows in over `grow`.
 */
export const MOVE = {
  leave: 320,
  after: 240,
  travel: 950,
  stagger: 30,
  spread: 300,
  grow: 520,
};

/** A neuron printed once, at a size and a spacing: x, y, ink, tone, whether a dendrite, how far along it, and a grain of its own, per dot. */
export interface Print {
  r: number;
  step: number;
  dots: Float32Array;
}
const PRINT_FLOATS = 7;

/** A neuron of the shape as it is drawn now, in the dive's pixels. */
export interface LiveNeuron {
  x: number;
  y: number;
  r: number;
  fromX: number;
  fromY: number;
  fromR: number;
  toX: number;
  toY: number;
  toR: number;
  start: number;
  grownFrom: number;
  leftAt: number;
  shown: number;
  alive: boolean;
  lit: number;
  heat: number;
  back: number;
  open: boolean;
  waiting: boolean;
  print: Print;
}

/** A dot put on the screen: where (pixels), how large, how bold, how warm, and whether in the attention colour (1). */
export type Put = (
  x: number,
  y: number,
  radius: number,
  alpha: number,
  heat: number,
  tone: number
) => void;

/** A neuron printed from its design: its soma, and its dendrites unless it is a bead on a nerve. */
export const printNeuron = (neuron: ThinkingNeuron, step: number): Print => {
  const design = designFor(neuron.id, neuronKind(neuron));
  const out: number[] = [];
  const grain = seeded(design.index * 131 + 7);
  somaDots(
    design,
    Math.max(24, somaCount(neuron.r, step)),
    neuron.state === "waiting",
    (x, y, ink, tone) => {
      out.push(x * neuron.r, y * neuron.r, ink, tone, 0, 0, grain());
    }
  );
  if (neuron.bare !== true) {
    for (const curve of placed(design, 0, 0, neuron.r)) {
      curveDots(curve, step, (x, y, ink, tone, along) => {
        out.push(x, y, ink, tone, 1, along, grain());
      });
    }
  }
  return { r: neuron.r, step, dots: new Float32Array(out) };
};

/** A neuron new to the shape, where it belongs, waiting to grow in. */
const newNeuron = (
  neuron: ThinkingNeuron,
  x: number,
  y: number,
  step: number,
  ms: number
): LiveNeuron => ({
  x,
  y,
  r: neuron.r,
  fromX: x,
  fromY: y,
  fromR: neuron.r,
  toX: x,
  toY: y,
  toR: neuron.r,
  start: Number.NEGATIVE_INFINITY,
  grownFrom: ms,
  leftAt: -1,
  shown: 0,
  alive: true,
  heat: 0,
  lit: 0,
  back: 0,
  open: neuron.state === "open",
  waiting: neuron.state === "waiting",
  print: printNeuron(neuron, step),
});

/**
 * The shape laid out anew (a new step, `moved`, or the same one on a new
 * screen): what isn't in it any more leaves; what stays is sent on to its
 * new place in order; what is new grows in as what stays arrives.
 */
export const layOut = (
  live: Map<string, LiveNeuron>,
  neurons: readonly ThinkingNeuron[],
  room: { x: number; y: number },
  step: number,
  ms: number,
  moved: boolean
): void => {
  const staying = new Set(neurons.map(({ id }) => id));
  const leaving = [...live.keys()].some((id) => !staying.has(id));
  for (const [id, each] of live) {
    if (!staying.has(id) && each.alive) {
      each.alive = false;
      each.leftAt = ms;
    }
  }
  const after = moved && leaving ? MOVE.after : 0;
  let travelling = 0;
  const arriving: LiveNeuron[] = [];
  for (const neuron of neurons) {
    const x = room.x + neuron.x;
    const y = room.y - neuron.y;
    const known = live.get(neuron.id);
    const waiting = neuron.state === "waiting";
    if (known?.alive === true) {
      const far =
        Math.hypot(x - known.toX, y - known.toY) > 0.5 ||
        Math.abs(neuron.r - known.toR) > 0.5;
      Object.assign(known, {
        fromX: known.x,
        fromY: known.y,
        fromR: known.r,
        toX: x,
        toY: y,
        toR: neuron.r,
      });
      known.start =
        moved && far
          ? ms + after + Math.min(travelling * MOVE.stagger, MOVE.spread)
          : Number.NEGATIVE_INFINITY;
      travelling += moved && far ? 1 : 0;
      if (
        Math.abs(neuron.r - known.print.r) > 0.5 ||
        known.print.step !== step ||
        known.waiting !== waiting
      ) {
        known.print = printNeuron(neuron, step);
      }
      known.open = neuron.state === "open";
      known.waiting = waiting;
    } else {
      const each = newNeuron(neuron, x, y, step, ms);
      live.set(neuron.id, each);
      arriving.push(each);
    }
  }
  if (moved) {
    for (const each of arriving) {
      each.grownFrom = ms + after + (travelling > 0 ? MOVE.travel * 0.6 : 0);
    }
  }
};

/** How far toward `to` a value eases in `since` seconds, over about `over` seconds. */
const toward = (
  value: number,
  to: number,
  since: number,
  over: number
): number => value + (to - value) * Math.min(1, since / over);

/**
 * Every neuron a frame on, `since` seconds after the last: what a beat
 * names (`named`) bolder and warm, the rest stepping back, what the step
 * lights bolder; each on its way, eased, and growing in or fading out;
 * gone once faded. With less motion (`still`) each is where it ends.
 */
export const settle = (
  live: Map<string, LiveNeuron>,
  neurons: readonly ThinkingNeuron[],
  lit: ReadonlySet<string>,
  named: boolean,
  since: number,
  ms: number,
  still: boolean
): void => {
  for (const neuron of neurons) {
    const each = live.get(neuron.id);
    if (each !== undefined) {
      const isLit =
        lit.has(neuron.id) || neuron.noteIds.some((id) => lit.has(id));
      each.lit = toward(each.lit, isLit ? 1 : 0, since, 0.22);
      each.heat = toward(each.heat, isLit && named ? 1 : 0, since, 0.22);
      each.back = toward(each.back, named && !isLit ? 1 : 0, since, 0.25);
    }
  }
  for (const [id, each] of live) {
    const travelled = still
      ? 1
      : easeInOut(Math.min(1, Math.max(0, (ms - each.start) / MOVE.travel)));
    each.x = each.fromX + (each.toX - each.fromX) * travelled;
    each.y = each.fromY + (each.toY - each.fromY) * travelled;
    each.r = each.fromR + (each.toR - each.fromR) * travelled;
    if (still) {
      each.shown = each.alive ? 1 : 0;
    } else if (each.alive) {
      each.shown = smooth(each.grownFrom, each.grownFrom + MOVE.grow, ms);
    } else {
      each.shown = Math.min(
        each.shown,
        1 - Math.min(1, (ms - each.leftAt) / MOVE.leave)
      );
    }
    if (!each.alive && each.shown <= 0) {
      live.delete(id);
    }
  }
};

/** Whether a neuron has come to where it is going and grown in: its name shows then. */
export const arrived = (each: LiveNeuron, ms: number): boolean =>
  ms >= each.start + MOVE.travel && each.shown > 0.8;

/** One dot of a neuron's print, as bold and warm as it is now. */
const printDot = (
  each: LiveNeuron,
  dots: Float32Array,
  at: number,
  ripple: (x: number, y: number) => number
): {
  x: number;
  y: number;
  alpha: number;
  heat: number;
  dendrite: boolean;
  ink: number;
  own: number;
} => {
  const scaled = each.r / each.print.r;
  const ink = dots[at + 2] ?? 0;
  const dendrite = (dots[at + 4] ?? 0) > 0.5;
  const x = (dots[at] ?? 0) * scaled;
  const y = (dots[at + 1] ?? 0) * scaled;
  let alpha = printAlpha(dendrite ? "strand" : "soma", ink, each.waiting);
  alpha += (Math.max(alpha, 0.5 + 0.45 * ink) - alpha) * each.lit;
  let heat = 0;
  if (each.heat > 0.01) {
    const wave = ripple(x, y);
    heat = each.heat * (0.2 + 0.6 * wave ** 3);
    alpha = Math.max(alpha, each.heat * (0.35 + 0.4 * wave));
  }
  return {
    x,
    y,
    alpha,
    heat,
    dendrite,
    ink,
    own: 0.55 + 0.9 * (dots[at + 6] ?? 0),
  };
};

/**
 * A neuron's print where it is now: each dot as bold as its ink and as
 * large, the atlas's own rule; hollow while waiting; bolder while lit, and
 * warm in ripples from its middle while a beat names it; fainter while the
 * rest is named; its dendrites growing out as it grows in.
 */
export const printLive = (
  each: LiveNeuron,
  step: number,
  growing: number,
  still: boolean,
  seconds: number,
  put: Put
): void => {
  const shown = each.shown * growing;
  if (shown <= 0) {
    return;
  }
  const fade = 1 - 0.5 * each.back;
  const { dots } = each.print;
  const ripple = (x: number, y: number): number =>
    still ? 0.5 : 0.5 + 0.5 * Math.sin(seconds * 3 - Math.hypot(x, y) * 0.12);
  for (let at = 0; at < dots.length; at += PRINT_FLOATS) {
    const dot = printDot(each, dots, at, ripple);
    if (!dot.dendrite || (dots[at + 5] ?? 0) <= shown * 1.25 - 0.1) {
      put(
        each.x + dot.x,
        each.y - dot.y,
        step *
          printPart(
            dot.dendrite ? "strand" : "soma",
            dot.ink,
            each.waiting,
            dot.own
          ),
        dot.alpha * fade * (dot.dendrite ? 1 : Math.min(1, shown * 1.4)),
        dot.heat,
        each.open ? 1 : 0
      );
    }
  }
};

/**
 * The threads of a step, as the atlas draws its nerves: the ones Grasp
 * tries, the shape's nerves, and the beat's; each as far as it has grown
 * at `wall` (ms since 1970).
 */
export const printThreads = (
  shape: ThinkingMap,
  thought: Thought,
  live: ReadonlyMap<string, LiveNeuron>,
  step: number,
  growing: number,
  wall: number,
  still: boolean,
  put: Put
): void => {
  const idOf = (at: number): string | undefined => shape.neurons[at]?.id;
  const thread = (
    from: string | undefined,
    to: string | undefined,
    bow: number,
    began: number,
    grow: number,
    retracts?: number
  ): void => {
    const a = from === undefined ? undefined : live.get(from);
    const b = to === undefined ? undefined : live.get(to);
    const now = nerveNow(wall - began, grow, retracts, still);
    if (a === undefined || b === undefined || now === null) {
      return;
    }
    const curve = nerveCurve(a, b, bow);
    const both = Math.min(a.shown, b.shown);
    if (curve.length >= step * 3) {
      nerveDots(
        curve,
        { ...now, reach: now.reach * growing },
        step,
        0.32,
        (x, y, radius, alpha, heat) => {
          put(x, y, radius, alpha * both, heat, 0);
        }
      );
    }
  };
  for (const probe of shape.probes) {
    thread(
      idOf(probe.from),
      idOf(probe.to),
      SAG,
      thought.since + probe.delay,
      NERVE.tried,
      probe.holds ? undefined : probe.reach
    );
  }
  for (const nerve of shape.nerves) {
    thread(
      idOf(nerve.from),
      idOf(nerve.to),
      nerve.bow,
      thought.nerveAt,
      NERVE.nerve
    );
  }
  const { beat } = thought;
  if (beat?.thread !== undefined) {
    thread(beat.thread[0], beat.thread[1], SAG, beat.since, NERVE.tried);
  }
};
