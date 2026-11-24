import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDetails,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  PromptInput,
  PromptInputBanner,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputVoice,
} from "@grasp-os/ui/components/prompt-input";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import { Text } from "@grasp-os/ui/components/text";
import {
  CheckIcon,
  ClockIcon,
  EyeIcon,
  Icon,
  LockIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { micLevel, reachMic, watchLevel } from "../mic.ts";
import type { Turn } from "./conversation.tsx";
import {
  checkAsk,
  checkHeard,
  fixture,
  ignore,
  languages,
  consentIn,
} from "./fixture.ts";
import type { LanguageId } from "./fixture.ts";

// CONCEPT ONLY: the screens before the conversation, and the ways out of
// it, for the three concepts, as few words as honestly do. A: one screen,
// who asks, three promises and the yes. B: the same and the yes, then a
// sound check that is the first answer. C: nothing but the language, and
// only when it can't be known; the consent is Stephen's first turn in the
// thread (consentTurn). "Not now" offers a time to be reminded; "I'd
// rather not" is said once more and taken.

const styles = stylex.create({
  // A page of its own, its column in the middle of its half, scrolled in its own room when the window is low.
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlock: { default: space["6"], [media.sm]: space["10"] },
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space["6"], [media.sm]: space["8"] },
    width: "100%",
    maxWidth: "28rem",
  },
  words: { display: "flex", flexDirection: "column", gap: space["3"] },
  asker: { display: "flex", alignItems: "center", gap: space["2"] },
  actions: { display: "flex", flexDirection: "column", gap: space["3"] },
  quiet: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space["2"],
  },
  heard: { display: "flex", alignItems: "center", gap: space["2"] },
  pair: { display: "flex", gap: space["2"] },
  grow: { flexGrow: 1 },
  // The list's rows keep their own inset: the list stands out by as much, so its words line up with the page's.
  flush: { marginInline: `calc(-1 * ${space["3"]})` },
});

/** The three promises, the same RECORDED words in every concept (fixture.ts `recordedConsents`), each with its mark. */
const marks = { yours: LockIcon, choose: EyeIcon, until: TrashIcon } as const;

/** The recorded consent in the language on screen, each promise with its mark. */
const useConsent = () => {
  const { i18n } = useLingui();
  const consent = consentIn(i18n.locale);
  return {
    ...consent,
    promises: consent.promises.map((promise) => ({
      ...promise,
      icon: marks[promise.id],
    })),
  };
};

/** The consent's line, as recorded, in the language on screen. */
const ConsentLine = () => <Text size="lg">{useConsent().line}</Text>;

/** C's promises in the consent block: the same recorded words. */
const ConsentDetails = () => (
  <ConfirmationDetails
    items={useConsent().promises.map(({ label, icon }) => ({ label, icon }))}
  />
);

const Promises = () => {
  const { promises, language } = useConsent();
  return (
    <ItemGroup aria-label="Your words" style={styles.flush}>
      {promises.map((promise) => (
        <Item key={promise.id} size="sm">
          <ItemMedia>
            <Icon icon={promise.icon} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              <span lang={language}>{promise.label}</span>
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};

/** A page of its own: one column in the middle of its room. */
const Page = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.page)}>
    <div {...stylex.props(styles.column)}>{children}</div>
  </div>
);

/** A page's title, and at most a line under it. */
const Words = ({
  over,
  title,
  line,
  children,
}: {
  over?: ReactNode;
  title: string;
  line?: string;
  /** In the line's place: a line of its own (the recorded consent's). */
  children?: ReactNode;
}) => (
  <div {...stylex.props(styles.words)}>
    {over}
    <Heading level={1} size="xl">
      {title}
    </Heading>
    {line === undefined ? null : <Text size="lg">{line}</Text>}
    {children}
  </div>
);

/** Who asks: the sponsor, by name. */
const Asker = () => (
  <div {...stylex.props(styles.asker)}>
    <Avatar decorative name={fixture.sponsor.name} size="xs">
      <AvatarFallback />
    </Avatar>
    <Text as="span" color="muted" size="sm">
      {`${fixture.sponsor.name} asked everyone at ${fixture.company}`}
    </Text>
  </div>
);

/** The quiet ways out under the yes. */
/** The yes, "Not now" beside it as the lesser of the two, and "I'd rather not" as words under them. */
const Answers = ({
  agree,
  onAgree,
  onNotNow,
  onRatherNot,
}: {
  agree: string;
  onAgree: () => void;
  onNotNow: () => void;
  onRatherNot: () => void;
}) => (
  <div {...stylex.props(styles.actions)}>
    <div {...stylex.props(styles.pair)}>
      <Button onClick={onAgree} size="lg" style={styles.grow}>
        {agree}
      </Button>
      <Button onClick={onNotNow} size="lg" variant="outline">
        Not now
      </Button>
    </div>
    <div {...stylex.props(styles.quiet)}>
      <Button onClick={onRatherNot} variant="link">
        I’d rather not
      </Button>
    </div>
  </div>
);

/** The consent of A and B: who asks, three promises, the yes and the ways out. */
export const Consent = ({
  title,
  agree,
  onAgree,
  onNotNow,
  onRatherNot,
}: {
  title: string;
  agree: string;
  onAgree: () => void;
  onNotNow: () => void;
  onRatherNot: () => void;
}) => (
  <Page>
    <Words over={<Asker />} title={title}>
      <ConsentLine />
    </Words>
    <Promises />
    <Answers
      agree={agree}
      onAgree={onAgree}
      onNotNow={onNotNow}
      onRatherNot={onRatherNot}
    />
  </Page>
);

/**
 * Once the microphone is there, "hears" the fixture’s sentence a word at a
 * time (`onWords`), then says it was heard; refused, says that. Until stopped.
 */
const hearCheck = (
  onWords: (words: string) => void,
  onDone: (state: "heard" | "refused") => void
): (() => void) => {
  let current = true;
  let timer = 0;
  const all = checkHeard.split(" ");
  const hear = (count: number): void => {
    timer = window.setTimeout(
      () => {
        if (!current) {
          return;
        }
        if (count > all.length) {
          onDone("heard");
          return;
        }
        onWords(all.slice(0, count).join(" "));
        hear(count + 1);
      },
      count === 1 ? 1400 : 180
    );
  };
  const begin = async (): Promise<void> => {
    const given = await reachMic();
    if (!current) {
      return;
    }
    if (given) {
      hear(1);
    } else {
      onDone("refused");
    }
  };
  void begin();
  const stopWatching = watchLevel(ignore);
  return () => {
    current = false;
    window.clearTimeout(timer);
    stopWatching();
  };
};

/** Hears the fixture’s sentence a word at a time once the microphone is there; refused, says so. */
const useCheck = (live: boolean, start: "listening" | "heard" | "refused") => {
  const [state, setState] = useState(start);
  const [words, setWords] = useState(start === "heard" ? checkHeard : "");
  useEffect(
    () =>
      live && state === "listening"
        ? hearCheck(setWords, (done) => {
            setState(done);
          })
        : undefined,
    [live, state]
  );
  return {
    state,
    words,
    retry: () => {
      setState("listening");
      setWords("");
    },
  };
};

/** The voice's level on the check: their microphone while it listens, still once heard. */
const checkLevel = (state: string, live: boolean): number => {
  if (state === "heard") {
    return 0;
  }
  return live ? micLevel() : 0.45;
};

/**
 * Concept B, step two: the sound check is the first answer. They say one
 * sentence, see it written as it is heard, and it opens the thread.
 */
export const SoundCheckB = ({
  live,
  start,
  onStart,
  onType,
}: {
  live: boolean;
  start: "listening" | "heard" | "refused";
  onStart: () => void;
  onType: () => void;
}) => {
  const { state, words, retry } = useCheck(live, start);
  const refused = state === "refused";
  return (
    <Page>
      <Words line="Your first answer, and my sound check." title={checkAsk} />
      <PromptInput aria-label="Your first answer">
        {refused ? (
          <PromptInputBanner
            action={
              <Button onClick={retry} size="xs" variant="outline">
                Try again
              </Button>
            }
            variant="warning"
          >
            The microphone is blocked.
          </PromptInputBanner>
        ) : null}
        {refused ? (
          <>
            <PromptInputBody>
              <PromptInputTextarea
                aria-label="Your first answer"
                placeholder="Your name and what you do"
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputSubmit />
            </PromptInputFooter>
          </>
        ) : (
          <PromptInputVoice
            interim={state === "heard" ? "" : words}
            onClose={onType}
            sample={() => ({ level: checkLevel(state, live) })}
          >
            {state === "heard" ? words : null}
          </PromptInputVoice>
        )}
      </PromptInput>
      <div {...stylex.props(styles.actions)}>
        {state === "heard" ? (
          <div {...stylex.props(styles.heard)}>
            <Icon icon={CheckIcon} />
            <Text color="default">I can hear you clearly.</Text>
          </div>
        ) : null}
        {refused ? (
          <Button onClick={onType} size="lg">
            Type instead
          </Button>
        ) : (
          <Button disabled={state !== "heard"} onClick={onStart} size="lg">
            Start the interview
          </Button>
        )}
        {refused ? null : (
          <div {...stylex.props(styles.quiet)}>
            <Button onClick={onType} variant="link">
              Type instead
            </Button>
          </div>
        )}
      </div>
    </Page>
  );
};

/** "Not now": when to be reminded, one press. */
export const NotNow = ({
  onPick,
  onBack,
}: {
  onPick: (when: string) => void;
  onBack: () => void;
}) => (
  <Page>
    <Words
      line={`Same link. Open until ${fixture.closes}.`}
      title="When suits you better?"
    />
    <ItemGroup aria-label="Remind me">
      {fixture.remindAt.map((each) => (
        <Item
          key={each.id}
          onClick={() => {
            onPick(each.when);
          }}
          variant="outline"
        >
          <ItemMedia>
            <Icon icon={ClockIcon} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{each.label}</ItemTitle>
            <ItemDescription>{each.when}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
    <div {...stylex.props(styles.quiet)}>
      <Button onClick={onBack} variant="link">
        Back
      </Button>
    </div>
  </Page>
);

/** "Not now" taken. */
export const Reminded = ({
  when,
  onStart,
}: {
  when: string;
  onStart: () => void;
}) => (
  <Page>
    <Words line="Nothing was recorded." title={`We’ll remind you ${when}`} />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onStart} variant="outline">
        Start now after all
      </Button>
    </div>
  </Page>
);

/** "I'd rather not": said once more, so a slip of the thumb isn't a no. */
export const RatherNot = ({
  onConfirm,
  onBack,
}: {
  onConfirm: () => void;
  onBack: () => void;
}) => (
  <Page>
    <Words
      line={`${fixture.sponsor.name} will see that you’re not taking part, never why. Nothing was recorded.`}
      title="Skip the interview?"
    />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onConfirm} size="lg">
        Yes, skip it
      </Button>
      <div {...stylex.props(styles.quiet)}>
        <Button onClick={onBack} variant="link">
          Back
        </Button>
      </div>
    </div>
  </Page>
);

/** "I'd rather not" taken. */
export const Declined = ({ onUndo }: { onUndo: () => void }) => (
  <Page>
    <Words
      line={`Changed your mind? This link works until ${fixture.closes}.`}
      title="Thanks for letting us know"
    />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onUndo} variant="outline">
        I changed my mind
      </Button>
    </div>
  </Page>
);

/** Stopped for now in the conversation: the place and the minutes are kept. */
export const Paused = ({
  minutesLeft,
  onCarryOn,
}: {
  minutesLeft: number;
  onCarryOn: () => void;
}) => (
  <Page>
    <Words
      line={`${minutesLeft} of your ${fixture.minutes} minutes are left. The clock waits too.`}
      title="Your place is kept"
    />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onCarryOn} size="lg">
        Carry on
      </Button>
    </div>
  </Page>
);

/** Concept C, only when neither the browser nor the company says: the language first. */
export const LanguageFirst = ({
  onPick,
}: {
  onPick: (language: LanguageId) => void;
}) => (
  <Page>
    <Words title="Which language?" />
    <ItemGroup aria-label="Languages">
      {languages.map((each) => (
        <Item
          key={each.id}
          onClick={() => {
            onPick(each.id);
          }}
          variant="outline"
        >
          <ItemContent>
            <ItemTitle>
              <span lang={each.id}>{each.name}</span>
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  </Page>
);

/** How C's question was answered, if it was. */
export type ConsentAnswer = "yes" | "not-now" | "rather-not" | null;

/** Concept C: Stephen's first words in the thread say who asks, and ask for a yes. */
export const consentText = `Hi ${fixture.person}, I’m ${fixture.interviewer}, an AI interviewer from Grasp. ${fixture.sponsor.name} asked everyone at ${fixture.company} to tell me how their work really goes. **${fixture.minutes} minutes at most**, and I keep time.`;

export const consentTurn = (
  answer: ConsentAnswer,
  onAnswer: (answer: Exclude<ConsentAnswer, null>) => void
): Turn => ({
  id: "consent",
  from: "stephen",
  text: consentText,
  extra: (
    <Confirmation
      approval={
        answer === null
          ? { id: "consent" }
          : { id: "consent", approved: answer === "yes" }
      }
      state={answer === null ? "approval-requested" : "approval-responded"}
    >
      <ConfirmationTitle>
        <ConfirmationRequest>Shall we start?</ConfirmationRequest>
        <ConfirmationAccepted>You agreed.</ConfirmationAccepted>
        <ConfirmationRejected>
          {answer === "not-now" ? "Not now." : "You’d rather not."}
        </ConfirmationRejected>
      </ConfirmationTitle>
      <ConsentDetails />
      <ConfirmationActions>
        <ConfirmationAction
          onClick={() => {
            onAnswer("not-now");
          }}
          variant="outline"
        >
          Not now
        </ConfirmationAction>
        <ConfirmationAction
          onClick={() => {
            onAnswer("yes");
          }}
        >
          Yes, let’s start
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  ),
});

/** Concept C's "Not now": Stephen asks when, in the thread. */
export const remindTurn = (
  picked: string | null,
  onPick: (when: string) => void
): Turn => ({
  id: "remind",
  from: "stephen",
  text: "Of course. When shall I remind you?",
  extra: (
    <Questionnaire
      onSubmit={(answers) => {
        const value = answers.when?.values[0];
        const chosen = fixture.remindAt.find((each) => each.id === value);
        if (chosen !== undefined) {
          onPick(chosen.when);
        }
      }}
    >
      <QuestionnaireItem name="when">
        <QuestionnaireTitle>Remind me</QuestionnaireTitle>
        <QuestionnaireChoices>
          {fixture.remindAt.map((each) => (
            <QuestionnaireChoice key={each.id} value={each.id}>
              {`${each.label}, ${each.when}`}
            </QuestionnaireChoice>
          ))}
        </QuestionnaireChoices>
      </QuestionnaireItem>
      {picked === null ? (
        <QuestionnaireActions>
          <QuestionnaireSubmit />
        </QuestionnaireActions>
      ) : null}
    </Questionnaire>
  ),
});
