import type {
  ChatAsked,
  ChatAskItem,
  ChatMessage,
} from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import type { QuestionnaireAnswer } from "@grasp-os/ui/components/questionnaire";
import { CircleHelpIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { formatList } from "../format.ts";
import { Composer, lacksModel, NoModelNotice } from "./composer.tsx";
import { FailureLine } from "./failure-line.tsx";

const styles = stylex.create({
  asked: { display: "grid", gap: space["2"] },
  // While the person types instead: kept, with what they answered, unseen.
  away: { display: "none" },
  // Only a hold for where focus goes: no box of its own in the layout.
  room: { display: "contents" },
});

/** Where focus goes as the questions and the box change places. */
type FocusTo = "box" | "questions";

/** The box's text, or the question shown and its first answer, in `room`. */
const focusIn = (room: HTMLElement, to: FocusTo): void => {
  if (to === "box") {
    room.querySelector<HTMLElement>('[role="textbox"]')?.focus();
    return;
  }
  const answers = room.querySelectorAll<HTMLElement>(
    "[role=radio], [role=checkbox], textarea"
  );
  [...answers].find((answer) => answer.closest("[hidden]") === null)?.focus();
};

// What the chat's agent asks the person (`askQuestions`), in place of the
// box to ask in: one question at a time, on Damsko's Questionnaire, each
// with its options, the one the agent recommends marked, and words of the
// person's own to answer otherwise; Back, Next and Send, and "Type
// instead" (or Escape) for the box itself, which keeps what was answered
// for when the person comes back. Keys: a number picks its option, Enter
// goes on. Everything asked is the model's plain text, shown as
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

/** The person's answer to one question, as the questionnaire gives it. */
const answerOf = ({ values, text }: QuestionnaireAnswer): AskAnswer => ({
  picked: values.map(Number).toSorted((one, other) => one - other),
  ...(text === "" ? {} : { own: text }),
});

/**
 * The questions the agent asked, in the box's place, on Damsko's
 * Questionnaire: one at a time, each its choices (the recommended one
 * marked, several where it takes several) and words of the person's own,
 * Next and Back between them, and Send on the last; Type instead, or
 * Escape, goes back to the box. Hidden while the person types instead,
 * so what they answered stays for when they come back.
 */
export const AskedQuestions = ({
  asked,
  busy,
  children,
  failure,
  hidden,
  model,
  models,
  onSend,
  onType,
}: {
  asked: ChatAsked;
  busy: boolean;
  children?: ReactNode;
  failure: string | undefined;
  hidden: boolean;
  model?: string;
  models?: readonly string[];
  /** Sends the answers: true once core took them, false when it did not. */
  onSend: (text: string, given: readonly AskAnswer[]) => Promise<boolean>;
  onType: () => void;
}) => {
  const { t } = useLingui();
  const canSend = !busy && !lacksModel(model);
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = place.current;
    // Listened to here: the Questionnaire takes its own keys, and has no
    // way out of the questions.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        // Not also the chat's own Escape, which closes it.
        event.preventDefault();
        onType();
      }
    };
    element?.addEventListener("keydown", onKey);
    return () => {
      element?.removeEventListener("keydown", onKey);
    };
  }, [onType]);
  return (
    <div
      hidden={hidden}
      ref={place}
      {...stylex.props(styles.asked, hidden && styles.away)}
    >
      <Questionnaire
        aria-label={t`Grasp asks`}
        // Sent only once core took the answers: until then the choices and
        // actions stay, to send again or type instead.
        onSubmit={async (sent) => {
          const given = asked.questions.map((_, index) => {
            const answer = sent[String(index)];
            return answer === undefined ? unanswered : answerOf(answer);
          });
          if (!(await onSend(answersText(asked, given), given))) {
            throw new Error("The answers were not sent.");
          }
        }}
      >
        {asked.questions.length > 1 ? <QuestionnaireProgress /> : null}
        {asked.questions.map((item, index) => (
          <QuestionnaireItem
            key={item.question}
            multiple={item.multiple === true}
            name={String(index)}
            required
          >
            <QuestionnaireTitle>{item.question}</QuestionnaireTitle>
            {item.header === undefined ? null : (
              <QuestionnaireDescription>{item.header}</QuestionnaireDescription>
            )}
            <QuestionnaireChoices>
              {item.options.map((option, at) => (
                <QuestionnaireChoice
                  key={option.label}
                  recommended={item.recommended === at}
                  value={String(at)}
                >
                  {option.label}
                  {option.description === undefined ? null : (
                    <QuestionnaireChoiceDescription>
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  )}
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
            <QuestionnaireInput />
            <QuestionnaireError />
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <Button onClick={onType} size="sm" variant="ghost">
            <Trans>Type instead</Trans>
          </Button>
          {children}
          <QuestionnairePrevious />
          <QuestionnaireNext />
          <QuestionnaireSubmit disabled={!canSend} />
        </QuestionnaireActions>
      </Questionnaire>
      <NoModelNotice model={model} models={models} />
      <FailureLine>{failure}</FailureLine>
    </div>
  );
};

/** The way back to the questions, over the box, once the person chose to type instead. */
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
    <div>
      <Button onClick={onBack} size="sm" variant="outline">
        <Icon icon={CircleHelpIcon} />
        {t`${plural(count, { one: "Back to the question", other: "Back to the # questions" })}`}
      </Button>
    </div>
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
  onAnswer: (text: string, given: readonly AskAnswer[]) => Promise<boolean>;
}) => {
  const [typing, setTyping] = useState<string>();
  const asked = asking !== undefined && typing !== asking.callId;
  // Type instead (or Escape) takes focus to the box; Back to the question,
  // to the question; once each is drawn.
  const room = useRef<HTMLDivElement>(null);
  const focusTo = useRef<FocusTo | null>(null);
  useEffect(() => {
    const to = focusTo.current;
    // Each once what it goes to is drawn: the questions while asked, else the box.
    if (
      to === null ||
      room.current === null ||
      (to === "questions") !== asked
    ) {
      return;
    }
    focusTo.current = null;
    focusIn(room.current, to);
  }, [asked]);
  return (
    <div ref={room} {...stylex.props(styles.room)}>
      {asking === undefined ? null : (
        <AskedQuestions
          asked={asking}
          busy={composer.busy}
          failure={composer.failure}
          hidden={!asked}
          key={asking.callId}
          model={composer.model}
          models={composer.models}
          onSend={onAnswer}
          onType={() => {
            setTyping(asking.callId);
            focusTo.current = "box";
          }}
        >
          {asked ? composer.children : null}
        </AskedQuestions>
      )}
      {asked ? null : (
        <>
          {asking === undefined ? null : (
            <BackToQuestions
              asked={asking}
              onBack={() => {
                setTyping(undefined);
                focusTo.current = "questions";
              }}
            />
          )}
          <Composer {...composer} />
        </>
      )}
    </div>
  );
};
