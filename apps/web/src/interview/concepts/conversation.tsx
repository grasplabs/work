import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import { Chat, ChatMessage, ChatMessages } from "@grasp-os/ui/components/chat";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  MessageContent,
  MessageResponse,
} from "@grasp-os/ui/components/message";
import { ProgressCircle } from "@grasp-os/ui/components/progress";
import {
  PromptInput,
  PromptInputBanner,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputNote,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputVoice,
} from "@grasp-os/ui/components/prompt-input";
import { Text } from "@grasp-os/ui/components/text";
import { AudioWaveformIcon, CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { micLevel, reachMic, watchLevel } from "../mic.ts";
import { useSaid, wordsOf } from "../spoken.tsx";
import {
  budgetSeconds,
  nearEnd,
  usedSeconds,
  usedWords,
  wrapUpSeconds,
} from "./clock.ts";
import {
  fixture,
  hello,
  ignore,
  helloHeard,
  heardYou,
  script,
  timeUp,
  wrapUp,
} from "./fixture.ts";
import type { ClockPlace } from "./frame.tsx";

// CONCEPT ONLY: the conversation, as every concept reaches it: Damsko’s
// Chat (the thread, Stephen’s turns at the start, the person’s at the end
// in a muted Bubble) over its PromptInput. Voice first: the card is
// PromptInputVoice while Stephen speaks and while the person talks; its
// close button is the quiet way to type, at any moment, and "Talk" in the
// typed card’s tools the way back. A microphone the browser refused is a
// PromptInputBanner over the card, and the card is typed. No model and no
// voice: the fixture’s Stephen speaks for a moment and then "hears" the
// fixture’s answer word by word. The countdown drives the wrap-up: at 5
// minutes left Stephen says it is his last question, and at 0 he stops,
// says nothing is lost, and hands over to the read-back.

/** From this wide the transcript has room beside the stage, as today. */
const besideQuery = "@media (width >= 80rem)";

// Stephen's words lighting up as he says them, as the interview does today
// (spoken.tsx): said in ink, the word being said in the accent, the rest
// waiting in the subtle grey; once the line is said, every word rests in ink.
const lit = stylex.create({
  word: {
    transitionProperty: { default: "color", [media.reducedMotion]: "none" },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  rest: { color: colors.foreground },
  said: { color: colors.foreground },
  saying: { color: colors.accent },
  waiting: { color: colors.subtleForeground },
});

const styles = stylex.create({
  room: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
    paddingInline: { default: space["3"], [media.sm]: space["6"] },
    paddingBlockEnd: { default: space["3"], [media.sm]: space["6"] },
  },
  // The stage takes the window; the transcript, when open, a column at its end.
  roomStage: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    maxWidth: "none",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
  },
  roomBeside: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [besideQuery]: "minmax(0, 1fr) 26rem",
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
  // On a phone the open transcript takes the stage's place.
  aside: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    paddingBlockEnd: space["2"],
  },
  hiddenNarrow: { display: { default: "none", [besideQuery]: "flex" } },
  chat: { flexGrow: 1, minHeight: 0 },
  // The stage: the question in the middle of the room the card leaves.
  stage: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: space["6"],
  },
  question: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["5"],
    textAlign: "center",
  },
  over: { display: "flex", alignItems: "center", gap: space["2"] },
  next: {
    display: "flex",
    justifyContent: "center",
    paddingBlockStart: space["4"],
  },
  // The card in the middle of its room, however wide the room is.
  card: { width: "100%", marginInline: "auto" },
  composer: { flexShrink: 0, paddingBlockStart: space["2"] },
  done: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space["2"],
    paddingBlockStart: space["3"],
  },
});

/** One turn of the thread, and what may stand under Stephen’s words. */
export interface Turn {
  id: string;
  from: "stephen" | "you";
  text: string;
  /** A few words Stephen says before it ("I can hear you clearly."). */
  lead?: string;
  /** Under Stephen’s words: a Confirmation, a Questionnaire (concept C). */
  extra?: ReactNode;
}

/** What is going on now. */
export type Doing =
  | "speaking"
  | "thinking"
  | "listening"
  /** A's fold-in: their first words stand written, "I can hear you clearly." under the line. */
  | "heard"
  | "over";

export interface Talk {
  turns: Turn[];
  doing: Doing;
  /** What the person said so far in this turn, heard but not yet theirs in the thread. */
  interim: string;
  mode: "voice" | "type";
  micRefused: boolean;
  /** Which of the script’s questions comes next. */
  next: number;
  /** What the fixture hears as the answer to Stephen’s last question. */
  expect: string;
  /** Stephen said he wraps up. */
  wrapped: boolean;
  /** B's "I can hear you clearly." folded into A's first line, as a moment of its own. */
  fold?: boolean;
}

/** The talk as it starts: Stephen asks to hear them, voice first. */
export const helloTalk = (before: Turn[] = []): Talk => ({
  turns: [...before, { id: "hello", from: "stephen", text: hello }],
  doing: "listening",
  interim: "",
  mode: "voice",
  micRefused: false,
  next: 0,
  expect: helloHeard,
  wrapped: false,
});

/** The talk a few turns in, for a state opened by its address. */
export const talkAt = (
  turnsDone: number,
  more: Partial<Talk> = {},
  before: Turn[] = []
): Talk => {
  const turns: Turn[] = [...before];
  for (const [index, each] of script.slice(0, turnsDone).entries()) {
    turns.push({
      id: `ask-${index}`,
      from: "stephen",
      text: each.ask,
      lead: index === 0 ? heardYou : undefined,
    });
    if (index < turnsDone - 1) {
      turns.push({ id: `answer-${index}`, from: "you", text: each.answer });
    }
  }
  return {
    turns,
    doing: "listening",
    interim: "",
    mode: "voice",
    micRefused: false,
    next: turnsDone,
    expect: script[turnsDone - 1]?.answer ?? "",
    wrapped: false,
    ...more,
  };
};

/** How long Stephen speaks a line, in ms: about as long as it takes to say, at most a few seconds here. */
const speakMs = (text: string): number =>
  Math.min(4000, 900 + text.length * 25);

/** Stephen’s next line, as the countdown stands. */
const nextLine = (talk: Talk, left: number): Talk => {
  const ask = script[talk.next] ?? script.at(-1);
  if (ask === undefined) {
    return talk;
  }
  const wrapping = left <= wrapUpSeconds && !talk.wrapped;
  // Spoken, the first question follows his check that he hears them.
  let lead: string | undefined;
  if (wrapping) {
    lead = wrapUp;
  } else if (talk.next === 0 && talk.mode === "voice" && talk.fold !== true) {
    lead = heardYou;
  }
  return {
    ...talk,
    turns: [
      ...talk.turns,
      { id: `ask-${talk.turns.length}`, from: "stephen", text: ask.ask, lead },
    ],
    doing: "speaking",
    next: talk.next + 1,
    expect: ask.answer,
    wrapped: talk.wrapped || wrapping,
  };
};

/** Their words, theirs in the thread; Stephen thinks, or, folded in, first says he heard them. */
const answered = (talk: Talk, text: string): Talk => ({
  ...talk,
  turns: [...talk.turns, { id: `you-${talk.turns.length}`, from: "you", text }],
  interim: "",
  doing:
    talk.fold === true && talk.turns.at(-1)?.id === "hello"
      ? "heard"
      : "thinking",
});

/** The time is up: Stephen stops, and nothing is lost. */
const timeIsUp = (talk: Talk): Talk => ({
  ...talk,
  turns: [
    ...talk.turns,
    ...(talk.interim === ""
      ? []
      : [{ id: "you-last", from: "you" as const, text: talk.interim }]),
    { id: "time-up", from: "stephen", text: timeUp },
  ],
  interim: "",
  doing: "over",
});

/** Runs `then` after `ms`, unless stopped first. */
export const after = (ms: number, then: () => void): (() => void) => {
  const id = window.setTimeout(then, ms);
  return () => {
    window.clearTimeout(id);
  };
};

/** Asks for the microphone, and runs `refused` when it isn’t given, unless stopped first. */
export const whenMicRefused = (refused: () => void): (() => void) => {
  let current = true;
  const ask = async (): Promise<void> => {
    const given = await reachMic();
    if (current && !given) {
      refused();
    }
  };
  void ask();
  return () => {
    current = false;
  };
};

/**
 * The fixture’s conversation, running while `live`: Stephen speaks, the
 * answer is "heard" word by word (spoken) or typed, Stephen thinks and
 * asks the next. Not live, it stands still where it was opened.
 */
export const useTalk = (start: Talk, live: boolean, left: number) => {
  const [kept, setKept] = useState(start);
  // At 0 the interviewer stops, whatever is going on.
  const talk =
    live && left <= 0 && kept.doing !== "over" ? timeIsUp(kept) : kept;
  const { doing, mode, interim, expect } = talk;

  // Stephen speaks his line, then listens.
  const last = talk.turns.at(-1)?.text ?? "";
  useEffect(
    () =>
      live && doing === "speaking"
        ? after(speakMs(last), () => {
            setKept((now) => ({ ...now, doing: "listening" }));
          })
        : undefined,
    [live, doing, last]
  );

  // Spoken, the answer is heard a word at a time, then is theirs.
  const heard = interim === "" ? 0 : interim.split(" ").length;
  const all = expect.split(" ").length;
  useEffect(
    () =>
      live && doing === "listening" && mode === "voice"
        ? after(heard >= all ? 900 : 180, () => {
            setKept((now) =>
              heard >= all
                ? answered(now, now.interim)
                : {
                    ...now,
                    interim: now.expect
                      .split(" ")
                      .slice(0, heard + 1)
                      .join(" "),
                  }
            );
          })
        : undefined,
    [live, doing, mode, heard, all]
  );

  // Folded in: the heard words stand a moment with his "I can hear you clearly.", then he goes on.
  useEffect(
    () =>
      live && doing === "heard"
        ? after(1800, () => {
            setKept((now) => ({ ...now, doing: "thinking" }));
          })
        : undefined,
    [live, doing]
  );

  // Stephen thinks a moment, then asks the next.
  useEffect(
    () =>
      live && doing === "thinking"
        ? after(1000, () => {
            setKept((now) => nextLine(now, left));
          })
        : undefined,
    [live, doing, left]
  );

  // Voice first: the microphone is asked for once talking starts; refused, the card is typed.
  useEffect(
    () =>
      live && mode === "voice"
        ? whenMicRefused(() => {
            setKept((now) => ({ ...now, micRefused: true, mode: "type" }));
          })
        : undefined,
    [live, mode]
  );
  useEffect(
    () => (live && mode === "voice" ? watchLevel(ignore) : undefined),
    [live, mode]
  );

  return {
    talk,
    type: () => {
      setKept((now) => ({ ...now, mode: "type", interim: "" }));
    },
    speak: () => {
      setKept((now) => ({ ...now, mode: "voice", micRefused: false }));
    },
    send: (text: string) => {
      setKept((now) => answered(now, text));
    },
    retryMic: async () => {
      const given = await reachMic();
      setKept((now) =>
        given ? { ...now, micRefused: false, mode: "voice" } : now
      );
    },
  };
};

/** The voice’s level: their microphone while they talk, a gentle swell while Stephen speaks. */
const levelOf = (doing: Doing, live: boolean): number => {
  const swell = 0.35 + 0.2 * Math.sin(performance.now() / 180);
  if (doing === "listening") {
    return live ? micLevel() : 0.45;
  }
  return doing === "speaking" ? swell : 0;
};

/** The thread: Stephen’s turns at the start, theirs at the end. */
export const Thread = ({ turns, doing }: { turns: Turn[]; doing: Doing }) => (
  <ChatMessages
    aria-busy={doing === "thinking"}
    aria-label={`Interview with ${fixture.interviewer}`}
  >
    {turns.map((turn, index) =>
      turn.from === "you" ? (
        <ChatMessage align="end" key={turn.id} messageId={turn.id}>
          <MessageContent>
            <Bubble align="end" variant="muted">
              <BubbleContent>{turn.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </ChatMessage>
      ) : (
        <ChatMessage
          aria-label={fixture.interviewer}
          key={turn.id}
          messageId={turn.id}
          status={
            index === turns.length - 1 && doing === "speaking"
              ? "streaming"
              : "done"
          }
        >
          <MessageContent>
            <MessageResponse>
              {turn.lead === undefined
                ? turn.text
                : `${turn.lead} ${turn.text}`}
            </MessageResponse>
            {turn.extra}
          </MessageContent>
        </ChatMessage>
      )
    )}
  </ChatMessages>
);

/** The card at the foot: spoken while it may be, typed otherwise. */
const Composer = ({
  talk,
  live,
  left,
  clock,
  onType,
  onSpeak,
  onSend,
  onRetryMic,
}: {
  talk: Talk;
  live: boolean;
  left: number;
  clock: ClockPlace;
  onType: () => void;
  onSpeak: () => void;
  onSend: (text: string) => void;
  onRetryMic: () => unknown;
}) => {
  const { doing, mode, micRefused, interim } = talk;
  const spoken = mode === "voice" && !micRefused;
  const stephenTurn = doing === "speaking" || doing === "thinking";
  return (
    <PromptInput
      aria-label="Your answer"
      style={styles.card}
      compact={!spoken}
      onSubmit={({ text }) => {
        const said = text.trim();
        if (said !== "") {
          onSend(said);
        }
      }}
      status={doing === "thinking" ? "submitted" : "ready"}
    >
      {micRefused ? (
        <PromptInputBanner
          action={
            <Button onClick={onRetryMic} size="xs" variant="outline">
              Try again
            </Button>
          }
          variant="warning"
        >
          The microphone is blocked, so you type for now.
        </PromptInputBanner>
      ) : null}
      {spoken ? (
        <PromptInputVoice
          aria-label={`Talking with ${fixture.interviewer}`}
          interim={stephenTurn || doing === "heard" ? "" : interim}
          onClose={onType}
          sample={() => ({ level: levelOf(doing, live) })}
          speaker={
            <AgentIndicator
              aria-label={
                doing === "thinking"
                  ? `${fixture.interviewer} is thinking`
                  : `${fixture.interviewer} is talking`
              }
            />
          }
          status={stephenTurn ? "speaking" : "listening"}
        >
          {doing === "heard" ? talk.turns.at(-1)?.text : null}
        </PromptInputVoice>
      ) : (
        <>
          <PromptInputBody>
            <PromptInputTextarea
              aria-label="Your answer"
              placeholder="Type your answer"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              {micRefused ? null : (
                <PromptInputButton onClick={onSpeak} tooltip="Talk instead">
                  <Icon icon={AudioWaveformIcon} />
                  Talk
                </PromptInputButton>
              )}
            </PromptInputTools>
            <PromptInputSubmit />
          </PromptInputFooter>
        </>
      )}
      {clock === "note" ? (
        <PromptInputNote>{usedWords(left)}</PromptInputNote>
      ) : null}
    </PromptInput>
  );
};

/** A line of Stephen's, its words lighting up while he says it. */
const LitLine = ({ text, speaking }: { text: string; speaking: boolean }) => {
  const said = useSaid({ line: text, saying: text.length, from: 0, speaking });
  return (
    <>
      {wordsOf(text).map(({ word, start, end }) => {
        let look: "rest" | "said" | "saying" | "waiting" = "waiting";
        if (said < 0) {
          look = "rest";
        } else if (said >= end) {
          look = "said";
        } else if (said > start) {
          look = "saying";
        }
        return (
          <span key={start} {...stylex.props(lit.word, lit[look])}>
            {word}
          </span>
        );
      })}
    </>
  );
};

/**
 * A and B: the conversation as a stage, as the interview is today: one
 * thing in the middle of the window, Stephen's line, large, centred, in the
 * serif of what Grasp says, its words lighting up as he says them; over it
 * who asks and, for A, the minutes left. What was said before is in the
 * transcript, beside the stage on a wide window.
 */
const Stage = ({
  talk,
  left,
  clock,
  onReadBack,
}: {
  talk: Talk;
  left: number;
  clock: ClockPlace;
  onReadBack: () => void;
}) => {
  const now = talk.turns.findLast((turn) => turn.from === "stephen");
  const over = [
    fixture.interviewer,
    ...(clock === "title" ? [usedWords(left)] : []),
  ].join(" · ");
  const speaking = talk.doing === "speaking";
  return (
    <div {...stylex.props(styles.stage)}>
      <div {...stylex.props(styles.question)}>
        <div {...stylex.props(styles.over)}>
          {clock === "title" ? (
            <ProgressCircle
              aria-label={`${fixture.minutes} minutes at most`}
              getAriaValueText={() => usedWords(left)}
              max={budgetSeconds}
              size="sm"
              value={usedSeconds(left)}
              variant={nearEnd(left) ? "warning" : "default"}
            />
          ) : null}
          <Text as="span" color="muted" size="sm">
            {over}
          </Text>
        </div>
        {now?.lead === undefined ||
        (talk.doing === "listening" && talk.interim !== "") ? null : (
          <Text color="muted" size="lg">
            {now.lead}
          </Text>
        )}
        <Heading level={1} size="xl">
          <LitLine key={now?.id} speaking={speaking} text={now?.text ?? ""} />
        </Heading>
        {talk.doing === "heard" ? (
          <div {...stylex.props(styles.over)}>
            <Icon icon={CheckIcon} />
            <Text color="default" size="lg">
              {heardYou}
            </Text>
          </div>
        ) : null}
        {talk.doing === "over" ? (
          <div {...stylex.props(styles.next)}>
            <Button onClick={onReadBack} size="lg">
              See what I wrote down
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** The conversation: on a stage (A, B) or in a thread (C), the card at its foot, or the way to the read-back once time is up. */
export const Conversation = ({
  start,
  live,
  left,
  clock,
  look,
  transcript = false,
  onReadBack,
}: {
  start: Talk;
  live: boolean;
  left: number;
  clock: ClockPlace;
  look: "stage" | "thread";
  /** The transcript is open: beside the stage, or in its place on a phone. */
  transcript?: boolean;
  onReadBack: () => void;
}) => {
  const { talk, type, speak, send, retryMic } = useTalk(start, live, left);
  const foot = (
    <div {...stylex.props(styles.composer)}>
      {talk.doing === "over" ? (
        <div {...stylex.props(styles.done)}>
          <Button onClick={onReadBack} size="lg">
            See what I wrote down
          </Button>
        </div>
      ) : (
        <Composer
          clock={clock}
          left={left}
          live={live}
          onRetryMic={retryMic}
          onSend={send}
          onSpeak={speak}
          onType={type}
          talk={talk}
        />
      )}
    </div>
  );
  if (look === "stage") {
    return (
      <div
        {...stylex.props(
          styles.room,
          styles.roomStage,
          transcript && styles.roomBeside
        )}
      >
        <div
          {...stylex.props(styles.centre, transcript && styles.hiddenNarrow)}
        >
          <Stage
            clock={clock}
            left={left}
            onReadBack={onReadBack}
            talk={talk}
          />
          {talk.doing === "over" ? null : foot}
        </div>
        {transcript ? (
          <div {...stylex.props(styles.aside)}>
            <Chat style={styles.chat}>
              <Thread doing={talk.doing} turns={talk.turns} />
            </Chat>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.room)}>
      <Chat style={styles.chat}>
        <Thread doing={talk.doing} turns={talk.turns} />
        {foot}
      </Chat>
    </div>
  );
};
