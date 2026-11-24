import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@grasp-os/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@grasp-os/ui/components/prompt-input";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import { Suggestion, Suggestions } from "@grasp-os/ui/components/suggestion";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { chooseLocale, isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";
import { useCoreAction } from "../../use-core-action.ts";
import { useSay, useVoice } from "../../voice/voice.ts";
import { AiChoice } from "./ai-choice.tsx";
import type { ConceptProps, ConceptStep } from "./concept-props.ts";
import { ConceptFrame } from "./frame.tsx";
import { LanguageCards } from "./language-cards.tsx";
import type { CardLook } from "./language-cards.tsx";
import { CampaignTimeline } from "./plan.tsx";
import { SoundToggle } from "./sound-toggle.tsx";
import { interviewer, StephenFigure } from "./stephen.tsx";

// Concept A, "a conversation": Stephen asks, the admin answers, and each
// answer stays in the transcript as it was said, the next question after
// it; the library's Messages in its MessageScroller, his at the start,
// theirs as Bubbles at the end. Where he asks with choices, the choices
// stand in the thread right under his question: the language cards, a
// Questionnaire for whose AI, the Connect API key block for a key. Only the
// plan's open question has the PromptInput, with dictation, at the foot.
// Stephen's figure stands once, beside his first message. He speaks his
// newest line when the sound is on.

const styles = stylex.create({
  // The transcript takes what the answer leaves; the answer stays in sight.
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    flexGrow: 1,
    minHeight: 0,
  },
  scroller: { flexGrow: 1, minHeight: 0 },
  answer: { display: "grid", gap: space[2], flexShrink: 0 },
  rich: { display: "grid", gap: space[3], width: "100%" },
  end: { marginInlineStart: "auto" },
});

/** What the admin answered, kept in this tab: a language changes the whole page. */
interface Said {
  language?: string;
  ai?: "grasp" | "own";
  asked: { question: string; answer: string }[];
}

const keptKey = "grasp.concept-a";

const readSaid = (): Said => {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(keptKey) ?? "null");
    if (typeof raw === "object" && raw !== null && "asked" in raw) {
      // SAFETY: written by `writeSaid` alone, in this tab.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return raw as Said;
    }
  } catch {
    // Nothing kept.
  }
  return { asked: [] };
};

const writeSaid = (said: Said): void => {
  try {
    sessionStorage.setItem(keptKey, JSON.stringify(said));
  } catch {
    // Kept only while the page is open.
  }
};

/** One turn of the transcript. */
interface Turn {
  id: string;
  from: "stephen" | "admin";
  text: string;
  /** What stands under his words: the choices he asks for, the timeline. */
  more?: ReactNode;
}

/** His turn: his figure and name beside the first one alone. */
const StephenTurn = ({ turn, first }: { turn: Turn; first: boolean }) => (
  <Message aria-label={interviewer}>
    <MessageAvatar>{first ? <StephenFigure size="xs" /> : null}</MessageAvatar>
    <MessageContent>
      {first ? (
        <MessageHeader>
          <Text as="span" color="muted" size="sm">
            {interviewer}
          </Text>
        </MessageHeader>
      ) : null}
      <Bubble variant="ghost">
        <BubbleContent>{turn.text}</BubbleContent>
      </Bubble>
      {turn.more === undefined ? null : (
        <div {...stylex.props(styles.rich)}>{turn.more}</div>
      )}
    </MessageContent>
  </Message>
);

const AdminTurn = ({ turn }: { turn: Turn }) => (
  <Message align="end">
    <MessageContent>
      <Bubble align="end" variant="muted">
        <BubbleContent>{turn.text}</BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
);

/** What Stephen answers to a question about the plan, as far as the plan says. */
const useReplies = () => {
  const { t } = useLingui();
  return {
    later: {
      question: t`Can we start later?`,
      answer: t`Yes. You pick the first day when you tell your team, a few steps from now.`,
    },
    first: {
      question: t`Who goes first?`,
      answer: t`The people who know the work best. You name them in a few steps.`,
    },
    noted: t`I’ve passed that on to the Grasp team. They’ll answer you by email today.`,
    goOn: t`Sounds good, go on`,
  };
};

/** Speaking instead of typing: the library's dictation button, its bar shown while it listens. */
const DictateButton = () => {
  const [listening, setListening] = useState(false);
  return (
    <PromptInputSpeechButton
      listening={listening}
      onListeningChange={setListening}
    />
  );
};

/** Whose AI: Grasp's, or a key of their own. */
const WhoseAnswer = ({
  onPick,
}: {
  onPick: (whose: "grasp" | "own") => void;
}) => {
  const { t } = useLingui();
  return (
    <Questionnaire
      onSubmit={(answers) => {
        const [choice] = answers.ai?.values ?? [];
        if (choice === "own" || choice === "grasp") {
          onPick(choice);
        }
      }}
    >
      <QuestionnaireItem name="ai">
        <QuestionnaireTitle>{t`Which AI`}</QuestionnaireTitle>
        <QuestionnaireChoices>
          <QuestionnaireChoice recommended value="grasp">
            {t`Grasp’s AI`}
            <QuestionnaireChoiceDescription>{t`Works right away. You pay for what you use.`}</QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
          <QuestionnaireChoice value="own">
            {t`My own key`}
            <QuestionnaireChoiceDescription>{t`Your own contract with a provider.`}</QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireActions>
        <QuestionnaireSubmit />
      </QuestionnaireActions>
    </Questionnaire>
  );
};

/** Anything to ask about the plan: a few to press, or their own words, typed or said. */
const PlanAnswer = ({
  offered,
  onAsk,
}: {
  offered: readonly string[];
  onAsk: (question: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <>
      <Suggestions>
        {offered.map((each) => (
          <Suggestion key={each} onClick={onAsk} suggestion={each} />
        ))}
      </Suggestions>
      <PromptInput
        aria-label={t`Answer Stephen`}
        onSubmit={({ text }) => {
          if (text.trim() !== "") {
            onAsk(text.trim());
          }
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            aria-label={t`Your answer`}
            placeholder={t`Ask me something, or say go on`}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools style={styles.end}>
            <DictateButton />
            <PromptInputSubmit />
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInput>
    </>
  );
};

/** What the admin answered once a model is ready. */
const useAiAnswer = (ai: ConceptProps["data"]["ai"]): string => {
  const { t } = useLingui();
  const own = ai?.listing.providers[0];
  if (ai === null || ai.listing.source === "grasp" || own === undefined) {
    return t`Grasp’s AI`;
  }
  return t`${own.label}, key ${own.mask}`;
};

/** The ways the admin answers, as the thread needs them. */
interface Answers {
  onLanguage: (code: Locale) => void;
  onWhose: (whose: "grasp" | "own") => void;
  onKeyReady: () => void;
}

/** Where things stand in the conversation, from what was said and what core tells. */
interface Standing {
  step: ConceptStep;
  at: number;
  said: Said;
  language: string | undefined;
  ai: ConceptProps["data"]["ai"];
  ready: boolean;
  whose: Said["ai"];
}

/** The welcome and the AI, turn by turn, each question with its choices under it while it is open. */
const useOpeningTurns = (
  { step, at, said, language, ai, ready, whose }: Standing,
  admin: string,
  answers: Answers,
  look: CardLook
): Turn[] => {
  const { t } = useLingui();
  const aiAnswer = useAiAnswer(ai);
  const turns: Turn[] = [
    {
      id: "hello",
      from: "stephen",
      text:
        admin === ""
          ? t`Hi, I’m Stephen. I’ll set up Grasp with you, one step at a time.`
          : t`Hi ${admin}, I’m Stephen. I’ll set up Grasp with you, one step at a time.`,
    },
    {
      id: "language",
      from: "stephen",
      text: t`Which language would you like to work in?`,
      ...(step === "welcome" && {
        more: (
          <LanguageCards
            chosen={null}
            look={look}
            onPick={(code) => {
              answers.onLanguage(code);
            }}
          />
        ),
      }),
    },
  ];
  if (language === undefined) {
    return turns;
  }
  const asking = step === "ai" && !ready && ai !== null;
  turns.push(
    { id: "language-said", from: "admin", text: language },
    {
      id: "ai",
      from: "stephen",
      text: t`${language} it is. Which AI should I use? Everything I read and say runs on it.`,
      ...(asking &&
        whose === undefined && {
          more: (
            <WhoseAnswer
              onPick={(picked) => {
                answers.onWhose(picked);
              }}
            />
          ),
        }),
    }
  );
  if (at >= 1 && said.ai === "own") {
    turns.push(
      { id: "ai-said", from: "admin", text: t`My own key` },
      {
        id: "key",
        from: "stephen",
        text: t`Pick your provider and paste its key. I’ll check it works before we go on.`,
        ...(asking && {
          more: (
            <AiChoice
              ai={{
                ...ai,
                listing: {
                  ...ai.listing,
                  grasp: { ...ai.listing.grasp, available: false },
                },
              }}
              onReady={() => {
                answers.onKeyReady();
              }}
            />
          ),
        }),
      }
    );
  }
  if (at >= 1 && ready && ai !== null) {
    turns.push({ id: "ai-ready", from: "admin", text: aiAnswer });
  }
  return turns;
};

/** The plan, and what was asked about it. */
const usePlanTurns = (said: Said, today: Date): Turn[] => {
  const { t } = useLingui();
  return [
    {
      id: "plan",
      from: "stephen",
      text: t`That works. Here’s the plan. I talk with your team for one week, then you get what I learned.`,
      more: <CampaignTimeline today={today} />,
    },
    {
      id: "example",
      from: "stephen",
      text: t`For example, I might ask what happens when someone new joins. If they say the laptop takes two or three days, I note that as a wait in welcoming new people.`,
    },
    {
      id: "ask",
      from: "stephen",
      text: t`Anything you’d like to ask before we go on?`,
    },
    ...said.asked.flatMap((each, index): Turn[] => [
      { id: `asked-${index}`, from: "admin", text: each.question },
      { id: `answer-${index}`, from: "stephen", text: each.answer },
    ]),
  ];
};

export const ChatConcept = ({
  step,
  admin,
  data,
  today,
  go,
  onward,
  cards,
}: Omit<ConceptProps, "foot">) => {
  const { t, i18n } = useLingui();
  const [said, setSaid] = useState(readSaid);
  const replies = useReplies();
  const router = useRouter();
  const { run } = useCoreAction();
  const update = (next: Said) => {
    setSaid(next);
    writeSaid(next);
  };
  const at = (["welcome", "ai", "about"] as const).indexOf(step);
  const locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const { ai } = data;
  const graspOffered = ai?.listing.grasp.available === true;
  // Grasp's AI, chosen: the organization's AI runs on it, and on to the plan.
  const chooseGrasp = async () => {
    const set = await run(async (session) => {
      await session.aiProviders.setSource("grasp");
      return true;
    });
    if (set === true) {
      await router.invalidate({ sync: true });
      go("about");
    }
  };
  const opening = useOpeningTurns(
    {
      step,
      at,
      said,
      // Past the welcome, the language is the page's, whether or not it was said here.
      language: said.language ?? (at > 0 ? localeNames[locale] : undefined),
      ai,
      ready: ai === null || ai.ready,
      whose: said.ai ?? (graspOffered ? undefined : "own"),
    },
    admin,
    {
      onLanguage: (code) => {
        update({ ...said, language: localeNames[code] });
        void (async () => {
          await chooseLocale(code);
          go("ai");
        })();
      },
      onWhose: (whose) => {
        update({ ...said, ai: whose });
        if (whose === "grasp") {
          void chooseGrasp();
        }
      },
      onKeyReady: () => {
        go("about");
      },
    },
    cards
  );
  const plan = usePlanTurns(said, today);
  const turns = at >= 2 ? [...opening, ...plan] : opening;
  const last = turns.at(-1);
  const { on } = useVoice();
  useSay(last?.from === "stephen" ? last.text : "", { when: on, delay: 300 });

  const ask = (question: string) => {
    if (question === replies.goOn) {
      onward();
      return;
    }
    const known = [replies.later, replies.first].find(
      (each) => each.question === question
    );
    update({
      ...said,
      asked: [
        ...said.asked,
        { question, answer: known?.answer ?? replies.noted },
      ],
    });
  };

  // At the foot: only the plan's open question, or the way on once the AI is ready.
  let foot: ReactNode = null;
  if (step === "about") {
    foot = (
      <PlanAnswer
        offered={[replies.goOn, replies.later.question, replies.first.question]}
        onAsk={ask}
      />
    );
  } else if (step === "ai" && (ai === null || ai.ready)) {
    foot = (
      <Suggestions>
        <Suggestion
          onClick={() => {
            go("about");
          }}
          suggestion={t`Go on`}
        />
      </Suggestions>
    );
  }

  return (
    <ConceptFrame
      fill
      language={step !== "welcome"}
      step={step}
      tools={<SoundToggle />}
      wide
    >
      <div {...stylex.props(styles.stack)}>
        <MessageScrollerProvider autoScroll>
          <MessageScroller style={styles.scroller}>
            <MessageScrollerViewport
              aria-label={t`Your conversation with ${interviewer}`}
            >
              <MessageScrollerContent>
                {turns.map((turn, index) => (
                  <MessageScrollerItem
                    key={turn.id}
                    messageId={turn.id}
                    scrollAnchor={turn.from === "admin"}
                  >
                    {turn.from === "admin" ? (
                      <AdminTurn turn={turn} />
                    ) : (
                      <StephenTurn first={index === 0} turn={turn} />
                    )}
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        {foot === null ? null : (
          <div {...stylex.props(styles.answer)}>{foot}</div>
        )}
      </div>
    </ConceptFrame>
  );
};
