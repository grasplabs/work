// The tones: a kind's or a speaker's colour, each drawn from a status or accent token, so it
// follows light and dark. Three strengths: the ink, a token made to stand as words on the page
// (4.5:1 or more, light and dark), for a kind's pill words and its mark on the timeline; the wash,
// the soft status ground (or a little of the accent in the raised ground), the pill's fill, on
// which the ink holds 4.5:1; and the middle, half ink and half ground, a speaker's quiet stretch on
// the timeline and the ring round their portrait. A tone never says anything alone: the kind's
// label or the speaker's name is always written beside it.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";
import { toneVars } from "./tone.stylex";
import type { InterviewTone } from "./types";

/** A little over half a tone's ink in the raised ground taken grey first, so the hue stays in dark too: quiet, and told apart. */
// Joined, not a template: a colour value, which the words check would read as a sentence.
const middle = (ink: string) =>
  [
    "color-mix(in oklch,",
    ink,
    "55%, oklch(from",
    grasp.raised,
    "l 0 none))",
  ].join(" ");

// The accents have no soft ground of their own: a little of the accent in the raised ground, as
// soft as the status grounds. The ground is taken grey first (no chroma, no hue), so the mix
// keeps the accent's hue: in dark, where the ground is a deep green, a violet wash stays violet
// and never turns teal.
export const tones = stylex.create({
  sea: {
    [toneVars.ink]: grasp.info,
    [toneVars.wash]: grasp.infoSoft,
    [toneVars.mid]: middle(grasp.info),
  },
  violet: {
    [toneVars.ink]: grasp.lavender,
    [toneVars.wash]: `color-mix(in oklch, ${grasp.lavender} 20%, oklch(from ${grasp.raised} l 0 none))`,
    [toneVars.mid]: middle(grasp.lavender),
  },
  leaf: {
    [toneVars.ink]: grasp.success,
    [toneVars.wash]: grasp.successSoft,
    [toneVars.mid]: middle(grasp.success),
  },
  amber: {
    [toneVars.ink]: grasp.attention,
    [toneVars.wash]: grasp.attentionSoft,
    [toneVars.mid]: middle(grasp.attention),
  },
  pine: {
    [toneVars.ink]: grasp.pine,
    [toneVars.wash]: `color-mix(in oklch, ${grasp.pine} 12%, oklch(from ${grasp.raised} l 0 none))`,
    [toneVars.mid]: middle(grasp.pine),
  },
  rose: {
    [toneVars.ink]: grasp.danger,
    [toneVars.wash]: grasp.dangerSoft,
    [toneVars.mid]: middle(grasp.danger),
  },
  neutral: {
    [toneVars.ink]: grasp.muted,
    [toneVars.wash]: grasp.soft,
    [toneVars.mid]: middle(grasp.muted),
  },
});

/** The six speaker tints, in the order they are handed out: no two alike within six speakers. */
export const speakerTones: readonly InterviewTone[] = [
  "sea",
  "violet",
  "leaf",
  "amber",
  "pine",
  "rose",
];

/** A speaker's tint from their place among the speakers, from 0. */
export const toneOf = (index: number): InterviewTone =>
  speakerTones[index % speakerTones.length] ?? "neutral";
