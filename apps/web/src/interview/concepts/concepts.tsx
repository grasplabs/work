import { Button } from "@grasp-os/ui/components/button";
import {
  Icon,
  MessageSquareFilledIcon,
  PauseFilledIcon,
} from "@grasp-os/ui/lib/icons";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  budgetSeconds,
  useCountdown,
  useCountdownMarks,
  wrapUpSeconds,
} from "./clock.ts";
import { Conversation, helloTalk, talkAt } from "./conversation.tsx";
import type { Talk, Turn } from "./conversation.tsx";
import {
  copy,
  fixture,
  hello,
  helloHeard,
  script,
  timeUp,
  wrapUp,
} from "./fixture.ts";
import { Frame } from "./frame.tsx";
import { ReadBackPlaceholder } from "./read-back.tsx";
import { ConsentClean } from "./start-clean.tsx";
import { Declined, NotNow, Paused, RatherNot, Reminded } from "./start.tsx";

// CONCEPT ONLY (never merged): the interview's start as an employee meets
// it, on fixture data: no sign-in, no model. One screen to agree, then the
// conversation. `/interview` without a link's secret shows it (the route
// decides); `&at=<screen>` opens a screen directly (the pull request's
// screenshots), `&left=<minutes>` starts the countdown there, `&still`
// stops the fixture's clock and conversation where they open, `&name=`
// tries another name in the title.

export interface ConceptSearch {
  at: string | undefined;
  left: number | undefined;
  still: boolean;
  /** The person's name, to try a long one (`&name=`). */
  name: string;
}

/** Reads the concept's switches from the address. */
export const conceptSearch = (
  search: Record<string, unknown>
): ConceptSearch => {
  const left = Number(search.left);
  return {
    at: typeof search.at === "string" ? search.at : undefined,
    left: Number.isFinite(left) && search.left !== undefined ? left : undefined,
    still: search.still !== undefined,
    name:
      typeof search.name === "string" && search.name !== ""
        ? search.name
        : fixture.person,
  };
};

/** The screens of the conversation, as against the pages before it. */
const talking = new Set([
  "hello",
  "hello-heard",
  "talk",
  "listening",
  "typed",
  "streaming",
  "mic-refused",
  "five-left",
  "time-up",
]);

/** Seconds left as each screen opens, unless the address says otherwise. */
const leftAt: Record<string, number> = {
  hello: budgetSeconds,
  "hello-heard": budgetSeconds - 12,
  talk: 18 * 60 + 50,
  listening: 17 * 60 + 5,
  typed: 16 * 60 + 30,
  streaming: 17 * 60 + 40,
  "mic-refused": 19 * 60 + 20,
  "five-left": wrapUpSeconds - 10,
  "time-up": 0,
  paused: 14 * 60 + 10,
};

/** What happened in the thread before the questions. */
const beforeQuestions: Turn[] = [
  { id: "hello", from: "stephen", text: hello },
  { id: "hello-heard", from: "you", text: helloHeard },
];

/** The first words of an answer, as heard so far. */
const partly = (text: string, words: number): string =>
  text.split(" ").slice(0, words).join(" ");

/** The conversation as each screen opens it. */
const talkFor = (at: string): Talk => {
  const before = beforeQuestions;
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
      return helloTalk();
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

/** Whether a screen stands under the calm dither's strip: every page but the read-back. */
const withScene = (screen: string): boolean => screen !== "readback";

/** Before the conversation: the consent, and the ways out of it. */
const Before = ({
  screen,
  name,
  go,
}: {
  screen: string;
  name: string;
  go: (screen: string) => void;
}) => {
  const [when, setWhen] = useState<string>(fixture.remindAt[1].when);
  const toStart = (): void => {
    go("start");
  };
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
      return (
        <ConsentClean
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
  }
};

/** The interview's start and conversation, on fixture data. */
export const InterviewConcepts = ({ search }: { search: ConceptSearch }) => {
  const [screen, setScreen] = useState(() => search.at ?? "start");
  const inTalk = talking.has(screen);
  const startLeft =
    search.left === undefined
      ? (leftAt[screen] ?? budgetSeconds)
      : search.left * 60;
  const live = !search.still;
  const [transcript, setTranscript] = useState(false);
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
        key={screen}
        left={left}
        live={live}
        transcript={transcript}
        onReadBack={() => {
          go("readback");
        }}
        start={talkFor(screen)}
      />
    );
  } else if (screen === "paused") {
    page = (
      <Paused
        minutesLeft={Math.ceil(left / 60)}
        onCarryOn={() => {
          go("talk");
        }}
      />
    );
  } else {
    page = <Before go={go} name={search.name} screen={screen} />;
  }

  return (
    <Frame
      actions={
        inTalk ? (
          <>
            <Button
              aria-expanded={transcript}
              aria-label={copy.talk.transcript}
              onClick={() => {
                setTranscript(!transcript);
              }}
              size="icon-sm"
              variant={transcript ? "secondary" : "ghost"}
            >
              <Icon icon={MessageSquareFilledIcon} />
            </Button>
            <Button
              aria-label={copy.talk.stop}
              onClick={() => {
                go("paused");
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Icon icon={PauseFilledIcon} />
            </Button>
          </>
        ) : null
      }
      strip={withScene(screen)}
    >
      {page}
    </Frame>
  );
};
