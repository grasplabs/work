import { Button } from "@grasp-os/ui/components/button";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ComponentType } from "react";

import { TopError } from "../frame/top-error.tsx";
import { chooseLocale, isLocale } from "../i18n.ts";
import { AiChoice, aiKeyForm, firstWay, useChooseGrasp } from "./ai-choice.tsx";
import type { AiWay } from "./ai-choice.tsx";
import { CalmStep } from "./calm-frame.tsx";
import { CompanyStep } from "./company-step.tsx";
import { DocumentsStep } from "./documents-step.tsx";
import { ForgetKickoff } from "./forget-kickoff.tsx";
import { LanguageCards } from "./language-cards.tsx";
import { LeadsStep } from "./leads-step.tsx";
import { PlanStory } from "./plan-story.tsx";
import { afterAi } from "./setup.ts";
import type { SetupStep } from "./setup.ts";
import { smoothly } from "./smoothly.ts";
import { SourcesStep } from "./sources-step.tsx";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { useAnswer, useLeaving } from "./step-voice.tsx";
import { TeamStep } from "./team-step.tsx";

export type { SetupData, StepProps } from "./step-parts.ts";
export { directoryProblemOf } from "./company-step.tsx";

// One screen of the setup, by step, in the calm frame (calm-frame.tsx):
// a serif title in Stephen's voice, one line, the step's own content and
// its own button. What a step keeps goes to core: who works where, who
// leads which team and which teams take part, the documents and the
// answers to their questions, what the admin chose about what Grasp may
// connect, and when the interviews run. What needs the admin: the steps
// people told two ways and nobody could explain, settled in core, and
// letting Grasp's mail through, which this browser keeps.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
});

/** A language other than the page's was picked a moment ago: the page drawn anew in it knows. */
let languagePicked = false;

/**
 * What Stephen says of the language as the next step arrives, in the
 * language just chosen: each language's words name that language.
 */
const talkingIn = msg({
  message: "Great, we’ll continue in English.",
  comment:
    "Stephen, as the next step arrives, in the language just chosen. Name your own language, not English: in Dutch “Helder, dan gaan we verder in het Nederlands.”",
});

/** What Stephen says of the AI chosen, as the next step arrives. */
const aiChosen = {
  grasp: msg`Great, we’re using our built-in system. The AI is ready.`,
  own: msg`Your API key is working. The AI is ready.`,
};

/** What Stephen answers as the admin picks their own key. */
const ownKey = msg`Sure—paste your key and I’ll check that it works.`;

/**
 * The welcome: the language, chosen from five cards; a press chooses it
 * and goes on. Coming back, the language in use is marked. The admin can
 * also forget the kickoff here, the first conversation Grasp had.
 */
const Welcome = ({ data, onward }: StepProps) => {
  const { t, i18n } = useLingui();
  const refresh = useRefresh();
  const [picked, setPicked] = useState(languagePicked);
  const { admin } = data;
  useLeaving(talkingIn);
  return (
    <CalmStep
      body={t`I’ll guide you through setting up Grasp, step by step. Which language do you speak?`}
      centred
      spoken={
        admin === ""
          ? t`Hi, I’m Stephen. I’ll guide you through setting up Grasp—it only takes a few minutes. To start, which language do you speak?`
          : t`Hi ${admin}, I’m Stephen. I’ll guide you through setting up Grasp—it only takes a few minutes. To start, which language do you speak?`
      }
      title={admin === "" ? t`Hi, I’m Stephen` : t`Hi ${admin}, I’m Stephen`}
    >
      <div {...stylex.props(styles.stack)}>
        <LanguageCards
          chosen={picked && isLocale(i18n.locale) ? i18n.locale : null}
          onPick={(locale) => {
            // The language and the next screen arrive together, in one quiet fade.
            void smoothly(async () => {
              setPicked(true);
              languagePicked = true;
              await chooseLocale(locale);
              await onward();
            });
          }}
        />
        <ForgetKickoff kickoff={data.view.kickoff} onForgotten={refresh} />
      </div>
    </CalmStep>
  );
};

/**
 * The AI Grasp runs on, said plainly: nothing works without one (Ruben:
 * "which AI should we use" was too vague). Our own system is the first
 * way and Continue takes it in one press; a key of their own is the
 * other. Until a model answers on their own key, the key block's own
 * button is the way on.
 */
const Ai = ({ data, askedFor, path, go, onward }: StepProps) => {
  const { t } = useLingui();
  const { ai } = data;
  const [way, setWay] = useState<AiWay>(() => firstWay(ai));
  const answer = useAnswer([ownKey]);
  // Left with a way that works: our own system, or a key of their own that answered (the setup
  // holds them here until one does). Core couldn't say: nothing to answer.
  useLeaving(ai === null ? null : aiChosen[way]);
  const grasp = useChooseGrasp();
  const ready = ai === null || ai.ready;
  const graspOffered = ai?.listing.grasp.available === true;
  // On to the step they asked for, for an admin the setup held here on the way; else the next.
  const onReady = () => {
    const next = afterAi(askedFor, path);
    if (next === undefined) {
      void onward();
    } else {
      go(next);
    }
  };
  const [connecting, setConnecting] = useState(false);
  // Ours, once core has it chosen. Their own: a key in the form is sent (the
  // block tests it, and goes on once it answers); else a key already in use goes on.
  const onContinue = async () => {
    if (way === "own") {
      const form = document.querySelector(`#${aiKeyForm}`);
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
      } else if (ready) {
        onReady();
      }
      return;
    }
    const onOurs = ready && ai?.listing.source === "grasp";
    if (!onOurs && !(await grasp.choose())) {
      return;
    }
    onReady();
  };
  const why = t`Everything Grasp does runs on AI—from reading documents to running interviews.`;
  let body = `${why} ${t`Paste an API key from your provider to connect. You pay them directly.`}`;
  // What Stephen tells about it, as a tutor would: why it's asked, then the
  // choice as it stands on the screen, neither way pressed on them (Ruben:
  // "je moet mensen wel gewoon de keuze altijd geven").
  // Of the language just picked, he has already said a word as the step arrived (talkingIn).
  const because = t`Everything I do—reading your documents, running the interviews, and putting together the plan—runs on AI.`;
  let spoken = `${because} ${t`Paste a key from your company’s provider here. You pay them directly, and I’ll check that it works.`}`;
  if (graspOffered) {
    body = `${why} ${t`Use our built-in setup, or connect your own API key.`}`;
    spoken = `${because} ${t`The fastest way is to use our built-in setup; it’s ready right away. If your company prefers its own provider, you can enter your API key here instead.`}`;
  } else if (ready && ai !== null) {
    body = `${why} ${t`Your API key is connected and ready.`}`;
    spoken = `${because} ${t`Your own key is connected and works. You can keep it, or change it here.`}`;
  } else if (ai === null) {
    // Core couldn't say: no providers are shown, so nothing is asked of them here.
    body = `${why} ${t`You can also set this up later in Settings.`}`;
    spoken = `${because} ${t`Don’t let it hold you up, you can set it up later in Settings.`}`;
  }
  const canContinue = ready || way === "own" || graspOffered;
  const busy = grasp.busy || connecting;
  return (
    <CalmStep
      body={body}
      end={
        canContinue ? (
          <Button
            disabled={busy}
            onClick={() => {
              void onContinue();
            }}
            size="lg"
            status={busy ? "loading" : "idle"}
          >
            {t`Continue`}
          </Button>
        ) : null
      }
      spoken={spoken}
      title={t`Choose your AI`}
    >
      <AiChoice
        ai={ai}
        onConnecting={setConnecting}
        onReady={onReady}
        onWay={(next) => {
          if (next === "own" && way !== "own") {
            answer(ownKey);
          }
          setWay(next);
        }}
        way={way}
      />
      <TopError>{grasp.failure}</TopError>
    </CalmStep>
  );
};

/**
 * The setup's last screen: what happens next, told as a small story with
 * what the admin just chose in it, and from there into the platform
 * (plan-story.tsx).
 */
const About = ({ data, onward }: StepProps) => (
  <PlanStory data={data} onward={onward} />
);

/**
 * The screens that are steps on the way: the page the interviews are
 * watched on has its own frame (campaign/campaign-page.tsx), and the
 * review and the way in are no longer shown.
 */
export type ShownStep = Exclude<SetupStep, "listening" | "review" | "open">;

/** One screen per step. */
const bodies: Record<ShownStep, ComponentType<StepProps>> = {
  welcome: Welcome,
  ai: Ai,
  about: About,
  company: CompanyStep,
  sources: SourcesStep,
  documents: DocumentsStep,
  leads: LeadsStep,
  team: TeamStep,
};

export const SetupStepBody = ({
  step,
  ...props
}: StepProps & { step: ShownStep }) => {
  const Body = bodies[step];
  return <Body {...props} />;
};
