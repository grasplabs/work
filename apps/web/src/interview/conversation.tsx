import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { TopError } from "../frame/top-error.tsx";
import { Composer, SaveTrouble } from "./composer.tsx";
import { Countdown, budgetMinutes } from "./countdown.tsx";
import { keepNow, update, useInterviewer, useProgress } from "./kept.ts";
import { sendTyped, useLoop } from "./loop.ts";
import { micProblem } from "./mic.ts";
import { partAt, withLineText, withoutLine } from "./progress.ts";
import { ReadBack, ReadBackFoot } from "./read-back-story.tsx";
import { say, stopSpeaking, useSaidOf } from "./speech.ts";
import { questionOf, shownAs, wordsOf } from "./spoken.tsx";
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
  next: {
    display: "flex",
    justifyContent: "center",
    paddingBlockStart: space["4"],
  },
  composer: { flexShrink: 0, paddingBlockStart: space["2"] },
});

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
const Asking = () => {
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
  return (
    <div {...stylex.props(styles.question)}>
      {loop.line === "" || shown === null ? null : (
        <div
          aria-live="polite"
          key={loop.saying}
          {...stylex.props(styles.question)}
        >
          {shown}
        </div>
      )}
    </div>
  );
};

/** A turn that could not be had: in the bar at the top, as every error here, never as his line. */
const TurnTrouble = () => {
  const loop = useLoop();
  return <TopError>{loop.trouble}</TopError>;
};

/** The box at the bottom, with what they must know about saving over it. */
const AnswerBox = ({
  reading,
  onTalk,
}: {
  reading: boolean;
  onTalk: () => void;
}) => {
  const { t } = useLingui();
  const loop = useLoop();
  const words = useInterviewWords();
  const { mode } = useProgress();
  return (
    <div {...stylex.props(styles.composer)}>
      <SaveTrouble />
      <Composer
        micTrouble={mode === "type" ? micProblem() : null}
        doing={loop.doing}
        line={loop.saying}
        names={words.tag}
        onSend={sendTyped}
        onTalk={onTalk}
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

/** The conversation, or its read-back: the stage, and the card at its foot. */
export const Conversation = ({
  reading,
  transcript,
  alone,
  onTalk,
}: {
  reading: boolean;
  transcript: boolean;
  alone: boolean;
  onTalk: () => void;
}) => {
  const progress = useProgress();
  // The foot again for each part, and once what they changed is sent.
  const sent = progress.lines.filter(({ from }) => from === "person").length;
  const answer = reading ? `reading-${partAt(progress).at}-${sent}` : "asking";
  // The box comes back in the read-back once they want to change something there.
  const [changingAt, setChangingAt] = useState<string | null>(null);
  const footed = reading && changingAt !== answer;
  return (
    <>
      <TurnTrouble />
      <Room alone={alone} transcript={transcript}>
        <div {...stylex.props(styles.stage)}>
          {reading ? (
            <ReadBack />
          ) : (
            <>
              <div aria-hidden="true" {...stylex.props(styles.lead)} />
              <Asking />
            </>
          )}
        </div>
        {footed ? null : (
          <AnswerBox key={answer} onTalk={onTalk} reading={reading} />
        )}
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
  const line = t`That’s our ${minutes} minutes. Thanks, ${name}. Everything you shared is saved.`;
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
