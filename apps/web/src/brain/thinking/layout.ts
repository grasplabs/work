import type { Neuron } from "../atlas-map.ts";

// A shape of Grasp's thinking laid out in a room of pixels (grasplabs/
// prototype `lib/thinking-layout.ts`): its neurons, its nerves and its
// threads, and the measures every shape keeps to, so the line, the names
// and the nerves sit the same in each. The dive draws it (dive.tsx).

/** A neuron of the shape: a team, something said, or a workflow. */
export interface ThinkingNeuron extends Neuron {
  /** For something found: who said it, as a role and a team. */
  by?: string;
  /** Named only when pointed at: what was said, as a bead on the nerve. */
  quiet?: boolean;
  /** Its dendrites stand over it only, so its name stands clear under it. */
  crown?: boolean;
  /** No dendrites: a bead on a nerve. */
  bare?: boolean;
  /** Where its words stand instead of under it, in the map's pixels: under the nerve it is a bead on. Its top middle. */
  say?: { x: number; y: number };
  /** The stems to underline in its words: the words both teams used. */
  marks?: string[];
  /** For a workflow once Grasp has weighed it: its hours a week, said under its name; null while they are not known. */
  hours?: number | null;
}

/** A nerve of the shape: between two of its neurons, by their place, sagging by this share of its length. */
export interface ThinkingNerve {
  from: number;
  to: number;
  bow: number;
}

/** A thread Grasp tries, by its neurons' places: when it sets off after the step began (ms), and how far it reaches if it doesn't hold. */
export interface ThinkingProbe {
  from: number;
  to: number;
  holds: boolean;
  delay: number;
  reach: number;
}

/** The shape laid out in a room of pixels. */
export interface ThinkingMap {
  neurons: ThinkingNeuron[];
  nerves: ThinkingNerve[];
  probes: ThinkingProbe[];
  /** How wide a name under a neuron may be, and whether names are set a size smaller. */
  names: { width: number; small: boolean };
  /** How wide the words under the nerve are, in pixels. */
  said: number;
  /** Where the line that says what Grasp does stands, in the map's pixels, and how wide it may be. */
  caption: { x: number; y: number; width: number };
}

/** The line near the top: how far down its middle is, how high it is, and the room under it. */
export const CAPTION = { down: 54, high: 42, under: 20 };
/** A team's soma: the smallest and the largest, its share of the room's smaller side, and how far up its dendrites reach, in its radius. */
export const TEAM_R = { least: 10, most: 24, share: 0.034, reach: 2.6 };
/** A name under a soma: a line, set normally and a size smaller; the gap over it and the air under it. */
export const NAME = { line: 17.5, small: 15, gap: 7, air: 10 };
/** The ring of teams: the room kept beside it for a name, and the widest and highest it gets. */
export const RING = { name: 64, wide: 380, high: 250 };
/** How far the nerve sags, as a share of its length. */
export const SAG = 0.14;
/** How far under the line the teams that said the same stand, past their dendrites. */
export const PAIR_UNDER = 28;
/** A phone's room: narrower than this, the way back takes this much of its foot; names a size smaller under this width. */
export const PHONE = { width: 640, foot: 44, small: 600 };
