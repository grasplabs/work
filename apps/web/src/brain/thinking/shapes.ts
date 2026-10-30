import type { Workspace } from "@grasp-os/shared/brain";
import type { ThinkingStep } from "@grasp-os/shared/thinking";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { MapRoom } from "../atlas-map.ts";
import type { Atlas, RegionId } from "../brain-atlas.ts";
import type { Brain } from "../brain.ts";
import { beatsEnd, readFor } from "./beats.ts";
import type { ThinkingBeat } from "./beats.ts";
import type { ThinkingMap } from "./layout.ts";
import { samePainAt, samePainBeats, samePainMap } from "./same-pain.ts";
import type { SamePainFigure } from "./same-pain.ts";

// Grasp's thinking, shown in the brain (grasplabs/prototype
// `lib/thinking-shapes.ts`). While Grasp answers, the brain's own dots take
// the shape of the answer, step by step: every dot a real note that opens,
// never a picture made up. A step says what Grasp does, the notes it looks
// at and the shape the brain takes (@grasp-os/shared/thinking); each shape
// is a module of pure numbers: the steps and the brain in, where every
// neuron sits out (same-pain.ts), and what the brain does beat by beat.
// The same pain is the first shape here; where the hours go comes next.

/** What the brain shows at a step. */
export type ThinkingFigure = SamePainFigure;

/** Grasp's thinking as a view draws it: the shape, what Grasp does now, whether it is still at it, and when the step and its nerve began (ms since 1970). */
export interface Thought {
  figure: ThinkingFigure;
  text: string;
  going: boolean;
  since: number;
  nerveAt: number;
  /** The beat the step is at: what lights up, the thread it runs and when it began. */
  beat?: { lit: string[]; thread?: [string, string]; since: number };
}

/** What a picture of the same pain is of, as the way back from it names it. */
export const samePainTitle: MessageDescriptor = msg`The same pain in more than one team`;

/** How long each move is shown at the least, however few its beats: looking takes longest, while threads are tried and let go. */
const PACE: Record<string, number> = {
  teams: 2600,
  said: 4600,
  together: 2600,
};

/** What the brain shows at step `at`, its own sentence up as long as it takes to read before the first beat; nothing when it has nothing to show. */
export const figureAt = (
  steps: readonly ThinkingStep[],
  at: number,
  ws: Workspace,
  brain: Brain,
  atlas: Atlas
): ThinkingFigure | undefined => {
  const step = steps[at];
  const figure =
    step === undefined ? undefined : samePainAt(steps, at, ws, brain, atlas);
  return figure === undefined || step === undefined
    ? figure
    : { ...figure, lead: readFor(step.text.length) };
};

/** A shape laid out in a room of so many pixels. */
export const thinkingMap = (
  figure: ThinkingFigure,
  room: MapRoom
): ThinkingMap => samePainMap(figure, room);

/** What the brain does, beat by beat, while a step is shown. */
export const beatsOf = (figure: ThinkingFigure): ThinkingBeat[] =>
  samePainBeats(figure);

/** How long a step is shown: its move's own pace, or as long as its beats take, the last line read. */
export const paceOf = (
  step: ThinkingStep,
  beats: readonly ThinkingBeat[]
): number => Math.max(PACE[step.move] ?? 0, beatsEnd(beats));

/** The part of the brain a thinking is about, where the way back leads: the part that holds the teams it found, when one part holds them all; none for the whole brain. */
export const aboutRegion = (
  steps: readonly ThinkingStep[],
  atlas: Atlas
): RegionId | undefined => {
  const last = steps.at(-1);
  if (last?.shape !== "same-pain") {
    return undefined;
  }
  const parts = new Set(last.notes.flatMap((id) => atlas.home.get(id) ?? []));
  return parts.size === 1 ? [...parts][0] : undefined;
};

/** What a step teaches the brain, as links between two teams: once found, a link between each two teams that said the same, in the brain's order. */
export const thinkingTeaches = (
  step: ThinkingStep,
  ws: Workspace
): [string, string][] => {
  if (step.shape !== "same-pain" || step.move !== "together") {
    return [];
  }
  const teams = ws.teams
    .filter((team) => step.notes.includes(team.id))
    .map((team) => team.id);
  return teams
    .slice(1)
    .map((id, index): [string, string] => [teams[index] ?? "", id]);
};
