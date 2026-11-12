import type {
  ChatAsked,
  ChatAskItem,
  ChatMessage,
} from "@grasp-os/shared/chat";
import {
  AskCard,
  AskCardBody,
  AskCardChecks,
  AskCardChoices,
  AskCardFooter,
  AskCardHeader,
  AskCardOption,
  AskCardProgress,
  AskCardQuestion,
  AskCardTopic,
} from "@grasp-os/ui/components/ask-card";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Input } from "@grasp-os/ui/components/input";
import { Kbd } from "@grasp-os/ui/components/kbd";
import { RadioGroupItem } from "@grasp-os/ui/components/radio-group";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { Composer, lacksModel, NoModelNotice } from "./composer.tsx";

// What the chat's agent asks the person (`askQuestions`), in place of the
// box to ask in: one question at a time, on the kit's card (ask-card.tsx),
// each with its options, the one the agent recommends marked, and "In my
// own words" to answer otherwise; Back, Next and Send, and "Type instead"
// for the box itself. Keys: a number picks its option, Enter goes on, Esc
// types instead. Everything asked is the model's plain text, shown as
// text, never as Markdown or a link. An option is data, not a command:
// picking one only fills in the answer, and Send sends the answers as the
// person's own message, which is all the agent ever gets of them.
// Anything it then changes still waits for them to confirm it in Grasp.
//
// What is asked comes in kinds (`ChatAskItem`): each kind has its way to
// answer here (`answering`), and its answer reads as text (`answerText`).

/**
 * The questions waiting for the person's answers: those the chat's latest
 * reply asked, while nothing runs and nothing was said since.
 */
export const pendingAsk = (
  messages: readonly ChatMessage[],
  running: boolean
): ChatAsked | undefined => {
  if (running) {
    return undefined;
  }
  const last = messages.findLast(({ role }) => role !== "result");
  return last?.role === "assistant" ? last.asked : undefined;
};

/**
 * What the person answered to one question: the options they picked, by
 * index, and their own words, while they chose to answer so (`own`).
 */
export interface AskAnswer {
  picked: readonly number[];
  own?: string;
}

const unanswered: AskAnswer = { picked: [] };

/** Whether `answer` answers anything yet. */
const answers = ({ picked, own }: AskAnswer): boolean =>
  picked.length > 0 || (own?.trim() ?? "") !== "";

/**
 * One answer as the person's message says it: what they picked, as the
 * options read, and their own words.
 */
const answerText = (item: ChatAskItem, { picked, own }: AskAnswer): string =>
  formatList([
    ...picked.flatMap((index) => item.options[index]?.label ?? []),
    ...(own === undefined || own.trim() === "" ? [] : [own.trim()]),
  ]);

/**
 * The answers as the person's message: the one answer alone to a single
 * question, which answers what was just asked; otherwise each numbered,
 * one a line, after the question it answers, quoted as they saw it, so
 * the message reads as it was meant wherever it is read again: a chat
 * opened later, its summary, their memory and the brain.
 */
export const answersText = (
  asked: ChatAsked,
  given: readonly AskAnswer[]
): string => {
  const [only] = asked.questions;
  if (asked.questions.length === 1 && only !== undefined) {
    return answerText(only, given[0] ?? unanswered);
  }
  return asked.questions
    .map(
      (item, index) =>
        `${index + 1}. ${item.question} — ${answerText(item, given[index] ?? unanswered)}`
    )
    .join("\n");
};

/**
 * How far the person got with the questions of call `callId`: the one
 * they are on, and what they answered so far. Kept by the box's place
 * (`AskOrCompose`), so typing instead and coming back loses none of it.
 */
interface AskProgress {
  callId: string;
  step: number;
  given: AskAnswer[];
}

/** Where the person starts on `asked`: its first question, none answered. */
const startOf = (asked: ChatAsked): AskProgress => ({
  callId: asked.callId,
  step: 0,
  given: asked.questions.map(() => unanswered),
});

/** The value "In my own words" stands for among a question's options. */
const own = "own";

/** The options' values picked in `answer`: their indexes, and `own`. */
const valuesOf = ({ picked, own: words }: AskAnswer): string[] => [
  ...picked.map(String),
  ...(words === undefined ? [] : [own]),
];

/**
 * The answer `values` stand for, keeping the words typed so far: the
 * options picked by index, and the person's own words while `own` is.
 */
const answerOf = (values: readonly string[], before: AskAnswer): AskAnswer => {
  const picked = values
    .filter((value) => value !== own)
    .map(Number)
    .toSorted((a, b) => a - b);
  return values.includes(own) ? { picked, own: before.own ?? "" } : { picked };
};

/**
 * A question with options: a radio each, or a checkbox each where several
 * may be picked, then "In my own words", whose field opens under them.
 */
const ChoiceAnswer = ({
  item,
  labelledBy,
  answer,
  onAnswer,
}: {
  item: ChatAskItem;
  labelledBy: string;
  answer: AskAnswer;
  onAnswer: (next: AskAnswer) => void;
}) => {
  const { t } = useLingui();
  const several = item.multiple === true;
  const group = useRef<HTMLDivElement>(null);
  // The option to start on: the first picked (their own words count as
  // the last option), or the first.
  const start =
    answer.picked[0] ?? (answer.own === undefined ? 0 : item.options.length);
  // On the question as it shows (each comes anew, by its key): that
  // option, so the keys work at once and assistive technology reads it.
  // Never away from something else the person is in: only from nowhere
  // (the box the card replaced is gone) or the card.
  const focusStart = useEffectEvent(() => {
    const element = group.current;
    const focused = document.activeElement;
    const card = element?.closest('[data-slot="ask-card"]');
    if (
      element === null ||
      (focused !== null &&
        focused !== document.body &&
        card?.contains(focused) !== true)
    ) {
      return;
    }
    const controls = element.querySelectorAll<HTMLElement>(
      '[role="radio"], [role="checkbox"]'
    );
    controls[start]?.focus();
  });
  useEffect(() => {
    focusStart();
  }, []);
  const Control = several ? Checkbox : RadioGroupItem;
  const options = [
    ...item.options.map((option, index) => (
      <AskCardOption
        badge={
          index === item.recommended ? (
            <Badge variant="secondary">
              <Trans context="the option the assistant would pick">
                Recommended
              </Trans>
            </Badge>
          ) : undefined
        }
        control={<Control value={String(index)} />}
        description={option.description}
        key={option.label}
        shortcut={String(index + 1)}
      >
        {option.label}
      </AskCardOption>
    )),
    <AskCardOption
      control={<Control value={own} />}
      key={own}
      shortcut={String(item.options.length + 1)}
    >
      <Trans>In my own words</Trans>
    </AskCardOption>,
  ];
  return (
    <>
      {several ? (
        <AskCardChecks
          aria-labelledby={labelledBy}
          ref={group}
          onValueChange={(values: string[]) => {
            onAnswer(answerOf(values, answer));
          }}
          value={valuesOf(answer)}
        >
          {options}
        </AskCardChecks>
      ) : (
        <AskCardChoices
          aria-labelledby={labelledBy}
          ref={group}
          onValueChange={(value: unknown) => {
            if (typeof value === "string") {
              onAnswer(answerOf([value], answer));
            }
          }}
          value={valuesOf(answer)[0] ?? null}
        >
          {options}
        </AskCardChoices>
      )}
      {answer.own === undefined ? null : (
        <Input
          aria-label={t`Your answer`}
          autoFocus
          onChange={(event) => {
            onAnswer({ ...answer, own: event.target.value });
          }}
          value={answer.own}
        />
      )}
    </>
  );
};

/** What a key does on the card: picks an option by its number, goes on, or types instead. */
const keyed = (
  event: KeyboardEvent<HTMLElement>,
  {
    item,
    answer,
    onAnswer,
    onNext,
    onType,
  }: {
    item: ChatAskItem;
    answer: AskAnswer;
    onAnswer: (next: AskAnswer) => void;
    onNext: () => void;
    onType: () => void;
  }
): void => {
  const typing = event.target instanceof HTMLInputElement;
  if (event.key === "Escape") {
    event.preventDefault();
    onType();
    return;
  }
  if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    onNext();
    return;
  }
  const number = Number(event.key);
  if (typing || !Number.isInteger(number) || number < 1) {
    return;
  }
  const value = number === item.options.length + 1 ? own : String(number - 1);
  if (number > item.options.length + 1) {
    return;
  }
  event.preventDefault();
  // Focus goes with the pick, as the arrow keys take it; "In my own words"
  // then gives it to its field as that opens.
  event.currentTarget
    .querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]')
    .item(number - 1)
    ?.focus();
  if (item.multiple !== true) {
    onAnswer(answerOf([value], answer));
    return;
  }
  const values = valuesOf(answer);
  onAnswer(
    answerOf(
      values.includes(value)
        ? values.filter((each) => each !== value)
        : [...values, value],
      answer
    )
  );
};

/**
 * The questions, one at a time, in place of the box: each with its
 * options and "In my own words", then Send once the last is answered.
 */
export const AskedQuestions = ({
  asked,
  busy,
  children,
  failure,
  model,
  models,
  progress,
  onProgress,
  onSend,
  onType,
}: {
  asked: ChatAsked;
  busy: boolean;
  /** More of the place's own controls, beside Type instead. */
  children?: ReactNode;
  failure: string | undefined;
  /**
   * The model the answers go to and those it may be, as the box to ask
   * in names them: with none, nothing is sent and the way to connect an
   * AI provider shows instead.
   */
  model?: string;
  models?: readonly string[];
  progress: AskProgress;
  onProgress: (next: AskProgress) => void;
  onSend: (text: string, given: readonly AskAnswer[]) => void;
  onType: () => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const { step, given } = progress;
  const total = asked.questions.length;
  const item = asked.questions[step];
  const answer = given[step] ?? unanswered;
  const last = step === total - 1;
  const canSend = answers(answer) && !busy && !lacksModel(model);
  if (item === undefined) {
    return null;
  }
  const setAnswer = (next: AskAnswer): void => {
    onProgress({
      ...progress,
      given: given.map((each, index) => (index === step ? next : each)),
    });
  };
  const setStep = (next: number): void => {
    onProgress({ ...progress, step: next });
  };
  const next = (): void => {
    if (!answers(answer)) {
      return;
    }
    if (!last) {
      setStep(step + 1);
    } else if (canSend) {
      onSend(answersText(asked, given), given);
    }
  };
  const number = step + 1;
  const questionId = `${ids}-question`;
  return (
    <AskCard
      aria-label={t`Grasp asks`}
      // Keys work wherever focus is on the card.
      onKeyDown={(event) => {
        keyed(event, {
          item,
          answer,
          onAnswer: setAnswer,
          onNext: next,
          onType,
        });
      }}
    >
      <AskCardHeader>
        <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
        {item.header === undefined ? (
          <Trans>Grasp asks</Trans>
        ) : (
          <AskCardTopic>{item.header}</AskCardTopic>
        )}
        <AskCardProgress aria-live="polite" current={number} total={total}>
          <Trans>
            {number} of {total}
          </Trans>
        </AskCardProgress>
      </AskCardHeader>
      <AskCardBody>
        <AskCardQuestion id={questionId}>{item.question}</AskCardQuestion>
        <ChoiceAnswer
          answer={answer}
          // Another question's answer never carries over.
          key={step}
          labelledBy={questionId}
          onAnswer={setAnswer}
          item={item}
        />
        <NoModelNotice model={model} models={models} />
        <ErrorText>{failure}</ErrorText>
      </AskCardBody>
      <AskCardFooter>
        <Button onClick={onType} size="sm" variant="ghost">
          <Trans>Type instead</Trans>
          <Kbd aria-hidden="true">Esc</Kbd>
        </Button>
        {children}
        <span className="ml-auto flex gap-2">
          {step === 0 ? null : (
            <Button
              onClick={() => {
                setStep(step - 1);
              }}
              size="sm"
              variant="ghost"
            >
              <Trans>Back</Trans>
            </Button>
          )}
          <Button
            disabled={last ? !canSend : !answers(answer)}
            onClick={next}
            size="sm"
          >
            {last ? <Trans>Send</Trans> : <Trans>Next</Trans>}
          </Button>
        </span>
      </AskCardFooter>
    </AskCard>
  );
};

/** Back to the questions, once the person chose to type instead. */
const BackToQuestions = ({
  asked,
  onBack,
}: {
  asked: ChatAsked;
  onBack: () => void;
}) => {
  const { t } = useLingui();
  const count = asked.questions.length;
  return (
    <Button className="self-start" onClick={onBack} size="sm" variant="outline">
      <MessageCircleQuestionIcon data-icon="inline-start" />
      {t`${plural(count, { one: "Back to the question", other: "Back to the # questions" })}`}
    </Button>
  );
};

/**
 * Under a reply that asked: what it asked about, by the questions' topics,
 * or how many it asked where they have none.
 */
export const AskedLine = ({ asked }: { asked: ChatAsked }) => {
  const { t } = useLingui();
  const topics = asked.questions.flatMap(({ header }) => header ?? []);
  const count = asked.questions.length;
  const list = formatList(topics);
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
      {topics.length === count
        ? t`Asked you about ${list}`
        : t`${plural(count, { one: "Asked you a question", other: "Asked you # questions" })}`}
    </p>
  );
};

/**
 * The box to ask in, or, while questions wait for the person (`asking`:
 * the agent's, or a page's own opening), those questions in its place,
 * until they answer or choose to type instead; then a way back to them
 * above it.
 */
export const AskOrCompose = ({
  asking,
  onAnswer,
  ...composer
}: ComponentProps<typeof Composer> & {
  asking: ChatAsked | undefined;
  /** Sends the person's answers: as their own message, and as they picked them. */
  onAnswer: (text: string, given: readonly AskAnswer[]) => void;
}) => {
  const [typing, setTyping] = useState<string>();
  const [progress, setProgress] = useState<AskProgress>();
  if (asking !== undefined && typing !== asking.callId) {
    return (
      <AskedQuestions
        asked={asking}
        busy={composer.busy}
        failure={composer.failure}
        key={asking.callId}
        model={composer.model}
        models={composer.models}
        onProgress={setProgress}
        onSend={onAnswer}
        onType={() => {
          setTyping(asking.callId);
        }}
        progress={
          progress?.callId === asking.callId ? progress : startOf(asking)
        }
      >
        {composer.children}
      </AskedQuestions>
    );
  }
  return (
    <>
      {asking === undefined ? null : (
        <BackToQuestions
          asked={asking}
          onBack={() => {
            setTyping(undefined);
          }}
        />
      )}
      <Composer {...composer} />
    </>
  );
};
