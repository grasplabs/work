import type { ChatAsked, ChatMessage } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { MessageCircleQuestionIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { Composer } from "./composer.tsx";

// Questions the chat's agent asked the person with choices (GRA-1001; the
// prototype's `components/chat/questions-dock.tsx`), in place of the box
// to ask in: one at a time, with "Something else" to answer in their own
// words, Back and Next, and "Type instead" for the box itself. Every
// question and choice is the model's plain text, shown as text, never as
// Markdown or a link. A choice is data, not a command: picking one only
// fills in the answer, and Send sends the answers as the person's own
// message, which is all the agent ever gets of them. Anything it then
// changes still waits for them to confirm it in Grasp.

/** The value "Something else" stands for among a question's choices. */
const other = "\u0000other";

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

/** What the person picked or wrote for one question; none yet when empty. */
interface Answer {
  choice: string | undefined;
  own: string;
}

const unanswered: Answer = { choice: undefined, own: "" };

/**
 * How far the person got with the questions of call `callId`: the one
 * they are on, and what they answered so far. Kept by the box's place
 * (`AskOrCompose`), so typing instead and coming back loses none of it.
 */
export interface AskProgress {
  callId: string;
  step: number;
  answers: Answer[];
}

/** Where the person starts on `asked`: its first question, none answered. */
const startOf = (asked: ChatAsked): AskProgress => ({
  callId: asked.callId,
  step: 0,
  answers: asked.questions.map(() => unanswered),
});

/** One answer as it is sent: the choice, or their own words. */
const answerOf = ({ choice, own }: Answer): string =>
  choice === other ? own.trim() : (choice ?? "");

/**
 * The answers as the person's message: the one answer alone to a single
 * question; otherwise each answer numbered as its question, one a line.
 * Only what the person picked or wrote: a question is the model's text,
 * so sending it would put words they never saw composed in their mouth,
 * into the transcript, their memory and the brain.
 */
export const answersText = (
  asked: ChatAsked,
  answers: readonly Answer[]
): string =>
  asked.questions.length === 1
    ? answerOf(answers[0] ?? unanswered)
    : asked.questions
        .map(
          (_question, index) =>
            `${index + 1}. ${answerOf(answers[index] ?? unanswered)}`
        )
        .join("\n");

/**
 * The questions, one at a time, in place of the box: each with its
 * choices and "Something else", then Send once the last is answered.
 */
export const AskedQuestions = ({
  asked,
  busy,
  children,
  failure,
  onProgress,
  onSend,
  onType,
  progress = startOf(asked),
}: {
  asked: ChatAsked;
  busy: boolean;
  /** More of the place's own controls, beside Type instead. */
  children?: ReactNode;
  failure: string | undefined;
  /** Keeps how far the person got; their own state without it. */
  onProgress?: (next: AskProgress) => void;
  onSend: (text: string) => void;
  onType: () => void;
  progress?: AskProgress;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const [own, setOwn] = useState(progress);
  const current = onProgress === undefined ? own : progress;
  const keep = onProgress ?? setOwn;
  const { step, answers } = current;
  const setStep = (next: number): void => {
    keep({ ...current, step: next });
  };
  const total = asked.questions.length;
  const question = asked.questions[step];
  const answer = answers[step] ?? unanswered;
  const answered = answerOf(answer) !== "";
  const last = step === total - 1;
  const setAnswer = (next: Answer): void => {
    keep({
      ...current,
      answers: answers.map((each, index) => (index === step ? next : each)),
    });
  };
  if (question === undefined) {
    return null;
  }
  const number = step + 1;
  return (
    <section
      aria-label={t`Grasp asks`}
      className="bg-card flex flex-col gap-3 rounded-xl border p-4 text-sm"
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
        {total === 1 ? (
          <Trans>Grasp asks</Trans>
        ) : (
          <Trans>
            Grasp asks, {number} of {total}
          </Trans>
        )}
      </div>
      <p className="font-medium" id={`${ids}-question`}>
        {question.question}
      </p>
      <RadioGroup
        aria-labelledby={`${ids}-question`}
        onValueChange={(value: unknown) => {
          if (typeof value === "string") {
            setAnswer({ ...answer, choice: value });
          }
        }}
        value={answer.choice ?? null}
      >
        {question.choices.map((choice, index) => (
          <div className="flex items-center gap-2" key={choice}>
            <RadioGroupItem id={`${ids}-${step}-${index}`} value={choice} />
            <Label htmlFor={`${ids}-${step}-${index}`}>{choice}</Label>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${ids}-${step}-other`} value={other} />
          <Label htmlFor={`${ids}-${step}-other`}>
            <Trans>Something else</Trans>
          </Label>
        </div>
      </RadioGroup>
      {answer.choice === other ? (
        <Input
          aria-label={t`Your answer`}
          autoFocus
          onChange={(event) => {
            setAnswer({ ...answer, own: event.target.value });
          }}
          value={answer.own}
        />
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onType} size="sm" variant="ghost">
          <Trans>Type instead</Trans>
        </Button>
        {children}
        <span className="ml-auto flex gap-2">
          {step === 0 ? null : (
            <Button
              onClick={() => {
                setStep(step - 1);
              }}
              size="sm"
              variant="outline"
            >
              <Trans>Back</Trans>
            </Button>
          )}
          {last ? (
            <Button
              disabled={!answered || busy}
              onClick={() => {
                onSend(answersText(asked, answers));
              }}
              size="sm"
            >
              <Trans>Send</Trans>
            </Button>
          ) : (
            <Button
              disabled={!answered}
              onClick={() => {
                setStep(step + 1);
              }}
              size="sm"
            >
              <Trans>Next</Trans>
            </Button>
          )}
        </span>
      </div>
    </section>
  );
};

/** Back to the questions, once the person chose to type instead. */
export const BackToQuestions = ({
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

/** Under a reply that asked: how many questions, as the thread shows it. */
export const AskedLine = ({ asked }: { asked: ChatAsked }) => {
  const { t } = useLingui();
  const count = asked.questions.length;
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
      {t`${plural(count, { one: "Asked you a question", other: "Asked you # questions" })}`}
    </p>
  );
};

/**
 * The box to ask in, or, while the chat's agent waits on questions it
 * asked with choices, those questions in its place, until the person
 * answers or chooses to type instead; then a way back to them above it.
 */
export const AskOrCompose = ({
  messages,
  onAnswer,
  ...composer
}: ComponentProps<typeof Composer> & {
  messages: readonly ChatMessage[];
  /** Sends the person's answers, as their own message. */
  onAnswer: (answers: string) => void;
}) => {
  const asking = pendingAsk(messages, composer.running);
  // The questions the person chose to type instead of answering, by call.
  const [typing, setTyping] = useState<string>();
  // How far they got with them, kept while they type instead.
  const [progress, setProgress] = useState<AskProgress>();
  if (asking !== undefined && typing !== asking.callId) {
    return (
      <AskedQuestions
        asked={asking}
        busy={composer.busy}
        failure={composer.failure}
        key={asking.callId}
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
