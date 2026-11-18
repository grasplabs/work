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
//
// `variant="conversation"`: a spoken conversation that turns by itself (the product's voice
// interview). There is no Done and no Cancel; the turns pass between `listening` (the person) and
// `speaking` (the other voice, its level given as the person's is, its light a stop quieter, said
// once as "Speaking", and its mark, `speaker`, standing in the time's place so the turn reads
// without colour), and the footer ends with a small close (`onClose`: the voice ends, the host
// gives the text back). The time starts on the words' start edge, as there is no Cancel before it. Left out, the variant is `dictation`: everything above, exactly as before.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { Button } from "../button";
import { Alert, Cross, Icon, Mic, MicOff, Retry, Tick } from "../icons";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useComposerListen } from "./context";
import { useStill } from "./still-context";
import { startVoiceField } from "./voice-field";
import type { VoiceField, VoiceFieldMode } from "./voice-field";
import type { VoiceReading } from "./voice-motion";
import { composerWords, useComposerWords } from "./words";

export type { VoiceReading } from "./voice-motion";

/** What stops the microphone, or what came back wrong. `unheard` is a note while listening goes on. */
export type ComposerVoiceProblem =
  | "blocked"
  | "missing"
  | "unsupported"
  | "unheard"
  | "failed"
  | "limited";

/**
 * Where a dictation is: asking for the microphone, listening, writing it down after Done, or
 * stopped by a problem. In a conversation, `speaking` is the other voice's turn.
 */
export type ComposerVoicePhase =
  | "asking"
  | "listening"
  | "speaking"
  | "thinking"
  | "problem";

/** A dictation the person ends with Done or Cancel, or a conversation that turns by itself. */
export type ComposerVoiceVariant = "dictation" | "conversation";

/** Every word ComposerVoice shows or says; the host translates them. */
export interface ComposerVoiceWords {
  asking: string;
  listening: string;
  /** The other voice's turn, in a conversation: said once as it starts. */
  speaking: string;
  thinking: string;
  silent: string;
  muted: string;
  /** The close that ends a conversation's voice. */
  close: string;
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
  /**
   * `dictation` (the default): the person speaks and ends it with Done or Cancel. `conversation`:
   * the turns pass between `listening` and `speaking` by themselves, with no Done and no Cancel,
   * and a small close at the end (`onClose`).
   */
  variant?: ComposerVoiceVariant;
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
  /**
   * The other voice's mark, in a conversation: shown in the time's place while it speaks, so whose
   * turn it is reads without colour. An AgentMark with `size="xs"` and no name of its own (the
   * turn is said as "Speaking"). Give it with `variant="conversation"`.
   */
  speaker?: ReactNode;
  /** A conversation's close, at the footer's end: the voice ends (the interview goes on typed). A dictation has Cancel instead. */
  onClose?: () => void;
  /** Done, in a dictation. A conversation has no Done. */
  onDone?: () => void;
  /** Cancel, in a dictation: runs once its words have dissolved (at once under reduced motion). A conversation has no Cancel. */
  onCancel?: () => void;
  onMute: () => void;
  onRetry: () => void;
  /**
   * One row, for a one-row composer (its `compact`, which passes it): Cancel, the time, the band and
   * the ways out stand in the row's own height, the words written inside the band, its latest
   * words in view; nothing changes size as dictation starts or ends.
   * @default false
   */
  compact?: boolean;
}

/** The dictation's words in English, as the catalogue (words.ts) holds them. */
export const composerVoiceWords: ComposerVoiceWords = composerWords.voice;

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
    paddingBlockEnd: grasp.space2,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // The words' room: the text alone, as tall as the composer's text it replaces, so the card is no
  // taller while it listens than while it is typed in. The light lies in the footer (band).
  room: { position: "relative", minWidth: 0, paddingBlockEnd: grasp.space3 },
  words: {
    position: "relative",
    zIndex: 1,
    margin: 0,
    fontSize: grasp.chatText,
    lineHeight: grasp.chatTextLine,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  typed: { color: grasp.muted },
  word: {
    color: grasp.ink,
    transitionProperty: "color",
    transitionDuration: simply.mark,
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
  // The band the light lies in: the footer's row between the time and the microphone, on its
  // centre line, as tall as the row's controls, so the footer is as tall listening as at rest. It
  // opens (its padding, read by the field as how open it is) as it starts listening and closes as
  // it writes it down, is cancelled or stops; closing waits a beat, so the light is seen draining.
  band: {
    position: "relative",
    isolation: "isolate",
    flexGrow: 1,
    minWidth: 0,
    // Its height is its padding (and a state's words, when they show): opening it resizes the
    // canvas, so the field reads how open it is as it opens.
    alignSelf: "center",
    display: "flex",
    alignItems: "center",
    paddingBlockEnd: 0,
    transitionProperty: "padding-block-end",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
    transitionDelay: simply.stagger,
  },
  bandOpen: { paddingBlockEnd: grasp.controlSm, transitionDelay: "0s" },
  // A state's words in the band's place (Silence, Muted, A part unheard, Asking), from its start.
  bandWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  bandHidden: { visibility: "hidden" },
  // The field: over the whole band. In forced colours there is no light.
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
  // The ways out, on the composer footer's own inset (space-2 from the card's side, as its footer),
  // each a Button with its own corner, as Add and Send at rest: the card nests round them.
  foot: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    marginInline: `calc(${grasp.space2} - ${grasp.space4})`,
  },
  // A conversation has no Cancel before the time: it starts on the words' start edge instead.
  aligned: { marginInlineStart: `calc(${grasp.space4} - ${grasp.space2})` },
  // The other voice's mark, in the time's place while it speaks.
  speaker: { flexShrink: 0, display: "flex", alignItems: "center" },
  time: {
    flexShrink: 0,
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
    color: grasp.ink,
    whiteSpace: "nowrap",
  },
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
  // ---- One row (compact): the row's own inset, 12px round 32px controls, as the one-row composer ----
  surfaceRow: { gap: 0, padding: grasp.space3, paddingBlockEnd: grasp.space3 },
  footRow: { marginInline: 0 },
  // The words beside the light, after the time: one line from the start, as typed words stand; once
  // they run past their room, its latest words stay in view (scrolled there) and the start fades.
  wordsRow: {
    position: "relative",
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    whiteSpace: "nowrap",
    maskImage: {
      default: "none",
      ":is([data-over])": {
        default: `linear-gradient(to right, transparent, black ${grasp.space8})`,
        ":dir(rtl)": `linear-gradient(to left, transparent, black ${grasp.space8})`,
      },
    },
  },
  wordsRowLine: {
    flexShrink: 0,
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
  },
  // The light in one row: the whole room while nothing is heard yet, then a short band of its own
  // beside the words, so a word never stands on the light.
  bandRow: {
    flexBasis: grasp.composerVoiceRowBand,
    transitionProperty: "padding-block-end, flex-grow",
  },
  bandRowWritten: { flexGrow: 0 },
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
  if (phase === "speaking") {
    return "speaking";
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
  if (phase === "speaking") {
    return say.speaking;
  }
  if (muted) {
    return say.muted;
  }
  return say.listening;
};

/** The modes the band stands open in: a turn of either voice, and listening's quiet states. */
const OPEN_MODES = new Set<VoiceFieldMode>([
  "listening",
  "speaking",
  "silent",
  "unheard",
  "muted",
]);

/** The band the light lies in: the footer row's height, controlSm, 32px. */
const BAND = 32;

/** What the host gives for the sound, kept in a ref for the frame loop. */
interface Reading {
  sample?: () => VoiceReading | undefined;
  level?: number;
  bands?: readonly number[];
}

/** The parts the field is drawn from and tells. */
interface FieldParts {
  band: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  meter: RefObject<HTMLMeterElement | null>;
}

/**
 * The field: started once its canvas is there, run while it is in view and the tab is shown, told
 * the mode, and redrawn as the room is resized (never laid out per
 * frame). The card's dithered edge listens with it. Returns nothing: everything goes through refs.
 */
const useVoiceField = (
  { band, canvas, meter }: FieldParts,
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
    const box = band.current;
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
    // The band, not the canvas: in forced colours the canvas is hidden, and the meter still follows.
    watch.observe(box);
    document.addEventListener("visibilitychange", decide);
    decide();
    return () => {
      watch.disconnect();
      document.removeEventListener("visibilitychange", decide);
      drawing.stop();
      field.current = null;
    };
  }, [band, canvas, meter, reading, on, still]);

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

/**
 * The words in the band's place, from its start, while a state holds that is not plain listening:
 * Paused (silence), Muted, or asking for the microphone. Listening shows the light alone: it is said
 * once, by the live region, and not written. Writing it down shows the light draining. A stretch
 * unheard keeps its note above, and a problem its alert, with no band.
 */
const bandWordsOf = (
  phase: ComposerVoicePhase,
  muted: boolean,
  silent: boolean,
  problem: ComposerVoiceProblem | undefined,
  say: ComposerVoiceWords
) => {
  if (phase === "asking") {
    return say.asking;
  }
  if (phase !== "listening" || problem === "unheard") {
    return "";
  }
  if (muted) {
    return say.muted;
  }
  return silent ? say.silent : "";
};

/** A stretch unheard, and a problem that stopped it. */
const VoiceNotes = ({
  phase,
  problem,
  say,
}: {
  phase: ComposerVoicePhase;
  problem: ComposerVoiceProblem | undefined;
  say: ComposerVoiceWords;
}) => {
  const stopping =
    phase === "problem" && problem !== undefined && problem !== "unheard";
  return (
    <>
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

/** The band: the light (and in forced colours the level as a meter), or a state's words in its place. */
interface BandProps {
  band: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  meter: RefObject<HTMLMeterElement | null>;
  showField: boolean;
  open: boolean;
  words: string;
  say: ComposerVoiceWords;
  /** In one row: short beside the words once there are any. */
  row: boolean;
  written: boolean;
}

const VoiceBand = ({
  band,
  canvas,
  meter,
  showField,
  open,
  words,
  say,
  row,
  written,
}: BandProps) => {
  const meterId = useId();
  const worded = words !== "";
  return (
    <div
      ref={band}
      data-slot="composer-voice-band"
      {...stylex.props(
        styles.band,
        open && !worded && styles.bandOpen,
        row && styles.bandRow,
        row && written && styles.bandRowWritten
      )}
    >
      {showField ? (
        <>
          <canvas
            ref={canvas}
            aria-hidden="true"
            data-slot="composer-voice-field"
            {...stylex.props(styles.field, worded && styles.bandHidden)}
          />
          <label htmlFor={meterId} {...stylex.props(styles.unseen)}>
            {say.level}
          </label>
          <meter
            ref={meter}
            id={meterId}
            min={0}
            max={1}
            value={0}
            {...stylex.props(styles.meter, worded && styles.bandHidden)}
          />
        </>
      ) : null}
      {worded ? (
        <span
          data-slot="composer-voice-state"
          {...stylex.props(styles.bandWords)}
        >
          {words}
        </span>
      ) : null}
    </div>
  );
};

/** What the footer is given. */
interface FootProps {
  conversation: boolean;
  phase: ComposerVoicePhase;
  muted: boolean;
  elapsedMs: number;
  say: ComposerVoiceWords;
  /** The band, between the time and the controls. */
  children: ReactNode;
  /** The other voice's mark, in the time's place while it speaks. */
  speaker: ReactNode;
  onCancel: () => void;
  onMute: () => void;
  onDone: (() => void) | undefined;
  onClose: (() => void) | undefined;
  onRetry: () => void;
  /** One row, for a one-row composer. */
  row: boolean;
}

/**
 * The ways out. A dictation: Cancel, the time, the band, then Mute and Done. A conversation: the
 * time (the other voice's mark while it speaks) on the words' start edge, the band, Mute (on in
 * either turn), then the close. Try again after a problem.
 */
const VoiceFoot = ({
  conversation,
  phase,
  muted,
  elapsedMs,
  say,
  children,
  speaker,
  onCancel,
  onMute,
  onDone,
  onClose,
  onRetry,
  row,
}: FootProps) => {
  const turn = phase === "listening" || (conversation && phase === "speaking");
  const marked =
    conversation &&
    phase === "speaking" &&
    speaker !== undefined &&
    speaker !== null;
  return (
    <div
      data-slot="composer-voice-foot"
      {...stylex.props(styles.foot, row && styles.footRow)}
    >
      {conversation ? null : (
        <Button
          variant="ghost"
          size="sm"
          icon={Cross}
          aria-label={say.cancel}
          onClick={onCancel}
        />
      )}
      {marked ? (
        <span
          data-slot="composer-voice-speaker"
          {...stylex.props(styles.speaker, styles.aligned)}
        >
          {speaker}
        </span>
      ) : (
        <p
          data-slot="composer-voice-time"
          {...stylex.props(styles.time, conversation && styles.aligned)}
        >
          {say.time(elapsedMs)}
        </p>
      )}
      {children}
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
            aria-label={muted ? say.unmute : say.mute}
            onClick={onMute}
            disabled={!turn}
          />
          {conversation ? null : (
            <Button
              variant="ink"
              size="sm"
              icon={Tick}
              aria-label={say.done}
              onClick={onDone}
              disabled={phase !== "listening"}
            />
          )}
        </>
      )}
      {conversation ? (
        <Button
          variant="ghost"
          size="sm"
          icon={Cross}
          aria-label={say.close}
          onClick={onClose}
        />
      ) : null}
    </div>
  );
};

/** The words written: what was typed before, in muted ink, then each word as it resolves, and the caret. */
const VoiceWords = ({
  before,
  words,
  still,
  live,
  row,
}: {
  before: string;
  words: readonly { text: string; settled: boolean }[];
  still: boolean;
  live: boolean;
  row: boolean;
}) => (
  <p
    data-slot="composer-voice-words"
    {...stylex.props(row ? styles.wordsRowLine : styles.words)}
  >
    {before === "" ? null : (
      <span {...stylex.props(styles.typed)}>{before}</span>
    )}
    {words.map((word, index) => (
      <span key={`${index}-${word.text}`}>
        {index === 0 ? "" : " "}
        <Word text={word.text} settled={word.settled} still={still} />
      </span>
    ))}
    <span
      aria-hidden="true"
      {...stylex.props(styles.caret, !live && styles.caretQuiet)}
    />
  </p>
);

/** In one row, the latest words stay in view, and the start fades once they run past their room. */
const useRowInView = (room: RefObject<HTMLDivElement | null>, row: boolean) => {
  // After every render: the words may have grown.
  useEffect(() => {
    const box = room.current;
    if (!row || box === null) {
      return;
    }
    box.toggleAttribute("data-over", box.scrollWidth > box.clientWidth + 1);
    box.scrollTo({
      left:
        getComputedStyle(box).direction === "rtl"
          ? -box.scrollWidth
          : box.scrollWidth,
    });
  });
};

/** What the band says in its place: in one row, a stretch unheard or a problem too, so the row keeps its height. */
const bandSays = (
  row: boolean,
  phase: ComposerVoicePhase,
  muted: boolean,
  silent: boolean,
  problem: ComposerVoiceProblem | undefined,
  say: ComposerVoiceWords
) =>
  row && problem !== undefined
    ? say.problems[problem]
    : bandWordsOf(phase, muted, silent, problem, say);

/** The words to show: as they were when cancelled, else as the host gives them. */
const heardOf = (
  kept: { settled: string; interim: string } | null,
  settled: string,
  interim: string
) => wordsOf(kept?.settled ?? settled, kept?.interim ?? interim);

/** Dictation in a composer's place: the words arriving out of the light, the time, and the ways out. */
export const ComposerVoice = ({
  variant = "dictation",
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
  speaker,
  onDone,
  onCancel,
  onClose,
  onMute,
  onRetry,
  compact = false,
}: ComposerVoiceProps) => {
  const conversation = variant === "conversation";
  // Its words: the caller's where given, else the product's catalogue (GraspWords), else English.
  const catalogue = useComposerWords("voice");
  const say = {
    ...catalogue,
    ...words,
    problems: {
      ...composerWords.voice.problems,
      ...catalogue.problems,
      ...words?.problems,
    },
  };
  const still = useStill();
  const room = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const meter = useRef<HTMLMeterElement>(null);
  // The latest of what the host gives, for the frame loop to read: kept in a ref by an effect.
  const reading = useRef<Reading>({});
  const [leaving, setLeaving] = useState(false);
  // Cancelled: the words as they were, so no late word arrives while they dissolve.
  const [kept, setKept] = useState<{ settled: string; interim: string } | null>(
    null
  );
  // The field is there while it listens and while it writes it down; a problem shows none.
  const showField =
    phase === "listening" || phase === "speaking" || phase === "thinking";
  const mode = modeOf(phase, muted, silent, problem, leaving);

  useEffect(() => {
    reading.current = { sample, level, bands };
  }, [sample, level, bands]);

  useVoiceField({ band, canvas, meter }, reading, mode, showField, still);

  useRowInView(room, compact);

  const cancel = () => {
    const box = room.current;
    if (box === null || still || reduced()) {
      onCancel?.();
      return;
    }
    setLeaving(true);
    setKept({ settled, interim });
    window.setTimeout(
      () => {
        onCancel?.();
      },
      dissolve(box) ? DISSOLVE_MS : 160
    );
  };

  const before = typed.trim() === "" ? "" : `${typed.trimEnd()} `;
  const bandOpen = OPEN_MODES.has(mode);
  const live = phase === "listening" && !muted && !leaving;

  const heard = heardOf(kept, settled, interim);
  const written = (
    <VoiceWords
      before={before}
      words={heard}
      still={still}
      live={live}
      row={compact}
    />
  );

  return (
    <div
      data-slot="composer-voice"
      data-variant={variant}
      data-phase={phase}
      data-mode={mode}
      data-compact={compact ? "" : undefined}
      {...stylex.props(styles.surface, compact && styles.surfaceRow)}
    >
      {compact ? null : (
        <div ref={room} {...stylex.props(styles.room)}>
          {written}
        </div>
      )}
      {compact ? null : (
        <VoiceNotes phase={phase} problem={problem} say={say} />
      )}
      <VoiceFoot
        conversation={conversation}
        phase={phase}
        muted={muted}
        elapsedMs={elapsedMs}
        say={say}
        speaker={speaker}
        row={compact}
        onCancel={cancel}
        onMute={onMute}
        onDone={onDone}
        onClose={onClose}
        onRetry={onRetry}
      >
        {compact ? (
          <div ref={room} {...stylex.props(styles.wordsRow)}>
            {written}
          </div>
        ) : null}
        <VoiceBand
          band={band}
          canvas={canvas}
          meter={meter}
          showField={showField}
          open={bandOpen}
          words={bandSays(compact, phase, muted, silent, problem, say)}
          say={say}
          row={compact}
          written={before !== "" || heard.length > 0}
        />
      </VoiceFoot>
      <p aria-live="polite" {...stylex.props(styles.unseen)}>
        {saidOf(phase, muted, problem, say)}
      </p>
    </div>
  );
};
