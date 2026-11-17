// ComposerVoice: dictation, drawn in a composer's place (give it as the composer's `takeover`).
// "The voice writes": a band of dithered light lies directly under the line being written, and one
// body of light in it breathes with the voice in place, centred and still (nothing travels); the
// words resolve out of the same dither at the caret, cell by cell, then turn to full ink once
// settled. The card's dithered working edge listens with it, quietly. Silence lays it low and
// breathing; a stretch unheard thins it; muted lays it flat and dim at once; writing it down drains
// it to its middle; Cancel dissolves this dictation's words back into dither. A problem shows no
// field, only the problem and Try again.
//
// It draws only what the host tells it: the phase, the words, the time, and the sound, either as
// `level` and `bands` props or, better, as `sample`, read at each frame so 60 values a second cost
// no render (useComposerMicrophone gives one). The field is one canvas (voice-field.ts), its motion
// a gate, auto-gain, an envelope and a spring (voice-motion.ts). With reduced motion the field is a
// still line that steps with the level at most four times a second, and words simply appear. In
// forced colours the field hides and a level meter stands in its place. The level is never the only
// signal: "Listening", the time and the polite announcements say it too.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";

import { Button } from "../button";
import { Alert, Cross, Icon, Mic, MicOff, Retry, Tick } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import { useComposerListen } from "./context";
import { useStill } from "./still-context";
import { startVoiceField } from "./voice-field";
import type { VoiceField, VoiceFieldMode } from "./voice-field";
import type { VoiceReading } from "./voice-motion";

export type { VoiceReading } from "./voice-motion";

/** What stops the microphone, or what came back wrong. `unheard` is a note while listening goes on. */
export type ComposerVoiceProblem =
  | "blocked"
  | "missing"
  | "unsupported"
  | "unheard"
  | "failed"
  | "limited";

/** Where a dictation is: asking for the microphone, listening, writing it down after Done, or stopped by a problem. */
export type ComposerVoicePhase =
  | "asking"
  | "listening"
  | "thinking"
  | "problem";

/** Every word ComposerVoice shows or says; the host translates them. */
export interface ComposerVoiceWords {
  asking: string;
  listening: string;
  thinking: string;
  silent: string;
  muted: string;
  done: string;
  cancel: string;
  mute: string;
  unmute: string;
  retry: string;
  /** The level meter's name, read in forced colours. */
  level: string;
  problems: Record<ComposerVoiceProblem, string>;
  /** The time listened, as words ("0:07"). */
  time: (ms: number) => string;
}

/** Every prop a ComposerVoice takes. */
export interface ComposerVoiceProps {
  phase: ComposerVoicePhase;
  /** What was typed before dictating: kept, in muted ink, before the dictation's words. */
  typed?: string;
  /** The words this dictation has settled. */
  settled: string;
  /** The words still being heard, replaced as they settle. */
  interim: string;
  /** How long it has listened, in ms. */
  elapsedMs: number;
  /** The person muted the microphone. */
  muted?: boolean;
  /** No sound for a while: said quietly as Paused. */
  silent?: boolean;
  /** What went wrong. With `unheard` listening goes on; the rest stop it. */
  problem?: ComposerVoiceProblem;
  /**
   * The sound now, read at every frame: return the level (0 to 1) and, if you have them, a few
   * bands' energy, low to high. Nothing re-renders for it. Takes the place of `level` and `bands`.
   */
  sample?: () => VoiceReading | undefined;
  /** The level now, 0 to 1, when the host renders it rather than giving `sample`. */
  level?: number;
  /** The bands' energy now, low to high, 0 to 1 each, with `level`. */
  bands?: readonly number[];
  words?: Partial<ComposerVoiceWords>;
  onDone: () => void;
  /** Runs once this dictation's words have dissolved (at once under reduced motion). */
  onCancel: () => void;
  onMute: () => void;
  onRetry: () => void;
}

export const composerVoiceWords: ComposerVoiceWords = {
  asking: "Asking for the microphone",
  listening: "Listening",
  thinking: "Writing it down",
  silent: "Paused",
  muted: "Muted",
  done: "Done",
  cancel: "Cancel",
  mute: "Mute",
  unmute: "Unmute",
  retry: "Try again",
  level: "Level",
  problems: {
    blocked:
      "The microphone is blocked for this site. Allow it in the browser's settings.",
    missing: "No microphone was found.",
    unsupported: "This browser can't dictate.",
    unheard: "A part couldn't be made out. What came before is kept.",
    failed: "The words couldn't be written down. What you typed is kept.",
    limited: "That's as long as one dictation can be.",
  },
  time: (ms) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  },
};

const breathe = stylex.keyframes({
  "0%": { opacity: 0.45 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.45 },
});

const styles = stylex.create({
  surface: {
    display: "grid",
    gap: grasp.space3,
    padding: grasp.space4,
    paddingBlockEnd: grasp.space3,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // The words' room: the text, and under it the band the light lies in (BAND), directly under the
  // line being written. Its height never changes, so nothing jumps as the voice swells.
  room: {
    position: "relative",
    isolation: "isolate",
    minWidth: 0,
    // Closed, the card is as tall as the composer it replaces, so nothing jumps either way.
    paddingBlockEnd: grasp.space3,
    transitionProperty: "padding-block-end",
    transitionDuration: { default: "220ms", [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
    // Closing waits a beat, so the light is seen draining before its band goes.
    transitionDelay: { default: "100ms", [media.reduced]: "0s" },
  },
  // The band opens as it starts listening and closes as it writes it down, is cancelled or stops.
  roomOpen: {
    paddingBlockEnd: {
      default: `calc(${grasp.space8} + ${grasp.space1})`,
      [media.forced]: grasp.space3,
    },
    transitionDelay: "0s",
  },
  words: {
    position: "relative",
    zIndex: 1,
    margin: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  typed: { color: grasp.muted },
  word: {
    color: grasp.ink,
    transitionProperty: "color",
    transitionDuration: { default: "200ms", [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  interim: { color: grasp.muted },
  caret: {
    display: "inline-block",
    width: "2px",
    height: "1.1em",
    marginInlineStart: "1px",
    verticalAlign: "text-bottom",
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.ink,
    animationName: { default: breathe, [media.reduced]: "none" },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  caretQuiet: { opacity: 0, animationName: "none" },
  // The field: over the whole room, under the words. In forced colours there is no light.
  field: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    color: grasp.ink,
    display: { default: "block", [media.forced]: "none" },
  },
  // Only in forced colours: the level as a meter.
  meter: {
    display: { default: "none", [media.forced]: "block" },
    width: "100%",
    height: grasp.space2,
  },
  foot: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  status: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    whiteSpace: "nowrap",
  },
  statusWords: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  time: { flexShrink: 0, fontVariantNumeric: "tabular-nums", color: grasp.ink },
  problem: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    margin: 0,
    padding: grasp.space3,
    borderRadius: grasp.corner,
    backgroundColor: grasp.itemFillHighlight,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
  },
  note: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  unseen: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** What an effect with nothing to undo returns. */
const holdNothing = () => {
  // Nothing was started.
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** One level of the dither (of 16) as a 4×4 tile, for a mask: the Showcase's resolve. */
const ditherTile = (level: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'>${BAYER.map(
      (value, index) =>
        value < level
          ? `<rect x='${index % 4}' y='${Math.floor(index / 4)}' width='1' height='1'/>`
          : ""
    ).join("")}</svg>`
  )}")`;

/** A word's way out of the dither: [density of 16, the cell in px], coarse and sparse to whole. */
const RESOLVE = [
  [2, 3],
  [4, 3],
  [6, 2],
  [9, 2],
  [12, 1],
  [14, 1],
] as const;

const resolveFrames = (): Keyframe[] => [
  ...RESOLVE.map(([level, size], index) => ({
    offset: index / RESOLVE.length,
    maskImage: ditherTile(level),
    maskSize: `${size * 4}px ${size * 4}px`,
    easing: "step-end",
  })),
  { offset: 1, maskImage: "none" },
];

/** How long a word takes to resolve, and to dissolve on Cancel. */
const RESOLVE_MS = 200;
const DISSOLVE_MS = 240;

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One word of the dictation: it resolves out of the dither when it first appears. */
const Word = ({
  text,
  settled,
  still,
}: {
  text: string;
  settled: boolean;
  still: boolean;
}) => {
  const word = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = word.current;
    if (
      element === null ||
      still ||
      reduced() ||
      typeof element.animate !== "function"
    ) {
      return holdNothing;
    }
    const motion = element.animate(resolveFrames(), {
      duration: RESOLVE_MS,
      fill: "backwards",
    });
    return () => {
      motion.cancel();
    };
  }, [still]);
  return (
    <span
      ref={word}
      data-slot="composer-voice-word"
      data-settled={settled}
      {...stylex.props(styles.word, !settled && styles.interim)}
    >
      {text}
    </span>
  );
};

/** The dictation's words as a list, settled first: a word keeps its element as it settles. */
const wordsOf = (settled: string, interim: string) => {
  const done = settled.split(/\s+/u).filter((part) => part !== "");
  const heard = interim.split(/\s+/u).filter((part) => part !== "");
  return [
    ...done.map((text) => ({ text, settled: true })),
    ...heard.map((text) => ({ text, settled: false })),
  ];
};

/** What the field does, from what the host says. */
const modeOf = (
  phase: ComposerVoicePhase,
  muted: boolean,
  silent: boolean,
  problem: ComposerVoiceProblem | undefined,
  leaving: boolean
): VoiceFieldMode => {
  if (leaving) {
    return "leaving";
  }
  if (phase === "thinking") {
    return "thinking";
  }
  if (phase !== "listening") {
    return "off";
  }
  if (muted) {
    return "muted";
  }
  if (problem === "unheard") {
    return "unheard";
  }
  if (silent) {
    return "silent";
  }
  return "listening";
};

/** What a screen reader hears, politely, as the phase changes. A problem is said by its own alert. */
const saidOf = (
  phase: ComposerVoicePhase,
  muted: boolean,
  problem: ComposerVoiceProblem | undefined,
  say: ComposerVoiceWords
) => {
  if (problem !== undefined && problem !== "unheard") {
    return "";
  }
  if (phase === "asking") {
    return say.asking;
  }
  if (phase === "thinking") {
    return say.thinking;
  }
  if (muted) {
    return say.muted;
  }
  return say.listening;
};

/** The band the light lies in, at the room's foot: 36px, space-8 and space-1. */
const BAND = 36;

/** What the host gives for the sound, kept in a ref for the frame loop. */
interface Reading {
  sample?: () => VoiceReading | undefined;
  level?: number;
  bands?: readonly number[];
}

/** The parts the field is drawn from and tells. */
interface FieldParts {
  room: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  meter: RefObject<HTMLMeterElement | null>;
}

/**
 * The field: started once its canvas is there, run while it is in view and the tab is shown, told
 * the mode, and redrawn as the room is resized (never laid out per
 * frame). The card's dithered edge listens with it. Returns nothing: everything goes through refs.
 */
const useVoiceField = (
  { room, canvas, meter }: FieldParts,
  reading: RefObject<Reading>,
  mode: VoiceFieldMode,
  on: boolean,
  still: boolean
) => {
  const listen = useComposerListen();
  const drawnLevel = useRef(0);
  const said = useRef(0);
  const modeNow = useRef(mode);
  const field = useRef<VoiceField | null>(null);

  useEffect(() => {
    modeNow.current = mode;
    field.current?.mode(mode);
  }, [mode]);

  useEffect(() => {
    const element = canvas.current;
    const box = room.current;
    if (element === null || box === null || !on) {
      return holdNothing;
    }
    const drawing = startVoiceField(element, {
      sample: () => {
        const now = reading.current;
        if (now.sample !== undefined) {
          return now.sample();
        }
        return now.level === undefined
          ? undefined
          : { level: now.level, bands: now.bands };
      },
      still: still || reduced(),
      band: BAND,
      onLevel: (value) => {
        // The meter (forced colours) at most four times a second; the card's edge at every frame.
        const now = performance.now();
        if (meter.current !== null && now - said.current > 250) {
          said.current = now;
          meter.current.value = Math.round(value * 10) / 10;
        }
        drawnLevel.current = value;
      },
    });
    field.current = drawing;
    drawing.mode(modeNow.current);
    let seen = true;
    const decide = () => {
      drawing.run(seen && document.visibilityState === "visible");
    };
    const watch = new IntersectionObserver((entries) => {
      seen = entries.some((entry) => entry.isIntersecting);
      decide();
    });
    // The room, not the canvas: in forced colours the canvas is hidden, and the meter still follows.
    watch.observe(box);
    document.addEventListener("visibilitychange", decide);
    decide();
    return () => {
      watch.disconnect();
      document.removeEventListener("visibilitychange", decide);
      drawing.stop();
      field.current = null;
    };
  }, [room, canvas, meter, reading, on, still]);

  // The card's dithered edge listens with the field, at a third of its swing.
  useEffect(() => {
    if (listen === null || !on) {
      return holdNothing;
    }
    listen({ read: () => drawnLevel.current });
    return () => {
      listen(null);
    };
  }, [listen, on]);
};

/** Dissolves this dictation's words back into dither, the way they came; true if any were there. */
const dissolve = (box: HTMLElement) => {
  const frames = resolveFrames().toReversed();
  const spaced = frames.map((frame, index) => ({
    ...frame,
    offset: index / Math.max(1, frames.length - 1),
  }));
  const all = [
    ...box.querySelectorAll<HTMLElement>("[data-slot=composer-voice-word]"),
  ];
  for (const element of all) {
    element.animate(spaced, { duration: DISSOLVE_MS, fill: "forwards" });
  }
  return all.length > 0;
};

/** The status line's words, beside the time. */
const statusOf = (
  phase: ComposerVoicePhase,
  muted: boolean,
  silent: boolean,
  problem: ComposerVoiceProblem | undefined,
  say: ComposerVoiceWords
) => {
  if (phase === "problem") {
    return "";
  }
  if (phase !== "listening") {
    return saidOf(phase, muted, problem, say);
  }
  if (muted) {
    return say.muted;
  }
  return silent ? say.silent : say.listening;
};

/** The meter (forced colours only), a stretch unheard, and a problem that stopped it. */
const VoiceNotes = ({
  meter,
  showField,
  phase,
  problem,
  say,
}: {
  meter: RefObject<HTMLMeterElement | null>;
  showField: boolean;
  phase: ComposerVoicePhase;
  problem: ComposerVoiceProblem | undefined;
  say: ComposerVoiceWords;
}) => {
  const meterId = useId();
  const stopping =
    phase === "problem" && problem !== undefined && problem !== "unheard";
  return (
    <>
      {showField ? (
        <>
          <label htmlFor={meterId} {...stylex.props(styles.unseen)}>
            {say.level}
          </label>
          <meter
            ref={meter}
            id={meterId}
            min={0}
            max={1}
            value={0}
            {...stylex.props(styles.meter)}
          />
        </>
      ) : null}
      {problem === "unheard" && phase === "listening" ? (
        <output {...stylex.props(styles.note)}>
          <Icon icon={Alert} />
          <span>{say.problems.unheard}</span>
        </output>
      ) : null}
      {stopping ? (
        <p role="alert" {...stylex.props(styles.problem)}>
          <Icon icon={Alert} />
          <span>{say.problems[problem]}</span>
        </p>
      ) : null}
    </>
  );
};

/** The ways out: Cancel, the time and the phase, then Mute and Done, or Try again after a problem. */
const VoiceFoot = ({
  phase,
  muted,
  status,
  elapsedMs,
  say,
  onCancel,
  onMute,
  onDone,
  onRetry,
}: {
  phase: ComposerVoicePhase;
  muted: boolean;
  status: string;
  elapsedMs: number;
  say: ComposerVoiceWords;
  onCancel: () => void;
  onMute: () => void;
  onDone: () => void;
  onRetry: () => void;
}) => (
  <div {...stylex.props(styles.foot)}>
    <Button
      variant="ghost"
      size="sm"
      icon={Cross}
      label={say.cancel}
      onClick={onCancel}
    />
    <p {...stylex.props(styles.status)}>
      <span {...stylex.props(styles.time)}>{say.time(elapsedMs)}</span>
      {status === "" ? null : (
        <span {...stylex.props(styles.statusWords)}>{status}</span>
      )}
    </p>
    {phase === "problem" ? (
      <Button variant="quiet" size="sm" icon={Retry} onClick={onRetry}>
        {say.retry}
      </Button>
    ) : (
      <>
        <Button
          variant="ghost"
          size="sm"
          icon={muted ? MicOff : Mic}
          label={muted ? say.unmute : say.mute}
          onClick={onMute}
          disabled={phase !== "listening"}
        />
        <Button
          variant="ink"
          size="sm"
          icon={Tick}
          label={say.done}
          onClick={onDone}
          disabled={phase !== "listening"}
        />
      </>
    )}
  </div>
);

/** Dictation in a composer's place: the words arriving out of the light, the time, and the ways out. */
export const ComposerVoice = ({
  phase,
  typed = "",
  settled,
  interim,
  elapsedMs,
  muted = false,
  silent = false,
  problem,
  sample,
  level,
  bands,
  words,
  onDone,
  onCancel,
  onMute,
  onRetry,
}: ComposerVoiceProps) => {
  const say = {
    ...composerVoiceWords,
    ...words,
    problems: { ...composerVoiceWords.problems, ...words?.problems },
  };
  const still = useStill();
  const room = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLMeterElement>(null);
  // The latest of what the host gives, for the frame loop to read: kept in a ref by an effect.
  const reading = useRef<Reading>({});
  const [leaving, setLeaving] = useState(false);
  // Cancelled: the words as they were, so no late word arrives while they dissolve.
  const [kept, setKept] = useState<{ settled: string; interim: string } | null>(
    null
  );
  // The field is there while it listens and while it writes it down; a problem shows none.
  const showField = phase === "listening" || phase === "thinking";
  const mode = modeOf(phase, muted, silent, problem, leaving);

  useEffect(() => {
    reading.current = { sample, level, bands };
  }, [sample, level, bands]);

  useVoiceField({ room, canvas, meter }, reading, mode, showField, still);

  const cancel = () => {
    const box = room.current;
    if (box === null || still || reduced()) {
      onCancel();
      return;
    }
    setLeaving(true);
    setKept({ settled, interim });
    window.setTimeout(onCancel, dissolve(box) ? DISSOLVE_MS : 160);
  };

  const before = typed.trim() === "" ? "" : `${typed.trimEnd()} `;
  const bandOpen =
    mode === "listening" ||
    mode === "silent" ||
    mode === "unheard" ||
    mode === "muted";
  const live = phase === "listening" && !muted && !leaving;

  return (
    <div
      data-slot="composer-voice"
      data-phase={phase}
      data-mode={mode}
      {...stylex.props(styles.surface)}
    >
      <div
        ref={room}
        {...stylex.props(styles.room, bandOpen && styles.roomOpen)}
      >
        {showField ? (
          <canvas
            ref={canvas}
            aria-hidden="true"
            data-slot="composer-voice-field"
            {...stylex.props(styles.field)}
          />
        ) : null}
        <p data-slot="composer-voice-words" {...stylex.props(styles.words)}>
          {before === "" ? null : (
            <span {...stylex.props(styles.typed)}>{before}</span>
          )}
          {wordsOf(kept?.settled ?? settled, kept?.interim ?? interim).map(
            (word, index) => (
              <span key={`${index}-${word.text}`}>
                {index === 0 ? "" : " "}
                <Word text={word.text} settled={word.settled} still={still} />
              </span>
            )
          )}
          <span
            ref={caret}
            aria-hidden="true"
            {...stylex.props(styles.caret, !live && styles.caretQuiet)}
          />
        </p>
      </div>
      <VoiceNotes
        meter={meter}
        showField={showField}
        phase={phase}
        problem={problem}
        say={say}
      />
      <VoiceFoot
        phase={phase}
        muted={muted}
        status={statusOf(phase, muted, silent, problem, say)}
        elapsedMs={elapsedMs}
        say={say}
        onCancel={cancel}
        onMute={onMute}
        onDone={onDone}
        onRetry={onRetry}
      />
      <p aria-live="polite" {...stylex.props(styles.unseen)}>
        {saidOf(phase, muted, problem, say)}
      </p>
    </div>
  );
};
