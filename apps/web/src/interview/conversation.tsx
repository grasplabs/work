import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  duration,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { TopError } from "../frame/top-error.tsx";
import { Composer, SaveTrouble } from "./composer.tsx";
import { Countdown, budgetMinutes } from "./countdown.tsx";
import { Guide } from "./guide.tsx";
import { keepNow, update, useInterviewer, useProgress } from "./kept.ts";
import { changeSummary, goOn, sendTyped, typingNow, useLoop } from "./loop.ts";
import { micProblem } from "./mic.ts";
import { StephenOrb } from "./orb.tsx";
import { partAt, withLineText, withoutLine } from "./progress.ts";
import { ReadBack, ReadBackFoot } from "./read-back-story.tsx";
import { say, stopSpeaking, useSaidOf } from "./speech.ts";
import { questionOf, shownAs, wordsOf } from "./spoken.tsx";
import { SpokenSummary } from "./summary.tsx";
import { Transcript } from "./transcript.tsx";
import { useInterviewWords } from "./words.ts";

// The conversation, after the yes: one thing in the middle of the window,
// Stephen's line, large, in the serif of what Grasp says, over it the
// minutes left, alone; at its foot Damsko's PromptInput, spoken while it
// may be (PromptInputVoice), typed otherwise. His words stream in as he
// says them: whole words, each fading in once, opacity only, on the
// library's `ui` duration and its in-and-out curve, a word not yet said
// keeping its room so the line never reflows; under reduced motion words
// show as they arrive. Their pace is his voice's, or the pace of speech
// without sound. As the streaming spec has it (grasplabs/damsko#54), the
// moving words are hidden from a screen reader, and the whole line is
// said to it once, when it rests. The engine (loop.ts, speech.ts, mic.ts) says, hears
// and decides whose turn it is; this only draws it. What was said before is
// in the transcript, beside the stage on a wide window, in its place on a
// narrow one. At the end of the minutes Stephen stops, says nothing is
// lost, and hands over to the read-back.

/** From this wide the transcript has room beside the stage. */
export const besideQuery = "(min-width: 80rem)";
const beside = `@media ${besideQuery}`;

// Each word comes out of a soft blur as it fades in, slower than it takes him to say the next,
// so the words run into each other as one stream rather than ticking in one at a time: the
// same motion as their own words over the box (heard.tsx).
const stream = stylex.create({
  word: {
    opacity: 1,
    filter: "blur(0)",
    transitionProperty: {
      default: "opacity, filter",
      [media.reducedMotion]: "none",
    },
    transitionDuration: "460ms",
    transitionTimingFunction: duration.ease,
  },
  unseen: { opacity: 0, filter: "blur(4px)" },
});

const styles = stylex.create({
  // The stage takes the window; the transcript, when open, a column at its end.
  room: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    flexGrow: 1,
    minHeight: 0,
    boxSizing: "border-box",
    width: "100%",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlockEnd: { default: space["3"], [media.sm]: space["6"] },
  },
  // The stage stays where it stood, in the middle of the window: the transcript takes the room
  // at its end, and the same room is left at its start, so opening it moves nothing.
  roomBeside: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [beside]: "minmax(18rem, 1fr) minmax(0, 44rem) minmax(18rem, 1fr)",
    },
    columnGap: space["10"],
  },
  // Closed, the transcript's column is no box at all, so the stage keeps the room's one row.
  transcriptClosed: { display: "contents" },
  centreBeside: { gridColumn: { default: null, [beside]: "2" } },
  // The transcript's column: at the window's end, at most as wide as a chat reads well.
  transcriptBeside: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    width: "100%",
    maxWidth: { default: null, [beside]: "26rem" },
    justifySelf: { default: null, [beside]: "end" },
    gridColumn: { default: null, [beside]: "3" },
  },
  centre: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
  },
  // On a narrow window the open transcript takes the stage's place.
  hiddenNarrow: { display: { default: "none", [beside]: "flex" } },
  // The stage: his line a little above the middle of the room the card leaves, where the eye
  // rests. Its top stands still there: as the line grows while he says it, and the text under
  // the title comes, it grows downwards, and nothing already shown moves.
  stage: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: space["6"],
  },
  // The room over the line: a share of the stage, given up first when the line needs it.
  lead: { flexGrow: 0, flexShrink: 1, flexBasis: "28%", minHeight: 0 },
  question: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["5"],
    textAlign: "center",
    // No word left alone on a line of its own.
    textWrap: "balance",
  },
  /** The orb's room while paused: the word under it takes no room, so the orb stays where it stood. */
  held: { position: "relative" },
  // His orb and his summary share one place: as he begins the summary, the orb steps back where
  // it stood and the summary comes up over it, so nothing jumps.
  stack: {
    display: "grid",
    justifyItems: "center",
    alignItems: "start",
    width: "100%",
  },
  layer: {
    gridArea: "1 / 1",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["5"],
    width: "100%",
    opacity: 1,
    transform: "scale(1)",
    transitionProperty: {
      default: "opacity, transform, visibility",
      [media.reducedMotion]: "opacity, visibility",
    },
    transitionDuration: "520ms",
    transitionTimingFunction: duration.ease,
  },
  stepsBack: {
    opacity: 0,
    transform: "scale(0.92)",
    visibility: "hidden",
    pointerEvents: "none",
  },
  pausedNote: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: "100%",
    paddingBlockStart: space["3"],
  },
  next: {
    display: "flex",
    justifyContent: "center",
    paddingBlockStart: space["4"],
  },
  composer: { flexShrink: 0, paddingBlockStart: space["2"] },
  // The room their words take over the box as they talk (heard.tsx: three lines and a half, and
  // its gap), less what the stage and the box keep already: the line over it never runs under them.
  heardRoom: {
    flexShrink: 0,
    height: `calc(3.5 * ${font.textBaseLine} + ${space["3"]} - ${space["6"]})`,
  },
  // Paused, the box's place: as wide as the box, quiet.
  resume: { width: "100%", maxWidth: size.promptInputWidth },
  resumeRow: { display: "flex", justifyContent: "center" },
  // Paused, the box's place keeps the box's height: the orb above it stays where it stood.
  slot: { flexShrink: 0 },
  slotHeld: (height: number) => ({ minHeight: height }),
});

/** Watches `element`'s height, telling it each time it changes; returns what stops it. */
const watchHeight = (
  element: HTMLElement,
  tell: (height: number) => void
): (() => void) => {
  const watch = new ResizeObserver(() => {
    tell(element.offsetHeight);
  });
  watch.observe(element);
  return () => {
    watch.disconnect();
  };
};

/**
 * `text` as it stands in a line being said: it starts at `from` in that
 * line, and `said` of the line is said; -1 when the line rests, all shown.
 */
const Streamed = ({
  text,
  from = 0,
  said,
}: {
  text: string;
  from?: number;
  said: number;
}) => (
  <>
    {/* The moving words are only seen; the words at rest are what a screen reader is given, once. */}
    <span aria-hidden="true">
      {wordsOf(text).map(({ word, start }) => (
        <span
          key={start}
          {...stylex.props(
            stream.word,
            said >= 0 && said <= from + start && stream.unseen
          )}
        >
          {word}
        </span>
      ))}
    </span>
    {said < 0 ? <span {...stylex.props(visuallyHidden)}>{text}</span> : null}
  </>
);

/** A line of his that asks nothing, on the stage: whole, large, no text under it. */
const SaidLine = ({ line, said }: { line: string; said: number }) => (
  <Heading level={1} size="xl">
    <Streamed said={said} text={line} />
  </Heading>
);

/** His question alone, as the screen shows it while he talks around it: whole at once, fading in. */
const AskedLine = ({ question }: { question: string }) => (
  <div {...stylex.props(fadeIn)}>
    <Heading level={1} size="xl">
      <Streamed said={-1} text={question} />
    </Heading>
  </div>
);

/**
 * The stage while they talk; the minutes left stand in the header
 * (page.tsx). Out loud he talks as people do, taking up what they said
 * before he asks; the screen shows only the question, in one plain
 * sentence, so voice and screen are two things that belong together, not
 * the same words twice. Until the question is there, nothing new stands:
 * no words that are taken away again. Typing too, the question alone is
 * the main text, never text under it: what they answer is plain at a
 * glance (the owner's ask, 2026-11-26). A line that asks nothing is shown
 * whole.
 */
const Asking = ({
  paused = false,
  changing,
  onChange,
}: {
  paused?: boolean;
  /** They chose to change something in his summary. */
  changing: boolean;
  onChange: () => void;
}) => {
  const { t } = useLingui();
  const loop = useLoop();
  const { mode } = useProgress();
  const saidOf = useSaidOf(loop.line);
  // While he says it, its words come one by one; once said, or waiting, they all stand.
  const said = loop.doing === "speaking" ? Math.max(loop.from, saidOf, 0) : -1;
  const asked = questionOf(loop.line);
  let shown: ReactNode = null;
  if (asked !== null) {
    shown = <AskedLine key={asked.question} question={asked.question} />;
  } else if (mode !== "talk" || loop.doing !== "speaking") {
    shown = <SaidLine line={loop.line} said={said} />;
  }
  // Talking, his orb alone stands in the middle, alive to the conversation, and what was said
  // is in the transcript beside it (the owner's ask, 2026-11-26). Typing, nobody hears him: his
  // question stands under it, to be read.
  const talking = mode === "talk";
  if (paused) {
    // Paused where it stood: the same orb falls asleep, and one word under it says so.
    return (
      <div aria-live="polite" {...stylex.props(styles.question, styles.held)}>
        <StephenOrb asleep />
        <div {...stylex.props(styles.pausedNote, fadeIn)}>
          <Text color="muted" size="sm">{t`Paused`}</Text>
        </div>
      </div>
    );
  }
  // His summary, once he begins it: the one summary, what he says, big where his orb stood.
  const summing = loop.summary !== null;
  return (
    <div {...stylex.props(styles.stack)}>
      <div
        aria-hidden={summing}
        {...stylex.props(styles.layer, summing && styles.stepsBack)}
      >
        <StephenOrb />
        {talking || summing || loop.line === "" || shown === null ? null : (
          <div
            aria-live="polite"
            key={loop.saying}
            {...stylex.props(styles.question)}
          >
            {shown}
          </div>
        )}
        {talking && !summing && loop.line !== "" ? (
          // What he says is still given to a screen reader, once it rests.
          <div aria-live="polite" {...stylex.props(visuallyHidden)}>
            {loop.doing === "speaking" ? "" : loop.line}
          </div>
        ) : null}
      </div>
      {summing ? (
        <div {...stylex.props(styles.layer)}>
          <SpokenSummary changing={changing} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
};

/** The conversation can't go on: why, in the bar at the top, as every error here, never as his line, with a way to try again where that can help. */
const TurnTrouble = () => {
  const { t } = useLingui();
  const { trouble } = useLoop();
  return (
    <TopError
      action={
        trouble?.again === true ? { label: t`Try again`, run: goOn } : undefined
      }
    >
      {trouble?.message}
    </TopError>
  );
};

/** In the guide, they choose to type in the conversation after it. */
const chooseType = (): void => {
  update((now) => ({ ...now, mode: "type" }));
  keepNow();
};

/** In the guide, they choose to talk in the conversation after it after all. */
const chooseTalk = (): void => {
  update((now) => ({ ...now, mode: "talk" }));
  keepNow();
};

/** The box at the bottom, with what they must know about saving over it. */
const AnswerBox = ({
  reading,
  guiding,
  onTalk,
}: {
  reading: boolean;
  /**
   * While the guide tells about it: drawn as it will be, and its switch to
   * typing already works (what they type waits for the conversation).
   */
  guiding: boolean;
  onTalk: () => void;
}) => {
  const { t } = useLingui();
  const loop = useLoop();
  const words = useInterviewWords();
  const { mode } = useProgress();
  return (
    <div data-guide="answer" {...stylex.props(styles.composer)}>
      <SaveTrouble />
      <Composer
        micTrouble={mode === "type" ? micProblem() : null}
        // In the guide it is drawn as it will be while he talks: spoken, at rest.
        doing={guiding ? "speaking" : loop.doing}
        line={loop.saying}
        names={words.tag}
        onSend={sendTyped}
        // In the guide, what they choose is for the conversation after it: typed, it opens
        // without sound and with the box to type in; talking again, out loud.
        onTalk={guiding ? chooseTalk : onTalk}
        {...(guiding ? { onType: chooseType } : {})}
        onTyping={typingNow}
        placeholder={
          reading ? t`Type what is missing, or yes` : t`Type your answer…`
        }
        said={loop.said}
        talking={mode === "talk"}
      />
    </div>
  );
};

/** The room: the stage and its foot in the middle, the transcript at its end when open. */
const Room = ({
  transcript,
  alone,
  children,
}: {
  /** The transcript is open. */
  transcript: boolean;
  /** No room beside the stage: the transcript takes its place. */
  alone: boolean;
  children: ReactNode;
}) => {
  const progress = useProgress();
  return (
    <div {...stylex.props(styles.room, transcript && styles.roomBeside)}>
      <div
        inert={alone}
        {...stylex.props(
          styles.centre,
          transcript && styles.hiddenNarrow,
          transcript && styles.centreBeside
        )}
      >
        {children}
      </div>
      <div
        {...stylex.props(
          transcript ? styles.transcriptBeside : styles.transcriptClosed
        )}
      >
        <Transcript
          alone={alone}
          lines={progress.lines}
          onEdit={(at, text) => {
            // Kept at once, as a removal is: their own words, put right.
            update((now) => withLineText(now, at, text));
            keepNow();
          }}
          onRemove={(at) => {
            // Kept at once: removing can't wait for the next save.
            update((now) => withoutLine(now, at));
            keepNow();
          }}
          open={transcript}
        />
      </div>
    </div>
  );
};

/**
 * His summary on the stage: whether its answer stands in the box's place,
 * and whether they chose to change something in it. Its answer stands under it, and the box only
 * comes back once they want to change something; a new summary of his asks
 * afresh.
 */
const useSummaryAnswer = (onStage: boolean) => {
  const { summary } = useLoop();
  const [changingOf, setChangingOf] = useState<string | null>(null);
  const line = summary?.line ?? null;
  const changing = line !== null && changingOf === line;
  return {
    answered: onStage && line !== null && !changing,
    changing,
    change: () => {
      setChangingOf(line);
      changeSummary();
    },
  };
};

/** The conversation, or its read-back: the stage, and the card at its foot. */
export const Conversation = ({
  reading,
  guiding = false,
  transcript,
  alone,
  onTalk,
  paused = false,
  onResume,
}: {
  reading: boolean;
  /** The quick look round before the first question, in the questions' place (guide.tsx). */
  guiding?: boolean;
  transcript: boolean;
  alone: boolean;
  onTalk: () => void;
  /**
   * Paused, in place (the owner's asks, 2026-11-26 and 27): his orb falls
   * asleep where it stood, slowly, one word under it says so, and the box at
   * the foot is a quiet button to go on. Nothing else moves: the transcript
   * stays as it was, what was said is kept, and the clock waits.
   */
  paused?: boolean;
  onResume?: () => void;
}) => {
  const { t } = useLingui();
  const progress = useProgress();
  // The foot again for each part, and once what they changed is sent.
  const sent = progress.lines.filter(({ from }) => from === "person").length;
  const answer = reading ? `reading-${partAt(progress).at}-${sent}` : "asking";
  // The box comes back in the read-back once they want to change something there.
  const [changingAt, setChangingAt] = useState<string | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  /** How tall the box stood before the pause, so the Resume button holds its place. */
  const [boxHeight, setBoxHeight] = useState(0);
  useEffect(() => {
    const element = slot.current;
    return paused || element === null
      ? undefined
      : watchHeight(element, setBoxHeight);
  }, [paused]);
  const footed = reading && !paused && changingAt !== answer;
  // Over his summary the box gives way to its answer, unless they change something in it.
  const { answered, changing, change } = useSummaryAnswer(
    !reading && !guiding && !paused
  );
  return (
    <>
      <TurnTrouble />
      <Room alone={alone} transcript={transcript}>
        <div {...stylex.props(styles.stage)}>
          {reading && !paused ? (
            <ReadBack />
          ) : (
            <>
              <div aria-hidden="true" {...stylex.props(styles.lead)} />
              {guiding && !paused ? (
                <Guide />
              ) : (
                <Asking changing={changing} onChange={change} paused={paused} />
              )}
            </>
          )}
        </div>
        {reading ? null : (
          <div aria-hidden="true" {...stylex.props(styles.heardRoom)} />
        )}
        <div
          ref={slot}
          {...stylex.props(styles.slot, paused && styles.slotHeld(boxHeight))}
        >
          {paused ? (
            <div {...stylex.props(styles.composer, styles.resumeRow, fadeIn)}>
              <Button
                onClick={onResume}
                size="lg"
                style={styles.resume}
                variant="secondary"
              >
                {t`Resume`}
              </Button>
            </div>
          ) : null}
          {footed || paused || answered ? null : (
            <AnswerBox
              guiding={guiding}
              // Afresh once the guide is done, with the cursor in the box for whoever types.
              key={guiding ? "guide" : answer}
              onTalk={onTalk}
              reading={reading}
            />
          )}
        </div>
      </Room>
      {/* The setup's own foot, across the window, as the admin's onboarding has it. */}
      {footed ? (
        <ReadBackFoot
          onChange={() => {
            setChangingAt(answer);
          }}
        />
      ) : null}
    </>
  );
};

/**
 * The minutes are over: Stephen stops, says so out loud, and that nothing
 * is lost; the one way on is the read-back.
 */
export const TimeUp = ({
  name,
  onReadBack,
}: {
  name: string;
  onReadBack: () => void;
}) => {
  const { t } = useLingui();
  const speaker = useInterviewer();
  const minutes = budgetMinutes;
  const line = t`That’s our ${minutes} minutes—thank you, ${name}. Everything you shared is safely saved.`;
  const saidOf = useSaidOf(line);
  // Said once, as the screen comes, and again in another language.
  useEffect(() => {
    void say(line, { speaker, tone: "warm, grateful" });
    return () => {
      stopSpeaking();
    };
  }, [line, speaker]);
  const { title, rest, restAt } = shownAs(line);
  return (
    <Room alone={false} transcript={false}>
      <div {...stylex.props(styles.stage)}>
        <div aria-hidden="true" {...stylex.props(styles.lead)} />
        <div aria-live="polite" {...stylex.props(styles.question)}>
          <Countdown left={0} />
          <Heading level={1} size="xl">
            <Streamed said={saidOf} text={title} />
          </Heading>
          <Text size="lg">
            <Streamed from={restAt} said={saidOf} text={rest} />
          </Text>
          <div {...stylex.props(styles.next)}>
            <Button onClick={onReadBack} size="lg">
              {t`Review what I wrote down`}
            </Button>
          </div>
        </div>
      </div>
    </Room>
  );
};
