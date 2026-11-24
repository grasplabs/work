import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { StepperNav } from "@grasp-os/ui/components/stepper";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { chooseLocale, isLocale, localeNames } from "../../i18n.ts";
import { narrationOf } from "../../voice/timing.ts";
import { stopSpeaking, useSay, useVoice } from "../../voice/voice.ts";
import { AiChoice } from "./ai-choice.tsx";
import type { ConceptProps, ConceptStep } from "./concept-props.ts";
import { ConceptFrame, wholeSetup } from "./frame.tsx";
import { PlanBody } from "./plan.tsx";
import { SaidWords } from "./said-words.tsx";
import { SoundToggle } from "./sound-toggle.tsx";
import { interviewer, StephenFigure, StephenMark } from "./stephen.tsx";

// Concepts B and C of the setup's first three steps. B, "calm steps": one
// topic a screen, a short title, at most two sentences, the form, and the
// flow's foot (the library's StepperNav: Back, and Next as the one
// button); the interviewer a small mark and a name, never a narrator; no
// speech. C, "Steps, Stephen speaks": B's screens, with each step's title
// and sentence said aloud as it arrives, the sentence lighting up word by
// word as it is said, and the sound one toggle in the bar.

const styles = stylex.create({
  step: { display: "grid", gap: space[8] },
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
      {speaks ? <StephenFigure /> : <StephenMark />}
      <Heading level={1}>{title}</Heading>
      {speaks ? (
        <p aria-live="polite">
          <SaidWords from={from} line={line} text={sentence} />
        </p>
      ) : (
        <Text color="muted" size="lg">
          {sentence}
        </Text>
      )}
    </div>
  );
};

/** One step: its head, its form, and the flow's foot. */
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

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

const Welcome = ({ admin, speaks, onNext }: StepBodyProps) => {
  const { t, i18n } = useLingui();
  const [picked, setPicked] = useState(languagePicked);
  return (
    <Step
      nav={
        <StepperNav
          disabled={!picked}
          disabledReason={t`Choose a language`}
          finishText={t`Start`}
          onNext={onNext}
          step={0}
          total={wholeSetup.length}
        />
      }
      sentence={t`I set up Grasp with you, in about 8 minutes. First, which language suits you?`}
      speaks={speaks}
      title={t`Hi ${admin}, I’m Stephen`}
    >
      <Field>
        <FieldLabel>{t`Language`}</FieldLabel>
        <RadioGroup
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              setPicked(true);
              languagePicked = true;
              void chooseLocale(value);
            }
          }}
          value={picked ? i18n.locale : null}
        >
          {languages.map(({ code, name }) => (
            <Field key={code} orientation="horizontal">
              <RadioGroupItem value={code} />
              <FieldLabel>
                <span lang={code}>{name}</span>
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </Field>
    </Step>
  );
};

const Ai = ({ data, speaks, onNext, onBack }: StepBodyProps) => {
  const { t } = useLingui();
  const ready = data.ai === null || data.ai.ready;
  return (
    <Step
      nav={
        <StepperNav
          disabled={!ready}
          disabledReason={t`Choose your AI first`}
          onBack={onBack}
          onNext={onNext}
          step={1}
          total={wholeSetup.length}
        />
      }
      sentence={t`Everything I read and say runs on an AI model. Use Grasp’s AI, or a key of your own.`}
      speaks={speaks}
      title={t`Which AI should I think with?`}
    >
      <AiChoice ai={data.ai} onReady={onNext} />
    </Step>
  );
};

const Plan = ({ speaks, onNext, onBack, today }: StepBodyProps) => {
  const { t } = useLingui();
  return (
    <Step
      nav={
        <StepperNav
          onBack={onBack}
          onNext={onNext}
          step={2}
          total={wholeSetup.length}
        />
      }
      sentence={t`One week of short talks with your team, then you get what I learned. Below, what one answer gives me.`}
      speaks={speaks}
      title={t`Here’s the plan`}
    >
      <PlanBody interviewer={interviewer} today={today} />
    </Step>
  );
};

interface StepBodyProps {
  admin: string;
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
}: ConceptProps & { speaks: boolean }) => {
  const order: ConceptStep[] = ["welcome", "ai", "about"];
  const index = order.indexOf(step);
  const Body = bodies[step];
  const next = order[index + 1];
  const back = order[index - 1];
  return (
    <ConceptFrame
      language={step !== "welcome"}
      onGo={(to) => {
        if (to === "welcome" || to === "ai" || to === "about") {
          go(to);
        }
      }}
      reached={(["welcome", "ai", "about"] as const).indexOf(step)}
      step={step}
      tools={speaks ? <SoundToggle /> : null}
    >
      <Body
        admin={admin}
        data={data}
        key={step}
        onBack={() => {
          if (back !== undefined) {
            go(back);
          }
        }}
        onNext={() => {
          if (next === undefined) {
            onward();
          } else {
            go(next);
          }
        }}
        speaks={speaks}
        today={today}
      />
    </ConceptFrame>
  );
};
