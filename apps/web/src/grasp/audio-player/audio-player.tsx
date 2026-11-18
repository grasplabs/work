// AudioPlayer: one bar that plays a sound file, after Profound's Palermo: play, back and forward
// ten seconds, the time and the timeline, the speed, and the sound. The bar answers to its own
// width, not the page's: narrow, the skips go first, then the times, so the timeline keeps its room.
//
//   <AudioPlayer src="/media/call.mp3" label="Call with the design team" />
//
// The timeline is UI SDK's Slider and every button UI SDK's Button drawn as a ghost Grasp Button,
// so an agent can play, pause and seek by name. Keys while focus is in the bar: Space or K plays and
// pauses, the arrows go back and on five seconds, M turns the sound off and on.
//
// A page plays a moment of the file with `startAt` and `endAt`, hears where the sound is with
// `onTimeChange`, and seeks, plays and pauses it from outside through `handle`:
//
//   const player = useRef<AudioPlayerHandle | null>(null);
//   <AudioPlayer src="/media/call.mp3" label="Call" startAt={50} endAt={62} handle={player} />
//   player.current?.seek(120);
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import {
  Slider as SliderPrimitive,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
} from "@ui-sdk/react/slider";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from "react";

import { Button } from "../button";
import { visuallyHidden } from "../hidden/hidden";
import {
  Alert,
  Back10,
  Forward10,
  Icon,
  Muted,
  Pause,
  Play,
  Volume,
} from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { ms } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { timelineMarker } from "./markers.stylex";
import { useStill } from "./still-context";
import type { AudioStill } from "./still-context";
import { audioPlayerWords } from "./words";

/** What a caller may style: where the bar sits and how wide it is. Never its look. */
export type AudioPlayerLayoutStyle = LayoutStyle;

/** The words the bar writes itself: its buttons' names and how a time is said. */
export interface AudioPlayerWords {
  play: string;
  pause: string;
  /** The skip buttons: ten seconds back and on. */
  back: string;
  forward: string;
  /** The timeline's name. */
  position: string;
  /** The speed button's name; its words are the speed ("1.5×"). */
  speed: string;
  soundOn: string;
  soundOff: string;
  /** A time as it is said, from its seconds ("1 minute 5 seconds"). */
  time: (seconds: number) => string;
  /** Where it is, as it is said, from the time now and the whole length ("1 minute of 3 minutes"). */
  timeOf: (now: string, length: string) => string;
}

/** What a page can do to the player from outside it, through the `handle` prop. */
export interface AudioPlayerHandle {
  /** Sends the sound to a place, in seconds. */
  seek: (seconds: number) => void;
  /** Plays, from `startAt` the first time. Resolves once it plays, or once the browser refuses. */
  play: () => Promise<void>;
  /** Pauses. */
  pause: () => void;
}

/** Every prop an AudioPlayer takes. */
export interface AudioPlayerProps {
  /** The sound file's address. */
  src: string;
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
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * The speeds the speed button steps through, first is the start.
   * @default [1, 1.25, 1.5, 2]
   */
  speeds?: number[];
  /**
   * The words when the file cannot be played, shown in place of the controls.
   * @default "Could not play this file"
   */
  failedLabel?: string;
  /**
   * What the play button says while the file is slow to come (more than half a second).
   * @default "Loading the sound"
   */
  loadingLabel?: string;
  /** The words it writes itself, any of them replaced: the buttons' names and how a time is said. */
  words?: Partial<AudioPlayerWords>;
  /**
   * Where a play starts, in seconds: the first play, and the first after a new `src` or a new
   * `startAt`, and a play after it stopped at `endAt`. A seek before the first play wins.
   * @default 0
   */
  startAt?: number;
  /** Where it stops, in seconds: playing that reaches it pauses there. A seek past it plays on. */
  endAt?: number;
  /** Runs with the sound's place, in seconds, as it changes: while it plays, and on a seek. */
  onTimeChange?: (seconds: number) => void;
  /** A ref the player fills with what a page can do to it: `seek`, `play` and `pause`. */
  handle?: RefObject<AudioPlayerHandle | null>;
  /**
   * Without its own box: no fill, no edge, no shadow, no padding round its controls, and as wide
   * as where it stands; for a player that is the foot of something else's box, such as a
   * conversation timeline's.
   * @default false
   */
  bare?: boolean;
  /**
   * The two times beside the timeline, where the sound is and how long it is. Turn them off when
   * something round the player already writes them (a conversation timeline with the player as
   * its foot): the timeline still says both to a screen reader.
   * @default true
   */
  times?: boolean;
  /**
   * Something that stands where the bar's own timeline would, and is how the sound is moved: an
   * interview's strip of who spoke when. The bar then draws no timeline, no times and no skips of
   * its own, and is as wide as where it stands; play stays at its start, speed and sound at its
   * end. Narrow (under 30rem of its own width) the track takes a line of its own under them.
   */
  track?: ReactNode;
  /** @deprecated Use `layout`. */
  style?: AudioPlayerLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the bar. */
  layout?: AudioPlayerLayoutStyle;
}

const HOVER = media.hover;
const FORCED = media.forced;
const SKIPS_GO = "@container (width < 32rem)";
const TIMES_GO = "@container (width < 22rem)";
const TRACK_WRAPS = "@container (width < 30rem)";

const styles = stylex.create({
  bar: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    containerType: "inline-size",
    boxSizing: "border-box",
    // Its own width, not its content's: the container query below needs size containment, and a
    // contained box has no width of its own to give a parent that sizes to its content.
    width: grasp.audioWidth,
    maxWidth: "100%",
    minWidth: 0,
    margin: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: `min(${grasp.corner}, calc((${grasp.controlSm} + 2 * ${grasp.space1}) / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
  },
  // Bare: the box belongs to what it stands in.
  bare: {
    width: "100%",
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  rowBare: {
    padding: 0,
  },
  // With a track: as wide as its place; the buttons stand level with the track's first line.
  barTrack: {
    width: "100%",
  },
  rowTrack: {
    alignItems: "flex-start",
    flexWrap: { default: "nowrap", [TRACK_WRAPS]: "wrap" },
    rowGap: grasp.space1,
    paddingInline: grasp.space2,
    paddingBlock: grasp.space2,
  },
  ownTrack: {
    flexGrow: 1,
    flexBasis: { default: "0%", [TRACK_WRAPS]: "100%" },
    order: { default: 0, [TRACK_WRAPS]: 1 },
    minWidth: 0,
    paddingInline: { default: grasp.space2, [TRACK_WRAPS]: grasp.space1 },
  },
  // With a track the speed keeps one width whatever it reads ("1×", "1.25×") and whenever the font
  // arrives, so the track beside it never shifts.
  speedSlot: {
    display: "flex",
    justifyContent: "center",
    flexShrink: 0,
    inlineSize: `calc(1.75 * ${grasp.controlSm})`,
  },
  // Narrow, with a track: speed and sound go to the end of the first line.
  spacer: {
    display: { default: "none", [TRACK_WRAPS]: "block" },
    flexGrow: 1,
  },
  row: {
    display: "flex",
    alignItems: "center",
    // On a touch screen the buttons stand a finger apart: each keeps its drawn size, with 44px to
    // press that meets its neighbour's.
    gap: {
      default: grasp.space1,
      [media.coarse]: `calc(${grasp.tap} - ${grasp.controlSm})`,
    },
    minWidth: 0,
    padding: grasp.space1,
  },
  skip: {
    display: { default: "contents", [SKIPS_GO]: "none" },
  },
  middle: {
    display: "flex",
    alignItems: "center",
    flexGrow: 1,
    gap: grasp.space3,
    minWidth: 0,
    paddingInline: grasp.space2,
  },
  time: {
    display: { default: "block", [TIMES_GO]: "none" },
    flexShrink: 0,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  slider: {
    flexGrow: 1,
    // Never narrower than a finger, however narrow the bar.
    minWidth: grasp.tap,
  },
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    // A finger needs 44px: on a touch screen the press area grows past the bar, which keeps its height.
    height: { default: grasp.controlSm, [media.coarse]: grasp.tap },
    marginBlock: {
      default: 0,
      [media.coarse]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
    paddingInline: `calc(${grasp.sliderThumb} / 2)`,
    touchAction: "none",
    cursor: "pointer",
  },
  track: {
    position: "relative",
    flexGrow: 1,
    height: grasp.sliderTrack,
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.progressTrack, [FORCED]: "GrayText" },
  },
  indicator: {
    height: "100%",
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.progressFill, [FORCED]: "Highlight" },
  },
  thumb: {
    width: grasp.sliderThumb,
    height: grasp.sliderThumb,
    boxSizing: "border-box",
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: grasp.onFill, [FORCED]: "Canvas" },
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    boxShadow: grasp.liftLow,
    // The focus is on the range input inside it: the ring is drawn here, with the shared ring's
    // values (src/focus), when focus is within. A thumb is a small mark: the ring stands off it,
    // as focus.mark does and as Slider's thumb, so it is not lost on the thumb's own edge.
    outline: {
      default: "none",
      ":has(:focus-visible)": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
    outlineOffset: grasp.ringOffsetMark,
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
    transitionDuration: { default: grasp.durationHover, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  // Read by a screen reader and an agent, never seen.
  // A finger needs 44px: round a button of words narrower than that, an unseen reach.
  reach: {
    position: "absolute",
    insetBlock: 0,
    insetInline: {
      default: 0,
      [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
  },
  // The bar's own height (its row: a control and space-1 round it), so failing never shrinks it.
  failed: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: `calc(${grasp.controlSm} + 2 * ${grasp.space1})`,
    margin: 0,
    paddingInline: grasp.space3,
    color: grasp.danger,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

/** The speeds the speed button steps through when none are given. */
const SPEEDS = [1, 1.25, 1.5, 2];

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

/** "2 minutes", "1 second". */
const part = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** "1 hour 2 minutes 5 seconds", for a screen reader. */
const spoken = (seconds: number) => {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const said = [
    hours > 0 && part(hours, "hour"),
    (hours > 0 || minutes > 0) && part(minutes, "minute"),
    part(rest, "second"),
  ];
  return said.filter(Boolean).join(" ");
};

/** Its words in English: replace any of them through `words`. */
/** The player's words in English, for a part that names its player's controls from them. */
export const englishWords: AudioPlayerWords = {
  play: "Play",
  pause: "Pause",
  back: "Back 10 seconds",
  forward: "Forward 10 seconds",
  position: "Position",
  speed: "Speed",
  soundOn: "Turn sound on",
  soundOff: "Turn sound off",
  time: spoken,
  timeOf: (now, length) => `${now} of ${length}`,
};

/** Plays the file. A play cut short by a pause (AbortError) or not allowed yet is not a broken file. */
const play = async (element: HTMLAudioElement, onFailed: () => void) => {
  try {
    await element.play();
  } catch (error: unknown) {
    if (
      element.error !== null ||
      (error instanceof DOMException && error.name === "NotSupportedError")
    ) {
      onFailed();
    }
  }
};

interface IconPressProps {
  /** The icon: the button is only an icon. */
  icon: IconData;
  /** Its name ("Play"). */
  label: string;
  /** What a press does. */
  onPress: () => void;
  /** Waiting for the file: Button's working state, spinner in place of the icon, at the same width. */
  waiting?: string;
}

/** A ghost icon button of the bar, as UI SDK's Button so an agent finds it by name. */
const IconPress = ({
  icon,
  label,
  onPress,
  waiting,
}: IconPressProps): ReactElement => (
  <PressPrimitive
    onClick={onPress}
    pendingAnnouncement=""
    render={(props: Record<string, unknown>) =>
      waiting !== undefined && waiting !== "" ? (
        <Button
          {...props}
          variant="ghost"
          size="sm"
          icon={icon}
          aria-label={label}
          status="working"
          workingLabel={waiting}
          doneLabel={label}
          failedLabel={label}
        />
      ) : (
        <Button
          {...props}
          variant="ghost"
          size="sm"
          icon={icon}
          aria-label={label}
        />
      )
    }
  />
);

interface WordsPressProps {
  /** The unseen start of its name ("Speed"), before the words. */
  label: string;
  /** Words shown in place of an icon; `label` goes before them, unseen, to complete the name. */
  words: string;
  /** What a press does. */
  onPress: () => void;
}

/** A ghost button of words in the bar, as UI SDK's Button so an agent finds it by name. */
const WordsPress = ({
  label,
  words,
  onPress,
}: WordsPressProps): ReactElement => (
  <PressPrimitive
    onClick={onPress}
    pendingAnnouncement=""
    render={(props: Record<string, unknown>) => (
      <Button {...props} variant="ghost" size="sm">
        {[
          <span
            key="reach"
            aria-hidden="true"
            {...stylex.props(styles.reach)}
          />,
          <span key="name" {...stylex.props(visuallyHidden)}>
            {label}{" "}
          </span>,
          // Its words keep their order in a right-to-left page: "1.5×", never "×1.5".
          <span key="words" dir="ltr" data-slot="audio-speed">
            {words}
          </span>,
        ]}
      </Button>
    )}
  />
);

/** Waiting for data for more than half a second while playing: the play button says it is loading. */
const useBuffering = () => {
  const [buffering, setBuffering] = useState(false);
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitStart = () => {
    if (wait.current !== null) {
      clearTimeout(wait.current);
    }
    wait.current = setTimeout(() => {
      setBuffering(true);
    }, ms.durationUi * 2);
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

/** Nothing held still: the player shows what its file is doing. */
const MOVING: AudioStill = {};

/** In the docs' every-state row, the state is set, not played. */
const useShown = (live: Required<AudioStill>): Required<AudioStill> => {
  const still = useStill() ?? MOVING;
  return {
    playing: still.playing ?? live.playing,
    time: still.time ?? live.time,
    duration: still.duration ?? live.duration,
    muted: still.muted ?? live.muted,
    speed: still.speed ?? live.speed,
    failed: still.failed ?? live.failed,
    buffering: still.buffering ?? live.buffering,
  };
};

interface FailedProps {
  /** The words when the file cannot be played. */
  label: string;
}

/** The file cannot be played: its words, in place of the controls. */
const Failed = ({ label }: FailedProps) => (
  <p role="alert" {...stylex.props(styles.failed)}>
    <Icon icon={Alert} />
    {label}
  </p>
);

interface MiddleProps {
  time: number;
  duration: number;
  words: AudioPlayerWords;
  times: boolean;
  onSeek: (to: number) => void;
}

/** The bar's own middle: the skips, the times and the timeline. */
const Middle = ({ time, duration, words, times, onSeek }: MiddleProps) => (
  <>
    <div {...stylex.props(styles.skip)}>
      <IconPress
        icon={Back10}
        label={words.back}
        onPress={() => {
          onSeek(time - 10);
        }}
      />
      <IconPress
        icon={Forward10}
        label={words.forward}
        onPress={() => {
          onSeek(time + 10);
        }}
      />
    </div>
    <div {...stylex.props(styles.middle)}>
      {times && (
        <span
          aria-hidden="true"
          dir="ltr"
          data-slot="audio-time"
          {...stylex.props(styles.time)}
        >
          {clock(time)}
        </span>
      )}
      <SliderPrimitive
        value={Math.min(time, duration || 0)}
        min={0}
        max={duration > 0 ? duration : 1}
        step={1}
        onValueChange={(value: number | number[]) => {
          onSeek(Array.isArray(value) ? (value[0] ?? 0) : value);
        }}
        // Read as "1 minute 5 seconds of 3 minutes", never a bare number.
        format={(seconds: number) =>
          words.timeOf(words.time(seconds), words.time(duration))
        }
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
      {times && (
        <span
          aria-hidden="true"
          dir="ltr"
          data-slot="audio-time"
          {...stylex.props(styles.time)}
        >
          {clock(duration)}
        </span>
      )}
    </div>
  </>
);

interface ControlsProps {
  playing: boolean;
  buffering: boolean;
  /** What the play button says while the file is slow to come. */
  loadingLabel?: string;
  time: number;
  duration: number;
  muted: boolean;
  speed: number;
  words: AudioPlayerWords;
  onToggle: () => void;
  onSeek: (to: number) => void;
  onStep: () => void;
  onMute: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  bare: boolean;
  times: boolean;
  track: ReactNode;
}

/** The row of the bar: play, the skips, the times and the timeline, the speed and the sound. */
const Controls = ({
  playing,
  buffering,
  loadingLabel,
  time,
  duration,
  muted,
  speed,
  words,
  onToggle,
  onSeek,
  onStep,
  onMute,
  onKeyDown,
  bare,
  times,
  track,
}: ControlsProps) => (
  // The keys are heard here, where the bar's buttons and timeline are: nothing else in the bar takes
  // focus. The row only hears keys that bubble up from them, so it is presentation, not a control.
  <div
    role="presentation"
    onKeyDown={onKeyDown}
    {...stylex.props(
      styles.row,
      bare && styles.rowBare,
      track !== undefined && styles.rowTrack
    )}
  >
    <IconPress
      icon={playing ? Pause : Play}
      label={playing ? words.pause : words.play}
      onPress={onToggle}
      waiting={buffering ? loadingLabel : undefined}
    />
    {track === undefined ? (
      <Middle
        time={time}
        duration={duration}
        words={words}
        times={times}
        onSeek={onSeek}
      />
    ) : (
      <div data-slot="audio-track" {...stylex.props(styles.ownTrack)}>
        {track}
      </div>
    )}
    {track === undefined ? null : (
      <span aria-hidden="true" {...stylex.props(styles.spacer)} />
    )}
    <span {...stylex.props(track !== undefined && styles.speedSlot)}>
      <WordsPress label={words.speed} words={`${speed}×`} onPress={onStep} />
    </span>
    <IconPress
      icon={muted ? Muted : Volume}
      label={muted ? words.soundOn : words.soundOff}
      onPress={onMute}
    />
  </div>
);

/** One bar that plays a sound file. */
export const AudioPlayer = ({
  src,
  captions,
  duration: known,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  speeds = SPEEDS,
  failedLabel: failedGiven,
  loadingLabel: loadingGiven,
  words: given,
  startAt,
  endAt,
  onTimeChange,
  handle,
  bare = false,
  times = true,
  track,
  style: styleProp,
  layout,
}: AudioPlayerProps) => {
  const { failed: failedLabel, loading: loadingLabel } = withGiven(
    useWords("audioPlayer", audioPlayerWords),
    { failed: failedGiven, loading: loadingGiven }
  );
  const words = { ...englishWords, ...given };
  const audio = useRef<HTMLAudioElement | null>(null);
  const [livePlaying, setLivePlaying] = useState(false);
  const [liveTime, setLiveTime] = useState(startAt ?? 0);
  // Where the next play starts, when it is not where the sound is: `startAt`, before the first play.
  const [pending, setPending] = useState<number | null>(startAt ?? null);
  const [liveDuration, setLiveDuration] = useState(0);
  const [liveMuted, setLiveMuted] = useState(false);
  const [liveSpeed, setLiveSpeed] = useState(speeds[0] ?? 1);
  const [liveFailed, setLiveFailed] = useState(false);
  const { buffering: liveBuffering, waitStart, waitEnd } = useBuffering();
  const { playing, time, duration, muted, speed, failed, buffering } = useShown(
    {
      playing: livePlaying,
      time: liveTime,
      // The file's own length once it is read; until then the one the page gave.
      duration: liveDuration > 0 ? liveDuration : (known ?? 0),
      muted: liveMuted,
      speed: liveSpeed,
      failed: liveFailed,
      buffering: liveBuffering,
    }
  );

  // A new file starts with no failure, time or length left from the last, and not playing: the
  // browser stops the old file without saying so (no pause event), so the bar would still say Pause.
  // A new `startAt` is a new moment of the same file: the next play starts there.
  const [loadedSrc, setLoadedSrc] = useState(src);
  const [loadedStart, setLoadedStart] = useState(startAt);
  if (loadedSrc !== src || loadedStart !== startAt) {
    if (loadedSrc !== src) {
      setLoadedSrc(src);
      setLivePlaying(false);
      setLiveFailed(false);
      setLiveDuration(0);
    }
    setLoadedStart(startAt);
    setLiveTime(startAt ?? 0);
    setPending(startAt ?? null);
  }

  // A new file starts at the chosen speed too: loading resets the rate to the default one, which
  // is set here with it, so a change of file needs nothing more.
  useEffect(() => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    element.defaultPlaybackRate = speed;
    element.playbackRate = speed;
  }, [speed]);

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
      setLiveFailed(true);
    }
    if (Number.isFinite(element.duration)) {
      setLiveDuration(element.duration);
    }
    // Still at the start, it shows where it will start: `startAt`, held in its state already.
    if (element.currentTime > 0) {
      setLiveTime(element.currentTime);
    }
  }, []);

  // Plays from where the next play starts, if that is not where the sound is.
  const begin = async (element: HTMLAudioElement) => {
    if (pending !== null) {
      element.currentTime = pending;
      setLiveTime(pending);
      setPending(null);
    }
    await play(element, () => {
      setLiveFailed(true);
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
    setLiveTime(element.currentTime);
    // A place chosen is where the next play starts, in place of `startAt`.
    setPending(null);
    if (onTimeChange !== undefined) {
      onTimeChange(element.currentTime);
    }
  };

  // The sound moved on: playing that reaches `endAt` pauses there, and the next play starts again.
  const moved = (element: HTMLAudioElement) => {
    const now = element.currentTime;
    const reached =
      endAt !== undefined &&
      liveTime < endAt &&
      now >= endAt &&
      !element.paused;
    if (reached) {
      element.pause();
      element.currentTime = endAt;
      setPending(startAt ?? 0);
    }
    const at = reached ? endAt : now;
    setLiveTime(at);
    if (onTimeChange !== undefined) {
      onTimeChange(at);
    }
  };

  useImperativeHandle(handle, () => ({
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

  const step = () => {
    const at = speeds.indexOf(speed);
    setLiveSpeed(speeds[(at + 1) % speeds.length] ?? 1);
  };

  const mute = () => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    element.muted = !element.muted;
    setLiveMuted(element.muted);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const { target } = event;
    // A key a part inside already answered (a track's own arrows) is its, not the bar's.
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(target instanceof HTMLElement)
    ) {
      return;
    }
    const onButton = target.tagName === "BUTTON";
    const onTimeline = target.tagName === "INPUT";
    const key = event.key.toLowerCase();
    // A held key toggles once, not on every repeat.
    if (event.repeat && (key === " " || key === "k" || key === "m")) {
      event.preventDefault();
      return;
    }
    // Space plays and pauses anywhere in the bar but on a button, which Space presses.
    if ((key === " " && !onButton) || key === "k") {
      event.preventDefault();
      toggle();
    } else if (key === "m") {
      event.preventDefault();
      mute();
    } else if (!onTimeline && (key === "arrowleft" || key === "arrowright")) {
      event.preventDefault();
      const back =
        (key === "arrowleft") !==
        (getComputedStyle(target).direction === "rtl");
      seek(time + (back ? -5 : 5));
    }
  };

  return (
    <section
      data-slot="audio-player"
      aria-label={label}
      {...stylex.props(
        styles.bar,
        bare && styles.bare,
        track !== undefined && styles.barTrack,
        layout ?? styleProp
      )}
    >
      <audio
        ref={audio}
        src={src}
        preload={known === undefined ? "metadata" : "none"}
        onPlay={() => {
          setLivePlaying(true);
        }}
        onWaiting={waitStart}
        onPlaying={waitEnd}
        onCanPlay={waitEnd}
        onPause={() => {
          setLivePlaying(false);
        }}
        onEnded={() => {
          setLivePlaying(false);
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
          setLiveFailed(true);
        }}
      >
        <track kind="captions" src={captions} />
      </audio>
      {failed ? (
        <Failed label={failedLabel} />
      ) : (
        <Controls
          playing={playing}
          buffering={buffering}
          loadingLabel={loadingLabel}
          time={time}
          duration={duration}
          muted={muted}
          speed={speed}
          words={words}
          onToggle={toggle}
          onSeek={seek}
          onStep={step}
          onMute={mute}
          onKeyDown={onKeyDown}
          bare={bare}
          times={times}
          track={track}
        />
      )}
    </section>
  );
};
