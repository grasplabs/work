import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { chooseLocale, isLocale } from "../../i18n.ts";
import { narrationOf } from "../../voice/timing.ts";
import { stopSpeaking, useSay, useVoice } from "../../voice/voice.ts";
import { AiChoice } from "./ai-choice.tsx";
import type { ConceptProps, ConceptStep } from "./concept-props.ts";
import { ConceptFrame, wholeSetup } from "./frame.tsx";
import { LanguageCards } from "./language-cards.tsx";
import { PlanBody } from "./plan.tsx";
import { SaidWords } from "./said-words.tsx";
import { SoundToggle } from "./sound-toggle.tsx";
import { interviewer, StephenFigure } from "./stephen.tsx";

// Concepts B and C of the setup's first three steps. B, "calm steps": one
// topic a screen, a serif title, at most two sentences, the form, and one
// real button that says what it does, with Back beside it; two text styles
// a screen; the interviewer only in the welcome's title; no speech. The
// welcome has no foot at all: a card press chooses and goes on. After it,
// the library's StepperNav bar at the top carries Back, how far along and
// Next, and the step ends in its own real button. C, "Steps, Stephen speaks": B's
// screens, with each step's title and sentence said aloud as it arrives,
// the sentence lighting up word by word as it is said, his figure small
// above it, and the sound one toggle in the bar.

const styles = stylex.create({
  step: { display: "grid", gap: space[8] },
  // The one way on, at full size, as wide as a comfortable reach.
  onward: { justifySelf: "start", minWidth: "12rem" },
  head: { display: "grid", gap: space[3] },
});

/** A step's title and sentence; said aloud and lit up as said, where it `speaks`. */
const StepHead = ({
  title,
  sentence,
  speaks,
}: {
  title: string;
  sentence: string;
  speaks: boolean;
}) => {
  const { line, from } = narrationOf(title, sentence);
  const { on } = useVoice();
  useSay(line, { when: speaks && on, delay: 300 });
  // Leaving the step, what was said of it stops.
  useEffect(
    () => () => {
      stopSpeaking();
    },
    []
  );
  return (
    <div {...stylex.props(styles.head)}>
      {speaks ? <StephenFigure size="sm" /> : null}
      <Heading level={1}>{title}</Heading>
      {speaks ? (
        <p aria-live="polite">
          <SaidWords from={from} line={line} size="default" text={sentence} />
        </p>
      ) : (
        <Text>{sentence}</Text>
      )}
    </div>
  );
};

/** The end of a later step, once it can go on: its own button, saying what it does. */
const End = ({ onNext }: { onNext: () => void }) => {
  const { t } = useLingui();
  return (
    <Button onClick={onNext} size="lg" style={styles.onward}>
      {t`Continue`}
    </Button>
  );
};

/** One step: its head, its form, and its end. */
const Step = ({
  title,
  sentence,
  speaks,
  children,
  nav,
}: {
  title: string;
  sentence: string;
  speaks: boolean;
  children: ReactNode;
  nav: ReactNode;
}) => (
  <section {...stylex.props(styles.step)}>
    <StepHead sentence={sentence} speaks={speaks} title={title} />
    {children}
    {nav}
  </section>
);

/** A language other than the page's was picked a moment ago: the page drawn anew in it knows. */
let languagePicked = false;

const Welcome = ({ admin, speaks, onNext, cards }: StepBodyProps) => {
  const { t, i18n } = useLingui();
  const [picked, setPicked] = useState(languagePicked);
  return (
    <Step
      nav={null}
      sentence={t`I’ll set up Grasp with you, one step at a time. Which language would you like?`}
      speaks={speaks}
      title={admin === "" ? t`Hi, I’m Stephen` : t`Hi ${admin}, I’m Stephen`}
    >
      {/* No foot: a press on a card chooses it and goes on. Coming back, the language in use is marked. */}
      <LanguageCards
        chosen={picked && isLocale(i18n.locale) ? i18n.locale : null}
        look={cards}
        onPick={(locale) => {
          setPicked(true);
          languagePicked = true;
          void (async () => {
            await chooseLocale(locale);
            onNext();
          })();
        }}
      />
    </Step>
  );
};

const Ai = ({ data, speaks, onNext }: StepBodyProps) => {
  const { t } = useLingui();
  const ready = data.ai === null || data.ai.ready;
  return (
    <Step
      nav={
        // Until a model answers, the choice above is the way on; then one Continue.
        ready ? <End onNext={onNext} /> : null
      }
      sentence={t`Everything I read and say runs on it. Grasp’s AI works right away, or you can use your own key.`}
      speaks={speaks}
      title={t`Which AI should I use?`}
    >
      <AiChoice ai={data.ai} onReady={onNext} />
    </Step>
  );
};

const Plan = ({ speaks, onNext, today }: StepBodyProps) => {
  const { t } = useLingui();
  return (
    <Step
      nav={<End onNext={onNext} />}
      sentence={t`I talk with your team for one week. Then you get what I learned, team by team.`}
      speaks={speaks}
      title={t`Here’s the plan`}
    >
      <PlanBody interviewer={interviewer} today={today} />
    </Step>
  );
};

interface StepBodyProps {
  admin: string;
  cards: ConceptProps["cards"];
  data: ConceptProps["data"];
  speaks: boolean;
  today: Date;
  onNext: () => void;
  onBack: () => void;
}

const bodies = { welcome: Welcome, ai: Ai, about: Plan } as const;

export const StepsConcept = ({
  speaks,
  step,
  admin,
  data,
  today,
  go,
  onward,
  cards,
}: ConceptProps & { speaks: boolean }) => {
  const order: ConceptStep[] = ["welcome", "ai", "about"];
  const index = order.indexOf(step);
  const { t } = useLingui();
  const Body = bodies[step];
  const next = order[index + 1];
  const back = order[index - 1];
  const onBack = () => {
    if (back !== undefined) {
      go(back);
    }
  };
  const onNext = () => {
    if (next === undefined) {
      onward();
    } else {
      go(next);
    }
  };
  // The AI step waits on a model that answers; the others can always go on.
  const canGoOn = step !== "ai" || data.ai === null || data.ai.ready;
  return (
    <ConceptFrame
      along={
        step === "welcome"
          ? undefined
          : {
              at: wholeSetup.indexOf(step),
              onBack,
              ...(canGoOn ? { onNext } : { waiting: t`Choose an AI first` }),
            }
      }
      language={step !== "welcome"}
      tools={speaks ? <SoundToggle /> : null}
      wide={step === "welcome" ? "widest" : false}
    >
      <Body
        admin={admin}
        cards={cards}
        data={data}
        key={step}
        onBack={onBack}
        onNext={onNext}
        speaks={speaks}
        today={today}
      />
    </ConceptFrame>
  );
};
