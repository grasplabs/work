import { Button } from "@grasp-os/ui/components/button";
import { Chat } from "@grasp-os/ui/components/chat";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, MessageSquareIcon, PauseIcon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Scene } from "../../apps/app-card/scenes.ts";
import {
  budgetSeconds,
  useCountdown,
  useCountdownMarks,
  wrapUpSeconds,
} from "./clock.ts";
import { Conversation, helloTalk, talkAt, Thread } from "./conversation.tsx";
import type { Talk, Turn } from "./conversation.tsx";
import {
  checkAsk,
  checkHeard,
  fixture,
  hello,
  helloHeard,
  ignore,
  script,
  timeUp,
  wrapUp,
} from "./fixture.ts";
import { Frame } from "./frame.tsx";
import type { ClockPlace } from "./frame.tsx";
import { ReadBackPlaceholder } from "./read-back.tsx";
import { ConsentClean } from "./start-clean.tsx";
import {
  Consent,
  consentTurn,
  Declined,
  LanguageFirst,
  NotNow,
  Paused,
  RatherNot,
  Reminded,
  remindTurn,
  SoundCheckB,
} from "./start.tsx";
import type { ConsentAnswer } from "./start.tsx";

// CONCEPT ONLY (never merged): `/interview?concept=a|b|c`, the interview’s
// start as an employee meets it, three ways, on fixture data: no link, no
// sign-in, no model. `&at=<screen>` opens a screen directly (the pull
// request’s screenshots), `&left=<minutes>` starts the countdown there,
// `&still` stops the fixture’s clock and conversation where they open,
// `&lang=unknown` is concept C with a language neither the browser nor
// the company gives. Without `concept` the route is the real interview.

export type Concept = "a" | "b" | "c";

export interface ConceptSearch {
  concept: Concept;
  stage: "start" | "readback";
  at: string | undefined;
  left: number | undefined;
  still: boolean;
  lang: "unknown" | undefined;
  transcript: boolean;
  fold: boolean;
  /** On a phone: the scene only behind the header, or a low band under it. */
  band: "header" | "low";
}

/** Reads the concept’s own part of the address; nothing when it names no concept. */
export const conceptSearch = (
  search: Record<string, unknown>
): ConceptSearch | undefined => {
  const { concept } = search;
  if (concept !== "a" && concept !== "b" && concept !== "c") {
    return undefined;
  }
  const left = Number(search.left);
  return {
    concept,
    stage: search.stage === "readback" ? "readback" : "start",
    at: typeof search.at === "string" ? search.at : undefined,
    left: Number.isFinite(left) && search.left !== undefined ? left : undefined,
    still: search.still !== undefined,
    lang: search.lang === "unknown" ? "unknown" : undefined,
    transcript: search.transcript !== undefined,
    fold: search.fold !== undefined,
    band: search.band === "header" ? "header" : "low",
  };
};

const styles = stylex.create({
  // C before the yes: the thread alone, the microphone’s promise under it.
  thread: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
    paddingInline: { default: space["3"], [media.sm]: space["6"] },
    paddingBlockEnd: { default: space["4"], [media.sm]: space["6"] },
  },
  chat: { flexGrow: 1, minHeight: 0 },
  under: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["2"],
    paddingBlockStart: space["3"],
    textAlign: "center",
  },
});

/** Where the countdown stands in each concept. */
const clockOf: Record<Concept, ClockPlace> = {
  a: "title",
  b: "bar",
  c: "note",
};

/** The screens of the conversation, as against the pages before it. */
const talking = new Set([
  "hello",
  "hello-heard",
  "talk",
  "b-talk",
  "listening",
  "typed",
  "b-typed",
  "mic-refused",
  "five-left",
  "time-up",
]);

/** Seconds left as each screen opens, unless the address says otherwise. */
const leftAt: Record<string, number> = {
  hello: budgetSeconds,
  "hello-heard": budgetSeconds - 12,
  talk: 18 * 60 + 50,
  "b-talk": 19 * 60 + 40,
  listening: 17 * 60 + 5,
  typed: 16 * 60 + 30,
  "b-typed": budgetSeconds,
  "mic-refused": 19 * 60 + 20,
  "five-left": wrapUpSeconds - 10,
  "time-up": 0,
  paused: 14 * 60 + 10,
};

/** What happened in the thread before the questions, per concept. */
const beforeQuestions = (concept: Concept): Turn[] => {
  if (concept === "b") {
    return [
      { id: "check", from: "stephen", text: checkAsk },
      { id: "check-heard", from: "you", text: checkHeard },
    ];
  }
  const heard: Turn[] = [
    { id: "hello", from: "stephen", text: hello },
    { id: "hello-heard", from: "you", text: helloHeard },
  ];
  return concept === "c" ? [consentTurn("yes", ignore), ...heard] : heard;
};

/** The first words of an answer, as heard so far. */
const partly = (text: string, words: number): string =>
  text.split(" ").slice(0, words).join(" ");

/** The conversation as each screen opens it. */
const talkFor = (concept: Concept, at: string): Talk => {
  const before = beforeQuestions(concept);
  switch (at) {
    case "hello-heard": {
      const talk = helloTalk();
      return {
        ...talk,
        fold: true,
        doing: "heard",
        turns: [
          ...talk.turns,
          { id: "hello-heard", from: "you", text: helloHeard },
        ],
      };
    }
    case "hello": {
      return helloTalk(concept === "c" ? [consentTurn("yes", ignore)] : []);
    }
    case "b-talk": {
      return { ...talkAt(0, {}, before), doing: "thinking" };
    }
    case "b-typed": {
      return {
        ...talkAt(0, { mode: "type", expect: checkHeard }, before.slice(0, 1)),
      };
    }
    case "listening": {
      return talkAt(2, { interim: partly(script[1].answer, 11) }, before);
    }
    case "typed": {
      return talkAt(2, { mode: "type" }, before);
    }
    case "mic-refused": {
      return talkAt(1, { mode: "type", micRefused: true }, before);
    }
    case "five-left": {
      const talk = talkAt(
        4,
        { wrapped: true, interim: partly(script[3].answer, 6) },
        before
      );
      const turns = talk.turns.map((turn) =>
        turn.id === "ask-3" ? { ...turn, lead: wrapUp } : turn
      );
      return { ...talk, turns };
    }
    case "time-up": {
      const talk = talkAt(4, { wrapped: true }, before);
      return {
        ...talk,
        doing: "over",
        turns: [
          ...talk.turns.map((turn) =>
            turn.id === "ask-3" ? { ...turn, lead: wrapUp } : turn
          ),
          { id: "answer-3", from: "you", text: script[3].answer },
          { id: "time-up", from: "stephen", text: timeUp },
        ],
      };
    }
    default: {
      return talkAt(1, { doing: "speaking" }, before);
    }
  }
};

/** The scene beside a page before the conversation: A’s wave, B’s mountain, C’s aurora. */
const scenes: Record<Concept, Scene> = { a: "wave", b: "fuji", c: "aurora" };

/** Whether a screen stands beside its concept's scene: every page but the conversation, the read-back and C's thread. */
const withScene = (concept: Concept, screen: string): Scene | undefined => {
  if (talking.has(screen) || screen === "readback") {
    return undefined;
  }
  return scenes[concept];
};

/** A's fold-in variant: B's "I can hear you clearly." moment, with `&fold`. */
const talkFold = (search: ConceptSearch, screen: string): boolean =>
  search.concept === "a" && (search.fold || screen === "hello-heard");

/** The first screen of each concept. */
const firstScreen = (search: ConceptSearch): string => {
  if (search.stage === "readback") {
    return "readback";
  }
  if (search.at !== undefined) {
    return search.at;
  }
  return search.concept === "c" && search.lang === "unknown"
    ? "language"
    : "start";
};

/** Concept C before the conversation: Stephen’s first turn asks for the yes, in the thread. */
const ConsentThread = ({
  answer,
  remindWhen,
  onAnswer,
  onRemind,
  onUndo,
}: {
  answer: ConsentAnswer;
  remindWhen: string | null;
  onAnswer: (answer: Exclude<ConsentAnswer, null>) => void;
  onRemind: (when: string) => void;
  onUndo: () => void;
}) => {
  const turns: Turn[] = [consentTurn(answer, onAnswer)];
  if (answer === "not-now") {
    turns.push(remindTurn(remindWhen, onRemind));
    if (remindWhen !== null) {
      turns.push({
        id: "reminded",
        from: "stephen",
        text: `Done: I’ll remind you ${remindWhen}. Nothing was recorded. The interviews close ${fixture.closes}.`,
      });
    }
  }
  if (answer === "rather-not") {
    turns.push({
      id: "declined",
      from: "stephen",
      text: `That’s fine, ${fixture.person}. ${fixture.sponsor.name} will see that you’re not taking part, never why. Nothing was recorded, and I won’t remind you. If you change your mind, this link works until ${fixture.closes}.`,
    });
  }
  return (
    <div {...stylex.props(styles.thread)}>
      <Chat defaultScrollPosition="start" style={styles.chat}>
        <Thread doing="listening" turns={turns} />
        <div {...stylex.props(styles.under)}>
          {answer === null ? (
            <>
              <Button
                onClick={() => {
                  onAnswer("rather-not");
                }}
                variant="link"
              >
                I’d rather not
              </Button>
              <Text color="muted" size="xs">
                Your microphone stays off until you say yes.
              </Text>
            </>
          ) : null}
          {answer === "rather-not" ? (
            <Button onClick={onUndo} variant="outline">
              I changed my mind
            </Button>
          ) : null}
        </div>
      </Chat>
    </div>
  );
};

/** B’s sound check, by the screen it opens on. */
const checkStart = {
  check: "listening",
  "check-heard": "heard",
  "check-refused": "refused",
} as const;

const isCheck = (screen: string): screen is keyof typeof checkStart =>
  screen in checkStart;

/** Concepts A and B before the conversation: the consent, and the ways out of it. */
const BeforeAB = ({
  concept,
  screen,
  live,
  go,
}: {
  concept: Concept;
  screen: string;
  live: boolean;
  go: (screen: string) => void;
}) => {
  const [when, setWhen] = useState<string>(fixture.remindAt[1].when);
  const toStart = (): void => {
    go("start");
  };
  if (isCheck(screen)) {
    return (
      <SoundCheckB
        live={live}
        onStart={() => {
          go("b-talk");
        }}
        onType={() => {
          go("b-typed");
        }}
        start={checkStart[screen]}
      />
    );
  }
  switch (screen) {
    case "not-now": {
      return (
        <NotNow
          onBack={toStart}
          onPick={(picked) => {
            setWhen(picked);
            go("reminded");
          }}
        />
      );
    }
    case "reminded": {
      return <Reminded onStart={toStart} when={when} />;
    }
    case "rather-not": {
      return (
        <RatherNot
          onBack={toStart}
          onConfirm={() => {
            go("declined");
          }}
        />
      );
    }
    case "declined": {
      return <Declined onUndo={toStart} />;
    }
    default: {
      if (concept === "a") {
        return (
          <ConsentClean
            onAgree={() => {
              go("hello");
            }}
            onNotNow={() => {
              go("not-now");
            }}
            onRatherNot={() => {
              go("rather-not");
            }}
          />
        );
      }
      return (
        <Consent
          agree="I agree"
          onAgree={() => {
            go("check");
          }}
          onNotNow={() => {
            go("not-now");
          }}
          onRatherNot={() => {
            go("rather-not");
          }}
          title={`${fixture.minutes} minutes with ${fixture.interviewer}`}
        />
      );
    }
  }
};

/** Concept C before the conversation: the language when unknown, then the thread that asks. */
const BeforeC = ({
  screen,
  go,
}: {
  screen: string;
  go: (screen: string) => void;
}) => {
  const [answer, setAnswer] = useState<ConsentAnswer>(() => {
    if (screen === "not-now" || screen === "reminded") {
      return "not-now";
    }
    return screen === "declined" ? "rather-not" : null;
  });
  const [remindWhen, setRemindWhen] = useState<string | null>(
    screen === "reminded" ? fixture.remindAt[1].when : null
  );
  if (screen === "language") {
    return (
      <LanguageFirst
        onPick={() => {
          go("start");
        }}
      />
    );
  }
  return (
    <ConsentThread
      answer={answer}
      onAnswer={(given) => {
        setAnswer(given);
        if (given === "yes") {
          go("hello");
        }
      }}
      onRemind={setRemindWhen}
      onUndo={() => {
        setAnswer(null);
        setRemindWhen(null);
      }}
      remindWhen={remindWhen}
    />
  );
};

/** One concept of the interview’s start, on fixture data. */
export const InterviewConcepts = ({ search }: { search: ConceptSearch }) => {
  const { concept } = search;
  const [screen, setScreen] = useState(() => firstScreen(search));
  const inTalk = talking.has(screen);
  const startLeft =
    search.left === undefined
      ? (leftAt[screen] ?? budgetSeconds)
      : search.left * 60;
  const live = !search.still;
  const [transcript, setTranscript] = useState(search.transcript);
  const left = useCountdown(startLeft, live && inTalk);
  useCountdownMarks(left, live && inTalk);
  const go = (next: string): void => {
    setScreen(next);
  };

  let page: ReactNode;
  if (screen === "readback") {
    page = <ReadBackPlaceholder />;
  } else if (inTalk) {
    page = (
      <Conversation
        clock={clockOf[concept]}
        key={screen}
        left={left}
        live={live}
        look={concept === "c" ? "thread" : "stage"}
        transcript={transcript}
        onReadBack={() => {
          go("readback");
        }}
        start={{ ...talkFor(concept, screen), fold: talkFold(search, screen) }}
      />
    );
  } else if (screen === "paused") {
    page = (
      <Paused
        minutesLeft={Math.ceil(left / 60)}
        onCarryOn={() => {
          go(concept === "b" ? "b-talk" : "talk");
        }}
      />
    );
  } else if (concept === "c") {
    page = <BeforeC go={go} screen={screen} />;
  } else {
    page = <BeforeAB concept={concept} go={go} live={live} screen={screen} />;
  }

  return (
    <Frame
      actions={
        inTalk ? (
          <>
            {concept === "c" ? null : (
              <Button
                aria-expanded={transcript}
                aria-label="Transcript"
                onClick={() => {
                  setTranscript(!transcript);
                }}
                size="icon-sm"
                variant={transcript ? "secondary" : "ghost"}
              >
                <Icon icon={MessageSquareIcon} />
              </Button>
            )}
            <Button
              aria-label="Stop for now"
              onClick={() => {
                go("paused");
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Icon icon={PauseIcon} />
            </Button>
          </>
        ) : null
      }
      clock={clockOf[concept]}
      left={inTalk ? left : null}
      scene={withScene(concept, screen)}
      band={search.band}
      sceneOnPhone={concept !== "c" || screen === "language"}
    >
      {page}
    </Frame>
  );
};
