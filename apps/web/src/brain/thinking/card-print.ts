import { seeded } from "../reveal-motion.ts";
import type { ThinkingMap, ThinkingNeuron } from "./layout.ts";
import {
  curveDots,
  designFor,
  nerveCurve,
  nerveDots,
  neuronKind,
  placed,
  printAlpha,
  printPart,
  somaCount,
  somaDots,
} from "./neurons.ts";

// Grasp's thinking as a small picture in an answer (grasplabs/prototype
// `components/chat/thinking-card.tsx`), as pure numbers: the shape laid out
// as the brain lays it out, looked at by a camera fitted to it, its
// neurons printed from the brain's own designs as the dive prints them,
// and names kept the size they are on screen however close the camera
// comes. Drawn by chat/thinking-card.tsx.

/** The room the shape is laid out in, as the brain would lay it out on a page. */
export const CARD_ROOM = { width: 720, height: 420 };
/** The picture: so wide and high, the shape fitted into it with this much room round it, and drawn at most this much larger than in the brain. */
export const VIEW = { width: 600, height: 220, pad: 16, most: 1.8 };
/** A name in the card: on at most two lines of about so many letters; on screen, about this wide a letter, and the room its lines and hours take round it. */
const NAME_LINE = 18;
const NAME_PX = {
  letter: 6.6,
  half: 64,
  high: 52,
  least: 104,
  hours: { half: 22, high: 22 },
};
/** Over this many neurons, names wait: at this size only the finding has room for them. */
const NAMED_UP_TO = 3;
/** How far apart the card prints a neuron's dots, in pixels on screen: a little finer than the brain, as the picture is small. */
export const SPACING = 2.6;

/** A dot of the picture: where, how large and how bold. */
export interface Dot {
  x: number;
  y: number;
  r: number;
  a: number;
}

const named = (map: ThinkingMap): ThinkingNeuron[] =>
  map.neurons.filter((neuron) => neuron.quiet !== true && neuron.bare !== true);

/** What the shape takes up, on the screen's axes (y down): each soma with its dendrites over and beside it. */
export const boundsOf = (
  map: ThinkingMap
): { left: number; right: number; top: number; bottom: number } => {
  const box = {
    left: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  for (const neuron of map.neurons) {
    box.left = Math.min(box.left, neuron.x - neuron.r * 2);
    box.right = Math.max(box.right, neuron.x + neuron.r * 2);
    box.top = Math.min(box.top, -neuron.y - neuron.r * 2.6);
    box.bottom = Math.max(box.bottom, -neuron.y + neuron.r + 4);
  }
  return box;
};

/** How the card looks at the shape. */
export interface CardView {
  /** Whether the neurons are named: only when few are, at this size the finding. */
  naming: boolean;
  /** How many letters a line of a name may take; none where only the hours fit. */
  letters: number;
  /** Picture units to pixels on screen, at the camera's zoom. */
  text: number;
  /** The camera, as a CSS transform of the picture's units. */
  camera: string;
}

/**
 * The camera fitted to the shape, with room kept round it for names this
 * wide on screen; where not even a short name fits between neurons, as on
 * a phone, each says only its hours. `shown`: the picture's width on screen.
 */
export const cardView = (map: ThinkingMap, shown: number): CardView => {
  const naming = named(map).length <= NAMED_UP_TO;
  const scale = shown / VIEW.width;
  const box = boundsOf(map);
  const xs = named(map).map(({ x }) => x);
  const nearest =
    xs.length > 1
      ? Math.min(...xs.slice(1).map((x, at) => Math.abs(x - (xs[at] ?? x))))
      : Number.POSITIVE_INFINITY;
  const fit = (room: { half: number; high: number }): number =>
    Math.min(
      (VIEW.width - 2 * VIEW.pad - (2 * room.half) / scale) /
        Math.max(box.right - box.left, 1),
      (VIEW.height - 2 * VIEW.pad - room.high / scale) /
        Math.max(box.bottom - box.top, 1),
      VIEW.most
    );
  const full = naming ? NAME_PX : { half: 0, high: 0 };
  const short = naming && nearest * fit(full) * scale < NAME_PX.least;
  const room = short ? NAME_PX.hours : full;
  const zoom = fit(room);
  const between = nearest * zoom * scale;
  return {
    naming,
    letters: short
      ? 0
      : Math.max(
          9,
          Math.min(NAME_LINE, Math.floor((between - 10) / NAME_PX.letter))
        ),
    text: zoom * scale,
    camera: `translate(${VIEW.width / 2}px, ${(VIEW.height - room.high / scale) / 2}px) scale(${zoom}) translate(${-(box.left + box.right) / 2}px, ${-(box.top + box.bottom) / 2}px)`,
  };
};

/** A name on at most two lines of about so many letters, broken between words, the rest cut with an ellipsis. */
export const linesOf = (name: string, letters: number): string[] => {
  const lines: string[] = [];
  for (const word of name.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= letters) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines.length <= 2 ? lines : [lines[0] ?? "", `${lines[1] ?? ""}…`];
};

/**
 * A neuron printed as the brain prints it, in its own radius, y down: its
 * design's soma, hollow while waiting, and its dendrites unless it is a
 * bead on a nerve. `onScreen`: its radius in pixels on screen.
 */
export const printed = (neuron: ThinkingNeuron, onScreen: number): Dot[] => {
  const design = designFor(neuron.id, neuronKind(neuron));
  // In the neuron's own radius, the spacing on screen is this many radii.
  const step = SPACING / Math.max(onScreen, 1);
  const waiting = neuron.state === "waiting";
  const grain = seeded(design.index * 131 + 7);
  const dots: Dot[] = [];
  somaDots(
    design,
    Math.max(18, somaCount(onScreen, SPACING)),
    waiting,
    (x, y, ink) => {
      dots.push({
        x,
        y: -y,
        r: step * printPart("soma", ink, waiting, 0.55 + 0.9 * grain()),
        a: printAlpha("soma", ink, waiting),
      });
    }
  );
  if (neuron.bare !== true) {
    for (const dendrite of placed(design, 0, 0, 1)) {
      curveDots(dendrite, step, (x, y, ink) => {
        dots.push({
          x,
          y: -y,
          r: step * printPart("strand", ink, waiting, 0.55 + 0.9 * grain()),
          a: printAlpha("strand", ink, waiting),
        });
      });
    }
  }
  return dots;
};

/** The nerves the shape holds, as the brain prints them: beaded strands from soma to soma, sagging a little. `text`: picture units to pixels on screen. */
export const nervesOf = (
  map: ThinkingMap,
  text: number
): { id: string; dots: Dot[] }[] =>
  map.nerves.flatMap((nerve) => {
    const from = map.neurons[nerve.from];
    const to = map.neurons[nerve.to];
    if (from === undefined || to === undefined) {
      return [];
    }
    const dots: Dot[] = [];
    // On the screen's axes, y down, as the brain's canvas draws a nerve.
    const curve = nerveCurve(
      { x: from.x, y: -from.y, r: from.r },
      { x: to.x, y: -to.y, r: to.r },
      nerve.bow
    );
    nerveDots(
      curve,
      { reach: 1, fresh: 1, signal: -1, tried: false },
      SPACING / text,
      0.32,
      (x, y, r, alpha) => {
        dots.push({ x, y, r, a: Math.min(alpha, 1) });
      }
    );
    return [{ id: `${from.id}:${to.id}`, dots }];
  });

/** A quadratic curve between two neurons' edges, sagging by `bow` of its length; the map's y runs up, the screen's down. */
export const threadPath = (
  from: ThinkingNeuron,
  to: ThinkingNeuron,
  bow: number
): string => {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const ax = from.x + ux * from.r;
  const ay = from.y + uy * from.r;
  const bx = to.x - ux * to.r;
  const by = to.y - uy * to.r;
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2 - length * bow;
  return `M ${ax} ${-ay} Q ${cx} ${-cy} ${bx} ${-by}`;
};
