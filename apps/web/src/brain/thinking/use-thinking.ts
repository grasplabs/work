import type { Workspace } from "@grasp-os/shared/brain";
import type { ChatMessage } from "@grasp-os/shared/chat";
import type { ThinkingStep } from "@grasp-os/shared/thinking";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { Atlas } from "../brain-atlas.ts";
import type { Brain } from "../brain.ts";
import { beatsEnd } from "./beats.ts";
import type { BeatSay, ThinkingBeat } from "./beats.ts";
import { later } from "./later.ts";
import { thinkingIn, thinkingSchedule } from "./play.ts";
import { beatsOf, figureAt, paceOf, thinkingTeaches } from "./shapes.ts";
import type { ThinkingFigure } from "./shapes.ts";

// Grasp's thinking played in the brain, step by step and beat by beat
// (grasplabs/prototype `data/brain-thinking.ts`, its logic alone): when each
// step reached this tab, so it plays as it comes; the answers whose picture
// the person put away; and what the thinking found, a link between the
// teams that said the same, which grows in as a new nerve once the picture
// is put away and stays for the tab. Nothing of it is kept in the browser:
// the steps are core's, kept with the answer.

/** A link the thinking taught the brain: between two teams, from when it grows in. */
export interface Learned {
  id: string;
  from: string;
  to: string;
  at: number;
}

const arrived = new Map<string, number>();
const putAway = new Set<number>();
let learned: readonly Learned[] = [];
const listeners = new Set<() => void>();
let version = 0;

const changed = (): void => {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** How long after the picture is put away what it found sets off growing: once the brain is there to see it. */
const GROW_AFTER_MS = 900;

/** The calls whose findings were taught to the brain already. */
const taught = new Set<string>();

/**
 * The steps of a chat that reached this tab while Grasp answers
 * (`running`): when each first did, so it plays as it comes. Steps read
 * with an answer already done never play by themselves.
 */
export const noteArrivals = (
  messages: readonly ChatMessage[],
  running: boolean
): void => {
  if (!running) {
    return;
  }
  const now = Date.now();
  let any = false;
  for (const { calls } of thinkingIn(messages).slice(-1)) {
    for (const call of calls) {
      if (!arrived.has(call)) {
        arrived.set(call, now);
        any = true;
      }
    }
  }
  if (any) {
    changed();
  }
};

/**
 * The steps of a chat that reached this tab, as the brain takes them: when
 * each arrived, and what each finding teaches the brain, as links between
 * the teams that said the same.
 */
export const noteThinking = (
  messages: readonly ChatMessage[],
  running: boolean,
  ws: Workspace
): void => {
  noteArrivals(messages, running);
  const now = Date.now();
  const lessons: Learned[] = [];
  for (const { steps, calls } of thinkingIn(messages)) {
    for (const [index, call] of calls.entries()) {
      const step = steps[index];
      if (!taught.has(call) && step !== undefined) {
        taught.add(call);
        lessons.push(
          ...thinkingTeaches(step, ws).map(([from, to], at) => ({
            id: `${call}:${at}`,
            from,
            to,
            at: now,
          }))
        );
      }
    }
  }
  if (lessons.length > 0) {
    learned = [...learned, ...lessons];
    changed();
  }
};

/**
 * The person put a question's picture away: the brain is itself again,
 * and what the thinking found grows in now, where they are about to see it.
 */
export const putThinkingAway = (
  questionId: number,
  calls: readonly string[]
): void => {
  if (putAway.has(questionId)) {
    return;
  }
  putAway.add(questionId);
  const at = Date.now() + GROW_AFTER_MS;
  learned = learned.map((lesson) =>
    calls.some((call) => lesson.id.startsWith(`${call}:`))
      ? { ...lesson, at }
      : lesson
  );
  changed();
};

/** When each step arrived, the questions whose picture was put away, and what the thinking taught; renewed as they change. */
export const useThinkingLog = (): {
  arrived: ReadonlyMap<string, number>;
  putAway: ReadonlySet<number>;
  learned: readonly Learned[];
} => {
  useSyncExternalStore(subscribe, () => version);
  return { arrived, putAway, learned };
};

/**
 * Where a played thinking is: the step shown, whether Grasp is still at
 * it, and when each step began. Each step is shown when it arrived and
 * stays at least its own time (`paces`); a replay plays from when it is
 * opened; `open` keeps it going while Grasp still answers. A new `key`
 * starts again. With less motion every step is there at once.
 */
const useRun = (
  key: string | undefined,
  paces: readonly number[],
  still: boolean,
  arrivals: readonly (number | undefined)[] | undefined,
  open: boolean
): { at: number; going: boolean; began: number[] } => {
  const [run, setRun] = useState<{ key?: string; start: number; now: number }>({
    start: 0,
    now: 0,
  });
  const mine = key !== undefined && run.key === key;
  const began = mine
    ? thinkingSchedule(arrivals?.[0] ?? run.start, paces, arrivals)
    : [];
  const end = began.length > 0 ? (began.at(-1) ?? 0) + (paces.at(-1) ?? 0) : 0;
  const due = mine ? [...began, end].find((at) => at > run.now) : 0;
  useEffect(
    () =>
      key === undefined || still || due === undefined
        ? undefined
        : later(due, () => {
            setRun((before) => {
              const now = Date.now();
              return before.key === key
                ? { ...before, now }
                : { key, start: now, now };
            });
          }),
    [key, still, due]
  );
  if (key === undefined || paces.length === 0) {
    return { at: -1, going: false, began: [] };
  }
  if (still) {
    return { at: paces.length - 1, going: open, began: paces.map(() => 0) };
  }
  return {
    at: began.filter((each) => each <= run.now).length - 1,
    going: open || run.now < end,
    began,
  };
};

/** The beat a step is at: its place among `starts` (ms after `since`), or -1 before the first and from `end` on. With less motion, none. */
const useBeat = (
  key: string | undefined,
  since: number,
  starts: readonly number[],
  end: number,
  still: boolean
): number => {
  const [now, setNow] = useState(0);
  const due = [...starts, end].find((at) => since + at > now);
  useEffect(
    () =>
      key === undefined || still || due === undefined
        ? undefined
        : later(since + due, () => {
            setNow(Date.now());
          }),
    [key, since, due, still]
  );
  if (key === undefined || still || now < since || now - since >= end) {
    return -1;
  }
  return starts.filter((at) => at <= now - since).length - 1;
};

/** What a beat says the brain does, in the reader's language. */
export const beatWords = (said: BeatSay, i18n: I18n): string => {
  switch (said.kind) {
    case "reading": {
      const { name } = said;
      return i18n._(msg`Reading ${name}`);
    }
    case "pain": {
      const { team, words } = said;
      return i18n._(msg`${team}: “${words}”`);
    }
    case "same": {
      const { team } = said;
      return i18n._(msg`${team} says the same`);
    }
    case "other": {
      const { team } = said;
      return i18n._(msg`Not the same in ${team}`);
    }
    default: {
      return "";
    }
  }
};

/** Grasp's thinking as it plays at this moment. */
export interface PlayedThinking {
  /** The step shown, -1 before the first, and when each began (ms since 1970). */
  at: number;
  began: number[];
  going: boolean;
  figure?: ThinkingFigure;
  beat?: ThinkingBeat & { since: number };
  /** What the line over the shape says now: the beat's words, or the step's own sentence. */
  text?: string;
}

/**
 * Grasp's thinking played, step by step and beat by beat. `key` starts it
 * again; `arrivals` and `open` play it as Grasp answers; with less motion,
 * `still`, only the shape it ends in.
 */
export const usePlayedThinking = (
  key: string | undefined,
  steps: readonly ThinkingStep[],
  {
    ws,
    brain,
    atlas,
    still,
    arrivals,
    open = false,
    i18n,
  }: {
    ws: Workspace;
    brain: Brain;
    atlas: Atlas;
    still: boolean;
    arrivals?: readonly (number | undefined)[];
    open?: boolean;
    i18n: I18n;
  }
): PlayedThinking => {
  const shapes = steps.map((_, at) => figureAt(steps, at, ws, brain, atlas));
  const beats = shapes.map((shape) =>
    shape === undefined ? [] : beatsOf(shape)
  );
  const run = useRun(
    key,
    steps.map((each, at) => paceOf(each, beats[at] ?? [])),
    still,
    arrivals,
    open
  );
  const stepBeats = run.at >= 0 ? (beats[run.at] ?? []) : [];
  const since = run.began[run.at] ?? 0;
  const at = useBeat(
    key !== undefined && run.at >= 0 ? `${key}:${run.at}` : undefined,
    since,
    stepBeats.map((each) => each.at),
    beatsEnd(stepBeats),
    still
  );
  const beat = at >= 0 ? stepBeats[at] : undefined;
  const figure = run.at >= 0 ? shapes[run.at] : undefined;
  const step = steps[run.at];
  return {
    at: run.at,
    began: run.began,
    going: run.going,
    ...(figure === undefined ? {} : { figure }),
    ...(beat === undefined
      ? {}
      : { beat: { ...beat, since: since + beat.at } }),
    ...(figure === undefined || step === undefined
      ? {}
      : { text: beat === undefined ? step.text : beatWords(beat.say, i18n) }),
  };
};
