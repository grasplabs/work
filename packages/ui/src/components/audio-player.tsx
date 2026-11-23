// AudioPlayer: one bar that plays a sound file: play, back and forward ten seconds, the time and
// the timeline, the playback rate, and the sound. The bar answers to its own width, not the page's:
// narrow, the skips go first, then the times, so the timeline keeps its room.
//
//   <AudioPlayer src="/media/call.mp3" aria-label="Call with the design team" />
//
// The timeline is UI SDK's Slider and every button a ghost Button, so an agent can play, pause and
// seek by name. Keys while focus is in the bar: Space or K plays and pauses, the arrows go back and
// on five seconds, M turns the sound off and on. One sound at a time: when another player on the
// page starts, this one pauses.
//
// A page plays a moment of the file with `startTime` and `endTime`, hears where the sound is with
// `onTimeUpdate`, and seeks, plays and pauses it from outside through `ref`:
//
//   const player = useRef<AudioPlayerHandle>(null);
//   <AudioPlayer src="/media/call.mp3" aria-label="Call" startTime={50} endTime={62} ref={player} />
//   player.current?.seek(120);
//
// A part that stands where the timeline would (a strip of who spoke when) comes in as `timeline`.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Slider as SliderPrimitive,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
} from "@ui-sdk/react/slider";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { useI18n } from "../lib/i18n";
import {
  GoBackward10Icon,
  GoForward10Icon,
  Icon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
  VolumeIcon,
  VolumeOffIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import { visuallyHidden } from "../lib/styles";
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
import { durations } from "../lib/tokens.values";
import { safeMediaSrc } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { timelineMarker } from "./audio-player.stylex";
import { Button } from "./button";
import { Spinner } from "./spinner";

/** What a page can do to the player from outside it, through its `ref`. */
export interface AudioPlayerHandle {
  /** Sends the sound to a place, in seconds. */
  seek: (seconds: number) => void;
  /** Plays, from `startTime` the first time. Resolves once it plays, or once the browser refuses. */
  play: () => Promise<void>;
  /** Pauses. */
  pause: () => void;
}

/** Every prop an AudioPlayer takes. */
export interface AudioPlayerProps {
  /**
   * The sound file's address. It plays when it is written into the address (`data:audio/…`), made
   * by the page (`blob:`) or a path on this site; an `http(s)` address only with `allowRemote`.
   * Any other plays nothing, and the bar says it cannot play.
   */
  src: string;
  /**
   * Plays an `http(s)` `src` too. Turn it on only for a source you trust: an address that a model
   * or another person wrote tells its site who played it, and when.
   * @default false
   */
  allowRemote?: boolean;
  /**
   * The address of a captions file (WebVTT) for what is said in it. The player draws no captions
   * itself; the track carries them with the sound, for the browser and for a page that reads them.
   */
  captions?: string;
  /**
   * The sound's length in seconds, when the page knows it. Then nothing of the file is fetched
   * until it is played: the length shows from this. Without it, the browser fetches the file's
   * start to read its length (and, for a short file, all of it).
   */
  duration?: number;
  /** What is playing, for a screen reader and an agent ("Call with the design team"). Not shown. */
  "aria-label"?: string;
  /**
   * The rates the rate button steps through; the first is the start.
   * @default [1, 1.25, 1.5, 2]
   */
  playbackRates?: number[];
  /** The words when the file cannot be played, shown in place of the controls ("This recording has moved"). */
  errorText?: string;
  /**
   * Where a play starts, in seconds: the first play, and the first after a new `src` or a new
   * `startTime`, and a play after it stopped at `endTime`. A seek before the first play wins.
   * @default 0
   */
  startTime?: number;
  /** Where it stops, in seconds: playing that reaches it pauses there. A seek past it plays on. */
  endTime?: number;
  /** Runs with the sound's place, in seconds, as it changes: while it plays, and on a seek. */
  onTimeUpdate?: (seconds: number) => void;
  /** A ref the player fills with what a page can do to it: `seek`, `play` and `pause`. */
  ref?: Ref<AudioPlayerHandle>;
  /**
   * `ghost` draws no box of its own: no fill, no edge, no shadow, no padding round its controls,
   * and as wide as where it stands; for a player that is the foot of something else's box.
   * @default "default"
   */
  variant?: "default" | "ghost";
  /**
   * The two times beside the timeline, where the sound is and how long it is. Turn them off when
   * something round the player already writes them: the timeline still says both to a screen reader.
   * @default true
   */
  showTime?: boolean;
  /**
   * Something that stands where the bar's own timeline would, and is how the sound is moved (a strip
   * of who spoke when). The bar then draws no timeline, no times and no skips of its own, and is as
   * wide as where it stands; play stays at its start, rate and sound at its end. Narrow (under 30rem
   * of its own width) it takes a line of its own under them.
   */
  timeline?: ReactNode;
  /** Layout only: margins, alignment and width. The look belongs to the bar. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;
const SKIPS_GO = "@container (width < 32rem)";
const TIMES_GO = "@container (width < 22rem)";
const TIMELINE_WRAPS = "@container (width < 30rem)";

const styles = stylex.create({
  bar: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    containerType: "inline-size",
    boxSizing: "border-box",
    // Its own width, not its content's: the container query below needs size containment, and a
    // contained box has no width of its own to give a parent that sizes to its content.
    width: size.audioWidth,
    maxWidth: "100%",
    minWidth: 0,
    margin: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: `min(${radius.xl}, calc((${size.controlSm} + 2 * ${space["1"]}) / 2))`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
    color: colors.foreground,
    fontFamily: font.sans,
  },
  // Ghost: the box belongs to what it stands in.
  ghost: {
    width: "100%",
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  rowGhost: {
    padding: 0,
  },
  // With a timeline of its own: as wide as its place; the buttons stand level with its first line.
  barTimeline: {
    width: "100%",
  },
  rowTimeline: {
    alignItems: "flex-start",
    flexWrap: { default: "nowrap", [TIMELINE_WRAPS]: "wrap" },
    rowGap: space["1"],
    paddingInline: space["2"],
    paddingBlock: space["2"],
  },
  ownTimeline: {
    flexGrow: 1,
    flexBasis: { default: "0%", [TIMELINE_WRAPS]: "100%" },
    order: { default: 0, [TIMELINE_WRAPS]: 1 },
    minWidth: 0,
    paddingInline: { default: space["2"], [TIMELINE_WRAPS]: space["1"] },
  },
  // With a timeline of its own the rate keeps one width whatever it reads ("1×", "1.25×") and
  // whenever the font arrives, so the timeline beside it never shifts.
  rateSlot: {
    display: "flex",
    justifyContent: "center",
    flexShrink: 0,
    inlineSize: `calc(1.75 * ${size.controlSm})`,
  },
  // Narrow, with a timeline of its own: rate and sound go to the end of the first line.
  spacer: {
    display: { default: "none", [TIMELINE_WRAPS]: "block" },
    flexGrow: 1,
  },
  row: {
    display: "flex",
    alignItems: "center",
    // On a touch screen the buttons stand a finger apart: each keeps its drawn size, with 44px to
    // press that meets its neighbour's.
    gap: {
      default: space["1"],
      [COARSE]: `calc(${size.tapTarget} - ${size.controlSm})`,
    },
    minWidth: 0,
    padding: space["1"],
  },
  skip: {
    display: { default: "contents", [SKIPS_GO]: "none" },
  },
  middle: {
    display: "flex",
    alignItems: "center",
    flexGrow: 1,
    gap: space["3"],
    minWidth: 0,
    paddingInline: space["2"],
  },
  time: {
    display: { default: "block", [TIMES_GO]: "none" },
    flexShrink: 0,
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  slider: {
    flexGrow: 1,
    // Never narrower than a finger, however narrow the bar.
    minWidth: size.tapTarget,
  },
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    // A finger needs 44px: on a touch screen the press area grows past the bar, which keeps its height.
    height: { default: size.controlSm, [COARSE]: size.tapTarget },
    marginBlock: {
      default: 0,
      [COARSE]: `calc((${size.controlSm} - ${size.tapTarget}) / 2)`,
    },
    paddingInline: `calc(${size.sliderThumb} / 2)`,
    touchAction: "none",
    cursor: "pointer",
  },
  track: {
    position: "relative",
    flexGrow: 1,
    height: size.sliderTrack,
    borderRadius: radius.full,
    backgroundColor: { default: colors.progressTrack, [FORCED]: "GrayText" },
  },
  indicator: {
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: { default: colors.progressBg, [FORCED]: "Highlight" },
  },
  thumb: {
    width: size.sliderThumb,
    height: size.sliderThumb,
    boxSizing: "border-box",
    borderRadius: radius.circle,
    backgroundColor: {
      default: colors.primaryForegroundOnColor,
      [FORCED]: "Canvas",
    },
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    boxShadow: shadow.sm,
    // The focus is on the range input inside it: the ring is drawn here when focus is within. A
    // thumb is a small mark: the ring stands off it, so it is not lost on the thumb's own edge.
    outline: {
      default: "none",
      ":has(:focus-visible)": `${size.ringWidth} solid ${colors.ring}`,
    },
    outlineOffset: size.ringOffsetMark,
    // The thumb shows only under a pointer or with focus, so the bar reads as a line at rest.
    opacity: {
      default: 0,
      ":has(:focus-visible)": 1,
      [stylex.when.ancestor(":hover", timelineMarker)]: {
        default: null,
        [HOVER]: 1,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  // The bar's own height (its row: a control and space-1 round it), so failing never shrinks it.
  // As tall as the bar, its line in the middle; on a narrow bar the words wrap and the mark stays
  // on their first line.
  error: {
    display: "flex",
    alignItems: "flex-start",
    gap: space["2"],
    boxSizing: "border-box",
    minHeight: `calc(${size.controlSm} + 2 * ${space["1"]})`,
    margin: 0,
    paddingBlock: `calc((${size.controlSm} + 2 * ${space["1"]} - ${font.textSmLine}) / 2)`,
    paddingInline: space["3"],
    color: colors.destructive,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  errorMark: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    height: font.textSmLine,
  },
});

/** The rates the rate button steps through when none are given. */
const PLAYBACK_RATES = [1, 1.25, 1.5, 2];

/** "1:05", or "1:02:05" past an hour. */
const clock = (seconds: number) => {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};

/** Plays the file. A play cut short by a pause (AbortError) or not allowed yet is not a broken file. */
const play = async (element: HTMLAudioElement, onError: () => void) => {
  try {
    await element.play();
  } catch (error: unknown) {
    if (
      element.error !== null ||
      (error instanceof DOMException && error.name === "NotSupportedError")
    ) {
      onError();
    }
  }
};

interface IconPressProps {
  icon: IconData;
  /** Its name ("Play"). */
  label: string;
  onPress: () => void;
  /** Waiting for the file: a spinner in its place, at the same size, named by these words. */
  waiting?: string;
}

/** A ghost icon button of the bar, which an agent finds by its name. */
const IconPress = ({ icon, label, onPress, waiting }: IconPressProps) => {
  const busy = waiting !== undefined;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={busy ? waiting : label}
      aria-busy={busy || undefined}
      disabled={busy}
      focusableWhenDisabled
      onClick={onPress}
    >
      {busy ? <Spinner /> : <Icon icon={icon} />}
    </Button>
  );
};

/** Waiting for data for more than twice a ui beat while playing: the play button says it is loading. */
const useBuffering = () => {
  const [buffering, setBuffering] = useState(false);
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitStart = () => {
    if (wait.current !== null) {
      clearTimeout(wait.current);
    }
    wait.current = setTimeout(() => {
      setBuffering(true);
    }, durations.ui * 2);
  };
  const waitEnd = () => {
    if (wait.current !== null) {
      clearTimeout(wait.current);
    }
    setBuffering(false);
  };
  useEffect(
    () => () => {
      if (wait.current !== null) {
        clearTimeout(wait.current);
      }
    },
    []
  );
  return { buffering, waitStart, waitEnd };
};

interface MiddleProps {
  time: number;
  duration: number;
  showTime: boolean;
  onSeek: (to: number) => void;
}

/** The bar's own middle: the skips, the times and the timeline. */
const Middle = ({ time, duration: length, showTime, onSeek }: MiddleProps) => {
  const words = useI18n().audioPlayer;
  return (
    <>
      <div {...stylex.props(styles.skip)}>
        <IconPress
          icon={GoBackward10Icon}
          label={words.back}
          onPress={() => {
            onSeek(time - 10);
          }}
        />
        <IconPress
          icon={GoForward10Icon}
          label={words.forward}
          onPress={() => {
            onSeek(time + 10);
          }}
        />
      </div>
      <div {...stylex.props(styles.middle)}>
        {showTime && (
          <span
            aria-hidden="true"
            dir="ltr"
            data-slot="audio-player-time"
            {...stylex.props(styles.time)}
          >
            {clock(time)}
          </span>
        )}
        <SliderPrimitive
          value={Math.min(time, length || 0)}
          min={0}
          max={length > 0 ? length : 1}
          step={1}
          onValueChange={(value: number | number[]) => {
            onSeek(Array.isArray(value) ? (value[0] ?? 0) : value);
          }}
          // Read as "1 minute 5 seconds of 3 minutes", never a bare number.
          format={(seconds: number) => words.timeOf(seconds, length)}
          {...stylex.props(styles.slider)}
        >
          <SliderControl {...stylex.props(timelineMarker, styles.control)}>
            <SliderTrack {...stylex.props(styles.track)}>
              <SliderIndicator {...stylex.props(styles.indicator)} />
              <SliderThumb
                index={0}
                aria-label={words.position}
                {...stylex.props(styles.thumb)}
              />
            </SliderTrack>
          </SliderControl>
        </SliderPrimitive>
        {showTime && (
          <span
            aria-hidden="true"
            dir="ltr"
            data-slot="audio-player-time"
            {...stylex.props(styles.time)}
          >
            {clock(length)}
          </span>
        )}
      </div>
    </>
  );
};

/** What a key does in the bar: play or pause, the sound, five seconds back or on, or nothing. */
type KeyAction = "toggle" | "mute" | "back" | "forward" | "hold";

/** The bar's answer to a key that bubbled up from its buttons or its timeline, if any. */
const keyAction = (
  event: KeyboardEvent<HTMLElement>
): KeyAction | undefined => {
  const { target } = event;
  // A key a part inside already answered (a timeline's own arrows) is its, not the bar's.
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(target instanceof HTMLElement)
  ) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  // A held key toggles once, not on every repeat.
  if (event.repeat && (key === " " || key === "k" || key === "m")) {
    return "hold";
  }
  // Space plays and pauses anywhere in the bar but on a button, which Space presses.
  if ((key === " " && target.tagName !== "BUTTON") || key === "k") {
    return "toggle";
  }
  if (key === "m") {
    return "mute";
  }
  // On the timeline the arrows are its own steps.
  if (
    target.tagName === "INPUT" ||
    (key !== "arrowleft" && key !== "arrowright")
  ) {
    return undefined;
  }
  const rtl = getComputedStyle(target).direction === "rtl";
  return (key === "arrowleft") === rtl ? "forward" : "back";
};

interface ControlsProps {
  playing: boolean;
  /** Waiting for the file: what play says meanwhile. */
  waiting: string | undefined;
  time: number;
  duration: number;
  muted: boolean;
  rate: number;
  ghost: boolean;
  showTime: boolean;
  timeline: ReactNode;
  onToggle: () => void;
  onSeek: (to: number) => void;
  onRate: () => void;
  onMute: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** The row of the bar: play, the skips, the times and the timeline, the rate and the sound. */
const Controls = ({
  playing,
  waiting,
  time,
  duration: length,
  muted,
  rate,
  ghost,
  showTime,
  timeline,
  onToggle,
  onSeek,
  onRate,
  onMute,
  onKeyDown,
}: ControlsProps) => {
  const words = useI18n().audioPlayer;
  const own = timeline !== undefined;
  return (
    // The keys are heard here, where the bar's buttons and timeline are: nothing else in the bar
    // takes focus. The row only hears keys that bubble up from them, so it is presentation.
    <div
      role="presentation"
      onKeyDown={onKeyDown}
      {...stylex.props(
        styles.row,
        ghost && styles.rowGhost,
        own && styles.rowTimeline
      )}
    >
      <IconPress
        icon={playing ? PauseIcon : PlayIcon}
        label={playing ? words.pause : words.play}
        onPress={onToggle}
        waiting={waiting}
      />
      {own ? (
        <>
          <div
            data-slot="audio-player-timeline"
            {...stylex.props(styles.ownTimeline)}
          >
            {timeline}
          </div>
          <span aria-hidden="true" {...stylex.props(styles.spacer)} />
        </>
      ) : (
        <Middle
          time={time}
          duration={length}
          showTime={showTime}
          onSeek={onSeek}
        />
      )}
      <span {...stylex.props(own && styles.rateSlot)}>
        <Button variant="ghost" size="sm" onClick={onRate}>
          <span {...stylex.props(visuallyHidden)}>{words.playbackRate} </span>
          {/* Its words keep their order in a right-to-left page: "1.5×", never "×1.5". */}
          <span dir="ltr" data-slot="audio-player-playback-rate">
            {`${rate}×`}
          </span>
        </Button>
      </span>
      <IconPress
        icon={muted ? VolumeOffIcon : VolumeIcon}
        label={muted ? words.soundOn : words.soundOff}
        onPress={onMute}
      />
    </div>
  );
};

/** The file's own length once it is read; until then the one the page gave. */
const lengthOf = (live: number, known: number | undefined) =>
  live > 0 ? live : (known ?? 0);

/** The address the bar may play (safeMediaSrc's rule), or undefined: then it says it cannot play. */
const playableOf = (src: string, allowRemote: boolean | undefined) =>
  safeMediaSrc(src, { remote: allowRemote }) ?? undefined;

/** One bar that plays a sound file. */
export const AudioPlayer = ({
  src,
  allowRemote,
  captions,
  duration: known,
  "aria-label": label,
  playbackRates = PLAYBACK_RATES,
  errorText,
  startTime,
  endTime,
  onTimeUpdate,
  ref,
  variant = "default",
  showTime = true,
  timeline,
  style,
}: AudioPlayerProps) => {
  const words = useI18n().audioPlayer;
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(startTime ?? 0);
  // Where the next play starts, when it is not where the sound is: `startTime`, before the first play.
  const [pending, setPending] = useState<number | null>(startTime ?? null);
  const [liveDuration, setLiveDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(playbackRates[0] ?? 1);
  const [failed, setFailed] = useState(false);
  const { buffering, waitStart, waitEnd } = useBuffering();
  const length = lengthOf(liveDuration, known);
  const ghost = variant === "ghost";
  const playable = playableOf(src, allowRemote);

  // A new file starts with no failure, time or length left from the last, and not playing: the
  // browser stops the old file without saying so (no pause event), so the bar would still say Pause.
  // A new `startTime` is a new moment of the same file: the next play starts there.
  const [loadedSrc, setLoadedSrc] = useState(src);
  const [loadedStart, setLoadedStart] = useState(startTime);
  if (loadedSrc !== src || loadedStart !== startTime) {
    if (loadedSrc !== src) {
      setLoadedSrc(src);
      setPlaying(false);
      setFailed(false);
      setLiveDuration(0);
    }
    setLoadedStart(startTime);
    setTime(startTime ?? 0);
    setPending(startTime ?? null);
  }

  // A new file starts at the chosen rate too: loading resets the rate to the default one, which is
  // set here with it, so a change of file needs nothing more.
  useEffect(() => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
  }, [rate]);

  // One sound at a time: when another player on the page starts, this one pauses.
  useEffect(() => {
    const other = (event: Event) => {
      const element = audio.current;
      if (element !== null && event.target !== element && !element.paused) {
        element.pause();
      }
    };
    document.addEventListener("play", other, true);
    return () => {
      document.removeEventListener("play", other, true);
    };
  }, []);

  // The file can load, or fail, before the page hydrates and its events are heard: read it once.
  useEffect(() => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    if (element.error !== null) {
      setFailed(true);
    }
    if (Number.isFinite(element.duration)) {
      setLiveDuration(element.duration);
    }
    // Still at the start, it shows where it will start: `startTime`, held in its state already.
    if (element.currentTime > 0) {
      setTime(element.currentTime);
    }
  }, []);

  // Plays from where the next play starts, if that is not where the sound is.
  const begin = async (element: HTMLAudioElement) => {
    if (pending !== null) {
      element.currentTime = pending;
      setTime(pending);
      setPending(null);
    }
    await play(element, () => {
      setFailed(true);
    });
  };

  const toggle = () => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    if (element.paused) {
      void begin(element);
    } else {
      element.pause();
    }
  };

  const seek = (to: number) => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    const end = Number.isFinite(element.duration)
      ? element.duration
      : (known ?? to);
    element.currentTime = Math.min(Math.max(0, to), end);
    // Before any of the file is fetched, the element holds this as where it will start from.
    setTime(element.currentTime);
    // A place chosen is where the next play starts, in place of `startTime`.
    setPending(null);
    onTimeUpdate?.(element.currentTime);
  };

  // The sound moved on: playing that reaches `endTime` pauses there, and the next play starts again.
  const moved = (element: HTMLAudioElement) => {
    const now = element.currentTime;
    const reached =
      endTime !== undefined &&
      time < endTime &&
      now >= endTime &&
      !element.paused;
    if (reached) {
      element.pause();
      element.currentTime = endTime;
      setPending(startTime ?? 0);
    }
    const at = reached ? endTime : now;
    setTime(at);
    onTimeUpdate?.(at);
  };

  useImperativeHandle(ref, () => ({
    seek,
    play: async () => {
      const element = audio.current;
      if (element !== null) {
        await begin(element);
      }
    },
    pause: () => {
      audio.current?.pause();
    },
  }));

  const nextRate = () => {
    const at = playbackRates.indexOf(rate);
    setRate(playbackRates[(at + 1) % playbackRates.length] ?? 1);
  };

  const mute = () => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    element.muted = !element.muted;
    setMuted(element.muted);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const action = keyAction(event);
    if (action === undefined) {
      return;
    }
    event.preventDefault();
    if (action === "toggle") {
      toggle();
    } else if (action === "mute") {
      mute();
    } else if (action !== "hold") {
      seek(time + (action === "back" ? -5 : 5));
    }
  };

  const own = timeline !== undefined;
  return (
    <section
      data-slot="audio-player"
      aria-label={label}
      {...stylex.props(
        styles.bar,
        ghost && styles.ghost,
        own && styles.barTimeline,
        style
      )}
    >
      <audio
        ref={audio}
        src={playable}
        preload={known === undefined ? "metadata" : "none"}
        onPlay={() => {
          setPlaying(true);
        }}
        onWaiting={waitStart}
        onPlaying={waitEnd}
        onCanPlay={waitEnd}
        onPause={() => {
          setPlaying(false);
        }}
        onEnded={() => {
          setPlaying(false);
        }}
        onTimeUpdate={(event) => {
          moved(event.currentTarget);
        }}
        onLoadedMetadata={(event) => {
          setLiveDuration(event.currentTarget.duration);
        }}
        onDurationChange={(event) => {
          setLiveDuration(event.currentTarget.duration);
        }}
        onError={() => {
          setFailed(true);
        }}
      >
        <track kind="captions" src={captions} />
      </audio>
      {failed || playable === undefined ? (
        <p role="alert" {...stylex.props(styles.error)}>
          <span {...stylex.props(styles.errorMark)}>
            <Icon icon={TriangleAlertIcon} />
          </span>
          {errorText ?? words.error}
        </p>
      ) : (
        <Controls
          playing={playing}
          waiting={buffering ? words.loading : undefined}
          time={time}
          duration={length}
          muted={muted}
          rate={rate}
          ghost={ghost}
          showTime={showTime}
          timeline={timeline}
          onToggle={toggle}
          onSeek={seek}
          onRate={nextRate}
          onMute={mute}
          onKeyDown={onKeyDown}
        />
      )}
    </section>
  );
};
