import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { Composer, SaveTrouble } from "./composer.tsx";
import { Countdown, budgetMinutes } from "./countdown.tsx";
import { keepNow, update, useInterviewer, useProgress } from "./kept.ts";
import { sendTyped, useLoop } from "./loop.ts";
import { micProblem } from "./mic.ts";
import { withoutLine } from "./progress.ts";
import { ReadBack } from "./read-back.tsx";
import { say, stopSpeaking, useSaidOf } from "./speech.ts";
import { shownAs, wordsOf } from "./spoken.tsx";
import { Transcript } from "./transcript.tsx";
import { useInterviewWords } from "./words.ts";

// The conversation, after the yes: one thing in the middle of the window,
// Stephen's line, large, in the serif of what Grasp says, over it the
// minutes left, alone; at its foot Damsko's PromptInput, spoken while it
// may be (PromptInputVoice), typed otherwise. His words stream in as he
// says them: each word fades in once, opacity only, a word not yet said
// keeping its room so the line never reflows; under reduced motion words
// show as they arrive. The engine (loop.ts, speech.ts, mic.ts) says, hears
// and decides whose turn it is; this only draws it. What was said before is
// in the transcript, beside the stage on a wide window, in its place on a
// narrow one. At the end of the minutes Stephen stops, says nothing is
// lost, and hands over to the read-back.

/** From this wide the transcript has room beside the stage. */
export const besideQuery = "(min-width: 80rem)";
const beside = `@media ${besideQuery}`;

const stream = stylex.create({
  word: {
    opacity: 1,
    transitionProperty: { default: "opacity", [media.reducedMotion]: "none" },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  unseen: { opacity: 0 },
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
  roomBeside: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [beside]: "minmax(0, 1fr) 26rem",
    },
    columnGap: space["10"],
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
  // The stage: the line in the middle of the room the card leaves.
  stage: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: space["6"],
  },
  // The read-back reads from its top: its lines are a list to check.
  reading: { justifyContent: "flex-start" },
  question: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["5"],
    textAlign: "center",
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
  </>
);

/** A line of Stephen's on the stage: its first sentence large and the rest under it, when it is long. */
const SaidLine = ({ line, said }: { line: string; said: number }) => {
  const { title, rest } = shownAs(line, 90);
  return (
    <>
      <Heading level={1} size="xl">
        <Streamed said={said} text={title} />
      </Heading>
      {rest === "" ? null : (
        <Text size="lg">
          <Streamed from={title.length + 1} said={said} text={rest} />
        </Text>
      )}
    </>
  );
};

/** The stage while they talk: the minutes left, and his line as he says it. */
const Asking = ({ left }: { left: number }) => {
  const loop = useLoop();
  const saidOf = useSaidOf(loop.line);
  // While he says it, its words come one by one; once said, or waiting, they all stand.
  const said = loop.doing === "speaking" ? Math.max(loop.from, saidOf, 0) : -1;
  return (
    <div {...stylex.props(styles.question)}>
      <Countdown left={left} />
      {loop.line === "" ? null : (
        <div
          aria-live="polite"
          key={loop.saying}
          {...stylex.props(styles.question)}
        >
          <SaidLine line={loop.line} said={said} />
        </div>
      )}
    </div>
  );
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
        blocked={mode === "type" && micProblem() === "blocked"}
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
        {...stylex.props(styles.centre, transcript && styles.hiddenNarrow)}
      >
        {children}
      </div>
      <Transcript
        alone={alone}
        lines={progress.lines}
        onRemove={(at) => {
          // Kept at once: removing can't wait for the next save.
          update((now) => withoutLine(now, at));
          keepNow();
        }}
        open={transcript}
      />
    </div>
  );
};

/** The conversation, or its read-back: the stage, and the card at its foot. */
export const Conversation = ({
  left,
  reading,
  transcript,
  alone,
  onTalk,
}: {
  /** Seconds left. */
  left: number;
  reading: boolean;
  transcript: boolean;
  alone: boolean;
  onTalk: () => void;
}) => (
  <Room alone={alone} transcript={transcript}>
    <div {...stylex.props(styles.stage, reading && styles.reading)}>
      {reading ? <ReadBack /> : <Asking left={left} />}
    </div>
    <AnswerBox onTalk={onTalk} reading={reading} />
  </Room>
);

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
  const { title, rest } = shownAs(line, 0);
  return (
    <Room alone={false} transcript={false}>
      <div {...stylex.props(styles.stage)}>
        <div aria-live="polite" {...stylex.props(styles.question)}>
          <Countdown left={0} />
          <Heading level={1} size="xl">
            <Streamed said={saidOf} text={title} />
          </Heading>
          <Text size="lg">
            <Streamed from={title.length + 1} said={saidOf} text={rest} />
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
