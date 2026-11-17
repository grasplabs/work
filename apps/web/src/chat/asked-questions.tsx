import type {
  ChatAsked,
  ChatAskItem,
  ChatMessage,
} from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Icon, Question } from "../grasp/icons/index.ts";
import { QuestionTool } from "../grasp/question-tool/index.ts";
import type { QuestionAnswer } from "../grasp/question-tool/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ChatComposer } from "./chat-composer.tsx";
import type { ChatComposerProps } from "./chat-composer.tsx";
import { lacksModel } from "./model-names.tsx";

// What the chat's agent asks the person (`askQuestions`), in place of the
// box's text: one question at a time, on Grasp UI's Question tool inside
// the Composer (its takeover), each with its options, the one the agent
// recommends marked, and "In my own words" to answer otherwise; Back, Next
// and Send, and "Type instead" (or Escape) for the box itself. A number
// picks its option and Enter goes on. Everything asked is the model's plain
// text, shown as text, never as Markdown or a link. An option is data, not
// a command: picking one only fills in the answer, and Send sends the
// answers as the person's own message, which is all the agent ever gets of
// them. Anything it then changes still waits for them to confirm it in
// Grasp. The answers are kept per question here (`AskProgress`) and handed
// to the card, so Back, and typing instead and coming back, show them.

const styles = stylex.create({
  line: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
  },
  start: {
    alignSelf: "flex-start",
  },
});

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

/** A question's answer as the card holds it, from the person's answer. */
const cardValueOf = ({ picked, own }: AskAnswer): QuestionAnswer => ({
  values: picked.map(String),
  other: own !== undefined,
  words: own ?? "",
});

/** The person's answer, from the card's: the options by index, and their own words while chosen. */
const answerOfCard = ({ values, other, words }: QuestionAnswer): AskAnswer => {
  const picked = values.map(Number).toSorted((a, b) => a - b);
  return other ? { picked, own: words } : { picked };
};

/** The choices on a question's card: its radios or checkboxes, Other's last. */
const choicesIn = (element: HTMLElement | null): HTMLElement[] => [
  ...(element?.querySelectorAll<HTMLElement>(
    '[role="radio"], [role="checkbox"]'
  ) ?? []),
];

/**
 * Where the keys work on a question's card, as they did before it moved to
 * Grasp UI (asked of the library): as it shows, focus goes to the option
 * picked, Other where the person's own words are, or the first, so the keys
 * work at once and a screen reader reads it; never away from something else
 * the person is in. A number picks its option and takes focus with it.
 */
const ChoiceFocus = ({
  picked,
  own,
  children,
}: {
  picked: number | undefined;
  own: string | undefined;
  children: ReactNode;
}) => {
  const card = useRef<HTMLDivElement>(null);
  const start = useEffectEvent(() => {
    const element = card.current;
    const focused = document.activeElement;
    if (
      element === null ||
      (focused !== null &&
        focused !== document.body &&
        !element.contains(focused) &&
        focused.closest("[data-slot=composer]") === null)
    ) {
      return;
    }
    const choices = choicesIn(element);
    const at = picked ?? (own === undefined ? 0 : choices.length - 1);
    choices[at]?.focus();
  });
  useEffect(() => {
    start();
    const element = card.current;
    // Listened to here: the card itself is the Question tool's, with no prop for it.
    const onKey = (event: KeyboardEvent): void => {
      if (
        !/^[1-9]$/u.test(event.key) ||
        event.target instanceof HTMLInputElement
      ) {
        return;
      }
      choicesIn(element)[Number(event.key) - 1]?.focus();
    };
    element?.addEventListener("keydown", onKey);
    return () => {
      element?.removeEventListener("keydown", onKey);
    };
  }, []);
  return <div ref={card}>{children}</div>;
};

/**
 * The questions, one at a time, in the box's place: each with its options
 * and "In my own words", then Send once the last is answered. With no
 * model to answer, Send says so and sends nothing.
 */
const AskedQuestions = ({
  asked,
  busy,
  failure,
  model,
  progress,
  onProgress,
  onSend,
  onType,
}: {
  asked: ChatAsked;
  busy: boolean;
  failure: string | undefined;
  /** The model the answers go to: with none, nothing is sent. */
  model?: string;
  progress: AskProgress;
  onProgress: (next: AskProgress) => void;
  onSend: (text: string, given: readonly AskAnswer[]) => void;
  onType: () => void;
}) => {
  const { t } = useLingui();
  const { step, given } = progress;
  const total = asked.questions.length;
  const item = asked.questions[step];
  if (item === undefined) {
    return null;
  }
  const last = step === total - 1;
  const answer = given[step] ?? unanswered;
  const setStep = (next: number): void => {
    onProgress({ ...progress, step: next });
  };
  const send = (): void => {
    if (lacksModel(model)) {
      throw new Error("No model to answer");
    }
    if (!busy) {
      onSend(answersText(asked, given), given);
    }
  };
  return (
    <ChoiceFocus key={step} picked={answer.picked[0]} own={answer.own}>
      <QuestionTool
        backLabel={t`Back`}
        embedded
        failedLabel={
          lacksModel(model)
            ? t`Connect an AI provider before sending.`
            : (failure ?? t`Could not send`)
        }
        // Another question's card is a card of its own.
        key={step}
        kind={item.multiple === true ? "multi" : "single"}
        label={item.header ?? t`Grasp asks`}
        onBack={
          step === 0
            ? undefined
            : () => {
                setStep(step - 1);
              }
        }
        onSkip={onType}
        onSubmit={() => {
          if (!answers(answer)) {
            return;
          }
          if (last) {
            send();
          } else {
            setStep(step + 1);
          }
        }}
        onValueChange={(value) => {
          onProgress({
            ...progress,
            given: given.map((each, index) =>
              index === step ? answerOfCard(value) : each
            ),
          });
        }}
        options={item.options.map((option, index) => ({
          value: String(index),
          label: option.label,
          description: option.description,
          recommended: index === item.recommended,
        }))}
        otherLabel={t`In my own words`}
        question={item.question}
        recommendedLabel={t({
          message: "Recommended",
          context: "the option the assistant would pick",
        })}
        skipLabel={t`Type instead`}
        step={{ index: step, count: total }}
        stepLabel={(number, count) => t`${number} of ${count}`}
        submitLabel={last ? t`Send` : t`Next`}
        value={cardValueOf(answer)}
      />
    </ChoiceFocus>
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
    <Button
      icon={Question}
      layout={styles.start}
      onClick={() => {
        onBack();
      }}
      size="sm"
    >
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
    <p {...stylex.props(styles.line)}>
      <Icon icon={Question} />
      <Text element="span" size="xs" tone="muted">
        {topics.length === count
          ? t`Asked you about ${list}`
          : t`${plural(count, { one: "Asked you a question", other: "Asked you # questions" })}`}
      </Text>
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
  children,
  ...composer
}: ChatComposerProps & {
  /** More of the place's own controls, beside the questions' Type instead. */
  children?: ReactNode;
  asking: ChatAsked | undefined;
  /** Sends the person's answers: as their own message, and as they picked them. */
  onAnswer: (text: string, given: readonly AskAnswer[]) => void;
}) => {
  const [typing, setTyping] = useState<string>();
  const [progress, setProgress] = useState<AskProgress>();
  const answering = asking !== undefined && typing !== asking.callId;
  return (
    <>
      {asking === undefined || answering ? null : (
        <BackToQuestions
          asked={asking}
          onBack={() => {
            setTyping(undefined);
          }}
        />
      )}
      <ChatComposer
        {...composer}
        onTakeoverDismiss={
          answering
            ? () => {
                setTyping(asking.callId);
              }
            : undefined
        }
        takeover={
          answering ? (
            <AskedQuestions
              asked={asking}
              busy={composer.busy}
              failure={composer.failure}
              key={asking.callId}
              model={composer.model}
              onProgress={setProgress}
              onSend={onAnswer}
              onType={() => {
                setTyping(asking.callId);
              }}
              progress={
                progress?.callId === asking.callId ? progress : startOf(asking)
              }
            />
          ) : undefined
        }
      />
      {answering ? children : null}
    </>
  );
};
