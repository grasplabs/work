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
import { CampaignPicture, CampaignTimeline, ExampleNote } from "./plan.tsx";
import { SoundToggle } from "./sound-toggle.tsx";
import { interviewer, StephenFigure } from "./stephen.tsx";

// Concept A, "a conversation": Stephen asks, the admin answers, and each
// answer stays in the transcript as it was said, the next question after
// it; the library's Messages in its MessageScroller, his at the start,
// theirs as Bubbles at the end. Where he asks, the answer takes the
// question's shape at the foot, where a chat's box would be: a
// Questionnaire for a choice, the Connect API key block for a key, and the
// PromptInput, with dictation, for words of their own. Stephen speaks his
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
  host: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[2],
    paddingBlock: space[4],
  },
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
  /** What stands under his words: the timeline, the example. */
  more?: ReactNode;
}

const StephenTurn = ({ turn, first }: { turn: Turn; first: boolean }) => (
  <Message aria-label={interviewer}>
    <MessageAvatar>{first ? <StephenFigure size="xs" /> : null}</MessageAvatar>
    <MessageContent>
      {first ? (
        <MessageHeader>
          <Text as="span" color="muted" size="sm" weight="medium">
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
      question: t`Who talks to you first?`,
      answer: t`The people who know the work best. You name them in a few steps.`,
    },
    noted: t`I’ve noted that for Grasp’s team. They answer you by email today.`,
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

/** Where things stand in the conversation, from what was said and what core tells. */
interface Standing {
  at: number;
  said: Said;
  language: string | undefined;
  ai: ConceptProps["data"]["ai"];
  ready: boolean;
  whose: Said["ai"];
}

/** What the admin answered once a model is ready. */
const useAiAnswer = (ai: Standing["ai"]): string => {
  const { t } = useLingui();
  const own = ai?.listing.providers[0];
  if (ai === null || ai.listing.source === "grasp" || own === undefined) {
    return t`Grasp’s AI`;
  }
  return t`${own.label}, key ${own.mask}`;
};

/** The transcript so far, turn by turn. */
const useTurns = (
  { at, said, language, ai, ready, whose }: Standing,
  admin: string,
  today: Date
): Turn[] => {
  const { t } = useLingui();
  const aiAnswer = useAiAnswer(ai);
  const turns: Turn[] = [
    {
      id: "hello",
      from: "stephen",
      text: t`Hi ${admin}, I’m Stephen. I set up Grasp with you, in about 8 minutes.`,
    },
    {
      id: "language",
      from: "stephen",
      text: t`First, which language suits you?`,
    },
  ];
  if (language !== undefined) {
    turns.push(
      { id: "language-said", from: "admin", text: language },
      {
        id: "ai",
        from: "stephen",
        text: t`${language} it is. Which AI should I think with? Everything I read and say runs on it.`,
      }
    );
  }
  if (at >= 1 && whose === "own" && said.ai === "own") {
    turns.push(
      { id: "ai-said", from: "admin", text: t`My own key` },
      {
        id: "key",
        from: "stephen",
        text: t`Pick your provider and paste its key. I test it before we go on.`,
      }
    );
  }
  if (at >= 1 && ready && ai !== null) {
    turns.push({ id: "ai-ready", from: "admin", text: aiAnswer });
  }
  if (at < 2) {
    return turns;
  }
  turns.push(
    {
      id: "plan",
      from: "stephen",
      text: t`That works. Here’s the plan: one week of short talks with your team, then you get what I learned.`,
      more: (
        <>
          <CampaignPicture />
          <CampaignTimeline today={today} />
        </>
      ),
    },
    {
      id: "example",
      from: "stephen",
      text: t`This is what one answer gives me.`,
      more: <ExampleNote />,
    },
    {
      id: "ask",
      from: "stephen",
      text: t`Anything you’d like to ask before we go on?`,
    }
  );
  const asked = said.asked.flatMap((each, index): Turn[] => [
    { id: `asked-${index}`, from: "admin", text: each.question },
    { id: `answer-${index}`, from: "stephen", text: each.answer },
  ]);
  return [...turns, ...asked];
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
            <QuestionnaireChoiceDescription>{t`Nothing to set up. You pay for what you use.`}</QuestionnaireChoiceDescription>
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

/** Anything to ask: a few to press, or their own words, typed or said. */
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
            placeholder={t`Ask, or say go on`}
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

/** The answer at the foot, in the shape of what Stephen asks now. */
const Answer = ({
  step,
  standing,
  onLanguage,
  onWhose,
  onAsk,
  go,
}: {
  step: ConceptStep;
  standing: Standing;
  onLanguage: (code: Locale) => void;
  onWhose: (whose: "grasp" | "own") => void;
  onAsk: (question: string) => void;
  go: (step: ConceptStep) => void;
}) => {
  const { t } = useLingui();
  const replies = useReplies();
  const { ai, ready, whose } = standing;
  if (step === "welcome") {
    return <LanguageCards chosen={null} onPick={onLanguage} />;
  }
  if (step === "about") {
    return (
      <PlanAnswer
        offered={[replies.goOn, replies.later.question, replies.first.question]}
        onAsk={onAsk}
      />
    );
  }
  if (ready || ai === null) {
    return (
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
  if (whose === undefined || whose === "grasp") {
    return <WhoseAnswer onPick={onWhose} />;
  }
  // Their own key: the block alone, Grasp's AI no longer offered beside it.
  return (
    <AiChoice
      ai={{
        ...ai,
        listing: {
          ...ai.listing,
          grasp: { ...ai.listing.grasp, available: false },
        },
      }}
      onReady={() => {
        go("about");
      }}
    />
  );
};

export const ChatConcept = ({
  step,
  admin,
  data,
  today,
  go,
  onward,
}: ConceptProps) => {
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
  const standing: Standing = {
    at,
    said,
    // Past the welcome, the language is the page's, whether or not it was said here.
    language: said.language ?? (at > 0 ? localeNames[locale] : undefined),
    ai,
    ready: ai === null || ai.ready,
    whose: said.ai ?? (graspOffered ? undefined : "own"),
  };
  const turns = useTurns(standing, admin, today);
  const last = turns.at(-1);
  const { on } = useVoice();
  useSay(last?.from === "stephen" ? last.text : "", { when: on, delay: 300 });

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
                <MessageScrollerItem messageId="host">
                  <div {...stylex.props(styles.host)}>
                    <StephenFigure size="md" />
                    <Text as="span" color="muted" size="sm">
                      {t`${interviewer}, your interviewer at Grasp`}
                    </Text>
                  </div>
                </MessageScrollerItem>
                {turns.map((turn, index) => (
                  <MessageScrollerItem
                    key={turn.id}
                    messageId={turn.id}
                    scrollAnchor={turn.from === "admin"}
                  >
                    {turn.from === "admin" ? (
                      <AdminTurn turn={turn} />
                    ) : (
                      <StephenTurn
                        first={turns[index - 1]?.from !== "stephen"}
                        turn={turn}
                      />
                    )}
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        <div {...stylex.props(styles.answer)}>
          <Answer
            go={go}
            onAsk={ask}
            onLanguage={(code) => {
              update({ ...said, language: localeNames[code] });
              void chooseLocale(code);
              go("ai");
            }}
            onWhose={(whose) => {
              update({ ...said, ai: whose });
              if (whose === "grasp") {
                void chooseGrasp();
              }
            }}
            standing={standing}
            step={step}
          />
        </div>
      </div>
    </ConceptFrame>
  );
};
