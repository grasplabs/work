import { Button } from "@grasp-os/ui/components/button";
import { Chat } from "@grasp-os/ui/components/chat";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, MessageSquareIcon, PauseIcon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  budgetSeconds,
  useCountdown,
  useCountdownMarks,
  wrapUpSeconds,
} from "./clock.ts";
import { Conversation, helloTalk, talkAt, Thread } from "./conversation.tsx";
import type { Talk, Turn } from "./conversation.tsx";
import type { CountdownLook } from "./countdown.tsx";
import {
  checkAsk,
  copy,
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
import type { StartBody } from "./start-clean.tsx";
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
  /** On a phone: the texture only behind the header, or a low band under it. */
  band: "header" | "low";
  /** Ruben's alternative title on A's start (`&title=alt`). */
  altTitle: boolean;
  /** The start's body (`&body=a|b`): A the short paragraph, B with the fold-out. */
  body: StartBody;
  /** The person's name, to try a long one (`&name=`). */
  name: string;
  /** "Not right now"'s times (`&later=a|b`): A the time first, B the day first. */
  laterLook: "a" | "b";
  /** The countdown's look (`&count=a|b|c`): A small, B large, C minutes only. */
  countLook: CountdownLook;
  /** On a laptop: the pages before the conversation beside the dither, or centred in the whole window (`&layout=centre`). */
  centred: boolean;
}

/** The countdown's look by its letter. */
const countLookOf = (value: unknown): CountdownLook => {
  if (value === "b") {
    return "large";
  }
  return value === "c" ? "minutes" : "small";
};

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
    altTitle: search.title === "alt",
    // Centred in the whole window by default (Ruben chose it); the split beside the dither with `&layout=split`.
    centred: search.layout !== "split",
    body: search.body === "a" ? "a" : "b",
    laterLook: search.later === "b" ? "b" : "a",
    name:
      typeof search.name === "string" && search.name !== ""
        ? search.name
        : fixture.person,
    countLook: countLookOf(search.count),
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
  "streaming",
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
  streaming: 17 * 60 + 40,
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
    case "streaming": {
      return talkAt(2, { mode: "type", doing: "speaking" }, before);
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

/** Whether a screen stands beside the calm dither: every page but the conversation, the read-back and C's thread. */
const withScene = (screen: string): boolean =>
  !(talking.has(screen) || screen === "readback");

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
        text: copy.c.remindDone(remindWhen),
      });
    }
  }
  if (answer === "rather-not") {
    turns.push({
      id: "declined",
      from: "stephen",
      text: copy.c.declined,
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
                {copy.c.decline}
              </Button>
              <Text color="muted" size="xs">
                {copy.c.micOff}
              </Text>
            </>
          ) : null}
          {answer === "rather-not" ? (
            <Button onClick={onUndo} variant="outline">
              {copy.c.undo}
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
  altTitle,
  body,
  name,
  laterLook,
  go,
}: {
  concept: Concept;
  screen: string;
  live: boolean;
  altTitle: boolean;
  body: StartBody;
  name: string;
  laterLook: "a" | "b";
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
          look={laterLook}
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
            altTitle={altTitle}
            body={body}
            name={name}
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
          agree={copy.start.agree}
          onAgree={() => {
            go("check");
          }}
          onNotNow={() => {
            go("not-now");
          }}
          onRatherNot={() => {
            go("rather-not");
          }}
          title={copy.start.title}
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
        countLook={search.countLook}
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
    page = (
      <BeforeAB
        altTitle={search.altTitle}
        body={search.body}
        concept={concept}
        go={go}
        laterLook={search.laterLook}
        live={live}
        name={search.name}
        screen={screen}
      />
    );
  }

  return (
    <Frame
      actions={
        inTalk ? (
          <>
            {concept === "c" ? null : (
              <Button
                aria-expanded={transcript}
                aria-label={copy.talk.transcript}
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
              aria-label={copy.talk.stop}
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
      beside={withScene(screen) && !search.centred}
      band={search.band}
      strip={inTalk || (search.centred && withScene(screen))}
      besideOnPhone={concept !== "c" || screen === "language"}
    >
      {page}
    </Frame>
  );
};
