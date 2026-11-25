// VoiceComposer: one card to answer in, typed or spoken, in StyleX.
//
//   <VoiceComposer
//     labels={{ text: "Message", listening: "Listening…", hint: "Tap and speak",
//               talk: "Dictate", stop: "Stop listening", send: "Send" }}
//     placeholder="Type a message"
//     onSubmit={send}
//     voice={listening ? "listening" : "off"}
//     onVoiceChange={setListening}
//     heard={wordsSoFar}
//     sample={() => ({ level: micLevel() })}
//   />
//
// At rest it is a place to type: the words top left, one round button bottom right. The button is
// a microphone while the box is empty and Send once something is typed; Enter sends, Shift+Enter
// starts a line. Pressed as a microphone it turns into Stop, the time runs top right behind a dot
// that swells with the voice, and a grid of dots rises along the card's foot with the sound
// (voice-composer-dots.ts, fetched as a voice first starts). Each word that is heard is carried
// up from the dots to its place in the text, stands there a moment as a word made of dots, and
// comes through a blur into letters. The card grows by the line, never in a jump.
//
// The product listens and writes: it says whether a voice runs (`voice`), hands the words so far
// (`heard`) and the sound (`sample`). While another voice speaks (`voice="speaking"`) the dots
// follow that voice and its mark (`speaker`) stands where the time was.
//
// With reduced motion no dot flies, words fade in place and the card takes its height at once. A
// screen reader is told once that listening started; the moving words are not read out word by
// word.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { ArrowUpIcon, Icon, MicIcon } from "../lib/icons";
import { fadeIn } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { announce } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import type { VoiceReading } from "./prompt-input-voice-motion";
import type { VoiceDots, VoiceDotsMode } from "./voice-composer-dots";

/** The words a VoiceComposer says, in the caller's language. */
export interface VoiceComposerLabels {
  /** The text box's name ("Your answer"). */
  text: string;
  /** In the words' place while it listens and nothing is heard yet ("Listening…"). */
  listening: string;
  /** In the words' place while the other voice speaks and nothing stands there. */
  speaking?: string;
  /** In the placeholder's place while the pointer is on the microphone ("Tap and speak"). */
  hint?: string;
  /** The button as a microphone ("Talk"). */
  talk: string;
  /** The button while a voice runs ("Stop listening"). */
  stop: string;
  /** The button once something is typed ("Send"). */
  send: string;
}

/** Every prop a VoiceComposer takes. */
export interface VoiceComposerProps {
  labels: VoiceComposerLabels;
  /** In the empty text box. */
  placeholder: string;
  /** Runs as Send is pressed, or Enter, with the text, trimmed and not empty; the box is then empty. */
  onSubmit?: (text: string) => void;
  /** Runs as the typed text changes. */
  onValueChange?: (text: string) => void;
  /** The most characters the text takes. */
  maxLength?: number;
  /**
   * The text box takes focus as it comes.
   * @default false
   */
  autoFocus?: boolean;
  /**
   * Whether a voice runs: the person's (`listening`), another's (`speaking`), or none.
   * @default "off"
   */
  voice?: "off" | "listening" | "speaking";
  /**
   * Runs as the button is pressed as a microphone (true) or as Stop (false), and on Escape while a
   * voice runs. Without it there is no microphone.
   */
  onVoiceChange?: (on: boolean) => void;
  /** The words of this turn so far: each new one is carried up from the dots. */
  heard?: string;
  /** In the heard words' place, when the product has more to show in them than plain words. */
  children?: ReactNode;
  /** The sound now, read at each frame with no render: its `level` from 0 to 1. */
  sample?: () => VoiceReading | undefined;
  /** The other voice's mark, in the time's place while it speaks. */
  speaker?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;

/** How loud the voice is drawn, 0 to 1: the dots set it at each frame, the time's dot swells with it. */
const LEVEL = "--voice-composer-level";
/** How long a dot flies (voice-composer-dots.ts FLIGHT_MS, which is not loaded with this). */
const FLIGHT_MS = 460;
/** How far apart words that come together leave, in ms. */
const APART_MS = 90;
/** How long a word takes through the blur, in ms. */
const RESOLVE_MS = 640;

const styles = stylex.create({
  root: {
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    fontFamily: font.sans,
  },
  // The card. No ring while the text has focus: the caret says where the words go.
  card: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "block",
    boxSizing: "border-box",
    margin: 0,
    paddingBlockStart: space["4"],
    // The dots' room, and the button's.
    paddingBlockEnd: "3.25rem",
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.promptInputRadius,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
    color: colors.foreground,
    cursor: "text",
  },
  // The dots lie over the whole card, under its words and its button, and take no press.
  dots: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    borderRadius: "inherit",
    cornerShape: radius.shape,
    color: { default: colors.foreground, [FORCED]: "CanvasText" },
    pointerEvents: "none",
  },
  // The text's room: it takes the height of what stands in it, a line at a time and never in a jump.
  grow: {
    position: "relative",
    overflow: "hidden",
    minHeight: `calc(2 * ${font.textBaseLine})`,
    transitionProperty: { default: "height", [REDUCED]: "none" },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  grown: (height: number) => ({ height }),
  // At most five lines stand; more scroll, the newest in view.
  lines: {
    boxSizing: "border-box",
    maxHeight: `calc(5 * ${font.textBaseLine})`,
    overflowY: "auto",
    scrollbarWidth: "none",
    paddingInlineStart: space["5"],
    // Clear of the time and of the button.
    paddingInlineEnd: "5rem",
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
  },
  // The text box and its measure in one cell: the measure gives the height, the box fills it.
  typing: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  measure: {
    gridArea: "1 / 1",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  text: {
    gridArea: "1 / 1",
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    overflow: "hidden",
    overflowWrap: "anywhere",
    outline: "none",
    resize: "none",
    "::placeholder": { color: colors.mutedForeground, opacity: 1 },
  },
  words: {
    margin: 0,
    overflowWrap: "anywhere",
    cursor: "default",
  },
  // A word keeps to itself as it comes through the blur, so its neighbours never move.
  word: { display: "inline-block" },
  quiet: { color: colors.mutedForeground },
  // Top right: the time behind its dot, or the other voice's mark.
  lead: {
    position: "absolute",
    top: space["4"],
    insetInlineEnd: space["5"],
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    height: font.textBaseLine,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    fontVariantNumeric: "tabular-nums",
    pointerEvents: "none",
  },
  beat: {
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: radius.circle,
    backgroundColor: { default: colors.foreground, [FORCED]: "CanvasText" },
    transform: {
      default: `scale(calc(0.75 + 0.6 * var(${LEVEL}, 0)))`,
      [REDUCED]: "none",
    },
  },
  // The one button, bottom right.
  button: {
    position: "absolute",
    insetInlineEnd: space["3"],
    bottom: space["3"],
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    width: "2.5rem",
    height: "2.5rem",
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: radius.circle,
    backgroundColor: {
      default: colors.secondary,
      ":hover": colors.secondaryHover,
      ":active": colors.secondaryActive,
    },
    color: colors.foreground,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `${size.lineStrong} solid ${colors.ring}`,
    },
    outlineOffset: "2px",
    transitionProperty: "background-color, color, transform",
    transitionDuration: { default: duration.ui, [REDUCED]: "0s" },
    transitionTimingFunction: duration.ease,
    transform: { default: "none", ":active": "scale(0.96)" },
    WebkitTapHighlightColor: "transparent",
  },
  send: {
    backgroundColor: {
      default: colors.primary,
      ":hover": colors.primaryHover,
      ":active": colors.primaryActive,
    },
    color: colors.primaryForeground,
  },
  // The button's three faces lie on one another; the one that counts shows.
  face: {
    gridArea: "1 / 1",
    display: "grid",
    placeItems: "center",
    opacity: 0,
    transform: "scale(0.6)",
    transitionProperty: "opacity, transform",
    transitionDuration: { default: duration.ui, [REDUCED]: "0s" },
    transitionTimingFunction: duration.ease,
  },
  faceShown: { opacity: 1, transform: "none" },
  square: {
    width: "0.6875rem",
    height: "0.6875rem",
    borderRadius: "0.1875rem",
    backgroundColor: "currentColor",
  },
});

/** The time a voice has run, as 0:07. */
const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The time since it came, behind the dot that swells with the voice. */
const Time = () => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((now) => now + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      <span {...stylex.props(styles.beat)} />
      <span role="timer">{clock(seconds)}</span>
    </>
  );
};

/** The words in a text, in order. */
const wordsIn = (text: string): string[] =>
  text.split(/\s+/u).filter((word) => word !== "");

/** A place in `within`, in its own pixels. */
const placeIn = (element: Element, within: Element) => {
  const box = element.getBoundingClientRect();
  const frame = within.getBoundingClientRect();
  return {
    x: box.left - frame.left,
    y: box.top - frame.top,
    width: box.width,
    height: box.height,
  };
};

/** A word's way in: through the blur, or with reduced motion only out of nothing. */
const resolve = (word: HTMLElement, delay: number, still: boolean) => {
  word.animate(
    still
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, filter: "blur(6px)" },
          { opacity: 0.55, filter: "blur(5px)", offset: 0.3 },
          { opacity: 1, filter: "blur(0)" },
        ],
    {
      duration: still ? 200 : RESOLVE_MS,
      delay,
      easing: "cubic-bezier(0.3, 0, 0.2, 1)",
      fill: "backwards",
    }
  );
};

/** What draws the dots, once fetched, and what it was last told. */
interface Drawing {
  dots: VoiceDots | null;
  mode: VoiceDotsMode;
  sample: (() => VoiceReading | undefined) | undefined;
  gone: boolean;
}

const nothing = () => {
  // Nothing to undo.
};

/** The newest line in view: the lines' room, which holds the words, scrolled to its foot. */
const showNewest = (room: HTMLElement) => {
  const lines = room.parentElement;
  if (lines !== null) {
    lines.scrollTop = lines.scrollHeight;
  }
};

/** The dots' code, fetched as a voice first runs (outside any component: the compiler takes no import there). */
const fetchDots = async () => await import("./voice-composer-dots");

/** Starts the dots on `surface` once their code is here, unless they are no longer wanted. */
const startDots = async (
  held: Drawing,
  surface: HTMLCanvasElement,
  card: HTMLElement | null,
  wanted: () => boolean
) => {
  const { startVoiceDots } = await fetchDots();
  if (!wanted() || held.gone || held.dots !== null) {
    return;
  }
  held.dots = startVoiceDots(surface, {
    sample: () => held.sample?.(),
    still: matchMedia("(prefers-reduced-motion: reduce)").matches,
    onLevel: (level) => {
      card?.style.setProperty(LEVEL, level.toFixed(3));
    },
  });
  held.dots.mode(held.mode);
};

/** Words `from` to `count` in `room` arrive: their dots leave, and each comes through the blur as they land. */
const arrive = (
  room: HTMLElement,
  surface: HTMLCanvasElement,
  dots: VoiceDots | null,
  from: number,
  count: number
) => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const arrived = room.querySelectorAll<HTMLElement>("[data-word]");
  for (let index = from; index < count; index += 1) {
    const word = arrived[index];
    if (word !== undefined) {
      const leaves = (index - from) * APART_MS;
      dots?.fly(placeIn(word, surface), leaves);
      resolve(
        word,
        leaves + (dots === null || still ? 0 : FLIGHT_MS * 0.8),
        still
      );
    }
  }
  showNewest(room);
};

/** The height of what stands in `inner`, kept as it changes; none before the first look. */
const useHeight = () => {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = inner.current;
    if (element === null) {
      return nothing;
    }
    const watcher = new ResizeObserver(() => {
      setHeight(element.offsetHeight);
    });
    watcher.observe(element);
    return () => {
      watcher.disconnect();
    };
  }, []);
  return { inner, height };
};

/**
 * The dots on the card's canvas: fetched as a voice first runs, told how the voice stands, and
 * given each new word of `said` to carry up. Gives the refs of the card, the canvas and the words.
 */
const useDots = (
  voice: "off" | "listening" | "speaking",
  sample: (() => VoiceReading | undefined) | undefined,
  count: number
) => {
  const card = useRef<HTMLFormElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const drawing = useRef<Drawing>({
    dots: null,
    mode: "rest",
    sample: undefined,
    gone: false,
  });
  // The words that stood there as it came: they never fly.
  const seen = useRef(count);
  useEffect(() => {
    drawing.current.sample = sample;
  }, [sample]);
  useEffect(() => {
    const held = drawing.current;
    held.mode = voice === "off" ? "rest" : voice;
    held.dots?.mode(held.mode);
    const surface = canvas.current;
    if (voice === "off" || held.dots !== null || surface === null) {
      return nothing;
    }
    let asked = true;
    void startDots(held, surface, card.current, () => asked);
    return () => {
      asked = false;
    };
  }, [voice]);
  useEffect(() => {
    const held = drawing.current;
    held.gone = false;
    return () => {
      held.gone = true;
      held.dots?.stop();
      held.dots = null;
    };
  }, []);
  useLayoutEffect(() => {
    const room = said.current;
    const surface = canvas.current;
    const from = Math.min(seen.current, count);
    seen.current = count;
    if (room !== null && surface !== null && from < count) {
      arrive(room, surface, drawing.current.dots, from, count);
    }
  }, [count]);
  return { card, canvas, said };
};

/**
 * The card's own keys and presses, listened for on the form itself: Escape ends a voice, and a
 * press on the card's ground puts the caret in the text.
 */
const useCard = (
  card: { current: HTMLFormElement | null },
  box: { current: HTMLTextAreaElement | null },
  running: boolean,
  onVoiceChange: ((on: boolean) => void) | undefined
) => {
  useEffect(() => {
    const form = card.current;
    if (form === null) {
      return nothing;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && running) {
        onVoiceChange?.(false);
      }
    };
    const onPress = (event: PointerEvent) => {
      if (event.target === form && !running) {
        event.preventDefault();
        box.current?.focus();
      }
    };
    form.addEventListener("keydown", onKey);
    form.addEventListener("pointerdown", onPress);
    return () => {
      form.removeEventListener("keydown", onKey);
      form.removeEventListener("pointerdown", onPress);
    };
  }, [card, box, running, onVoiceChange]);
};

type Face = "talk" | "stop" | "send";

/** The one button: a microphone, Stop while a voice runs, Send once something is typed. */
const RoundButton = ({
  face,
  labels,
  onPress,
  onHint,
}: {
  face: Face;
  labels: VoiceComposerLabels;
  onPress: () => void;
  /** The pointer, or focus, is on the microphone, or left it. */
  onHint: (on: boolean) => void;
}) => (
  <button
    aria-label={labels[face]}
    onBlur={() => {
      onHint(false);
    }}
    onClick={onPress}
    onFocus={() => {
      onHint(face === "talk");
    }}
    onPointerEnter={() => {
      onHint(face === "talk");
    }}
    onPointerLeave={() => {
      onHint(false);
    }}
    type="button"
    {...stylex.props(styles.button, face === "send" && styles.send)}
  >
    <span {...stylex.props(styles.face, face === "talk" && styles.faceShown)}>
      <Icon icon={MicIcon} />
    </span>
    <span {...stylex.props(styles.face, face === "stop" && styles.faceShown)}>
      <span {...stylex.props(styles.square)} />
    </span>
    <span {...stylex.props(styles.face, face === "send" && styles.faceShown)}>
      <Icon icon={ArrowUpIcon} />
    </span>
  </button>
);

/** The words of the turn, each in its own box so it can come through the blur alone. */
const Heard = ({
  words,
  waiting,
  children,
  ref,
}: {
  words: string[];
  /** In their place while there are none. */
  waiting: string;
  children: ReactNode;
  ref: Ref<HTMLParagraphElement>;
}) => {
  const own = children !== undefined && children !== null;
  return (
    <p ref={ref} {...stylex.props(styles.words)}>
      {words.length === 0 && !own ? (
        <span key={waiting} {...stylex.props(styles.quiet, fadeIn)}>
          {waiting}
        </span>
      ) : null}
      {own
        ? children
        : words.map((word, index) => (
            // A word is its place in the turn: one heard again differently stays where it is.
            <span key={index}>
              <span data-word="" {...stylex.props(styles.word)}>
                {word}
              </span>{" "}
            </span>
          ))}
    </p>
  );
};

/** Which face the button shows. */
const faceOf = (running: boolean, typed: boolean, canTalk: boolean): Face => {
  if (running) {
    return "stop";
  }
  return typed || !canTalk ? "send" : "talk";
};

export const VoiceComposer = ({
  labels,
  placeholder,
  onSubmit,
  onValueChange,
  maxLength,
  autoFocus = false,
  voice = "off",
  onVoiceChange,
  heard = "",
  children,
  sample,
  speaker,
  style,
}: VoiceComposerProps) => {
  const [value, setValue] = useState("");
  const [hinting, setHinting] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const { inner, height } = useHeight();
  const running = voice !== "off";
  const listening = voice === "listening";
  const words = wordsIn(heard);
  const own = children !== undefined && children !== null;
  const { card, canvas, said } = useDots(voice, sample, own ? 0 : words.length);
  useCard(card, box, running, onVoiceChange);
  const typed = value.trim() !== "";
  const face = faceOf(running, typed, onVoiceChange !== undefined);

  // Said once as listening starts.
  const { listening: listeningWords } = labels;
  useEffect(() => {
    if (listening) {
      announce(listeningWords);
    }
  }, [listening, listeningWords]);

  const send = () => {
    const text = value.trim();
    if (text !== "" && onSubmit !== undefined) {
      onSubmit(text);
      setValue("");
      onValueChange?.("");
    }
  };
  const press = () => {
    if (face === "send") {
      send();
    } else {
      onVoiceChange?.(face === "talk");
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An input method's Enter chooses a word; it never sends.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  };
  const hint = hinting && !typed ? labels.hint : undefined;
  return (
    <div data-slot="voice-composer" {...stylex.props(styles.root, style)}>
      <form
        ref={card}
        data-voice={voice}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        {...stylex.props(styles.card)}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          {...stylex.props(styles.dots)}
        />
        <div
          {...stylex.props(
            styles.grow,
            height !== null && styles.grown(height)
          )}
        >
          <div ref={inner} {...stylex.props(styles.lines)}>
            {running ? (
              <Heard
                ref={said}
                waiting={listening ? labels.listening : (labels.speaking ?? "")}
                words={words}
              >
                {children}
              </Heard>
            ) : (
              <div {...stylex.props(styles.typing)}>
                <div aria-hidden="true" {...stylex.props(styles.measure)}>
                  {`${value}​`}
                </div>
                <textarea
                  ref={box}
                  aria-label={labels.text}
                  autoFocus={autoFocus}
                  enterKeyHint="send"
                  maxLength={maxLength}
                  onChange={(event) => {
                    setValue(event.target.value);
                    onValueChange?.(event.target.value);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={hint ?? placeholder}
                  rows={1}
                  value={value}
                  {...stylex.props(styles.text)}
                />
              </div>
            )}
          </div>
        </div>
        {running ? (
          <div {...stylex.props(styles.lead, fadeIn)}>
            {listening ? <Time /> : speaker}
          </div>
        ) : null}
        <RoundButton
          face={face}
          labels={labels}
          onHint={setHinting}
          onPress={press}
        />
      </form>
    </div>
  );
};
