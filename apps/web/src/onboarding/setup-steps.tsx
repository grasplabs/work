import type { Difference, SettleChoice } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { ArrowRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ComponentType } from "react";

import { ErrorText } from "../error-text.tsx";
import { chooseLocale, isLocale } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { speak } from "../voice/voice.ts";
import { AiChoice, firstWay, useChooseGrasp } from "./ai-choice.tsx";
import type { AiWay } from "./ai-choice.tsx";
import { CalmStep } from "./calm-frame.tsx";
import { CompanyStep } from "./company-step.tsx";
import { DocumentsStep } from "./documents-step.tsx";
import { ForgetKickoff } from "./forget-kickoff.tsx";
import { handOver } from "./hand-over.ts";
import { LanguageCards } from "./language-cards.tsx";
import { LeadsStep } from "./leads-step.tsx";
import { PlanStory } from "./plan-story.tsx";
import { DifferenceItem, MailToLetThrough } from "./review-parts.tsx";
import { afterAi, openItems } from "./setup.ts";
import type { SetupStep } from "./setup.ts";
import { smoothly } from "./smoothly.ts";
import { SourcesStep } from "./sources-step.tsx";
import { mailToLetThrough, useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
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
 * The welcome: the language, chosen from five cards; a press chooses it
 * and goes on. Coming back, the language in use is marked. The admin can
 * also forget the kickoff here, the first conversation Grasp had.
 */
const Welcome = ({ data, onward }: StepProps) => {
  const { t, i18n } = useLingui();
  const refresh = useRefresh();
  const [picked, setPicked] = useState(languagePicked);
  const { admin } = data;
  return (
    <CalmStep
      body={t`I’ll set up Grasp with you, one step at a time. Which language would you like?`}
      centred
      spoken={
        admin === ""
          ? t`Hi, I’m Stephen. Over the next few minutes we’ll set up Grasp together, and I’ll walk you through every part as we go. First things first: which language shall we talk in?`
          : t`Hi ${admin}, I’m Stephen. Over the next few minutes we’ll set up Grasp together, and I’ll walk you through every part as we go. First things first: which language shall we talk in?`
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
  // Ours, once core has it chosen; their own key already in use goes straight on.
  const onContinue = async () => {
    const onOurs = ready && ai?.listing.source === "grasp";
    if (way === "grasp" && !onOurs && !(await grasp.choose())) {
      return;
    }
    onReady();
  };
  const why = t`Everything Grasp does runs on AI, from reading your documents to every interview.`;
  let body = `${why} ${t`Paste a key from your provider to connect it. You pay them directly.`}`;
  // What Stephen tells about it, as a tutor would: why it's asked, then what to do.
  const because = t`Good, that’s settled. Before we really start, one thing: everything in Grasp runs on AI. Reading your documents, the interviews, the plan, all of it. So we need an AI attached to get it working.`;
  let spoken = `${because} ${t`Paste a key from your company’s provider here. You pay them directly, and I’ll check that it works.`}`;
  if (ready && ai?.listing.source === "grasp") {
    body = `${why} ${t`You’re on our own system, and it’s ready.`}`;
    spoken = `${because} ${t`You’re already on our own system, and it works, so just press Continue.`}`;
  } else if (ready && ai !== null) {
    body = `${why} ${t`Your own key works, and it’s ready.`}`;
    spoken = `${because} ${t`Your own key works, so just press Continue.`}`;
  } else if (graspOffered) {
    body = `${why} ${t`Use our own system and you’re set, or connect a provider of your own.`}`;
    spoken = `${because} ${t`The simplest is our own system: leave it chosen and press Continue, and you’re ready. If your company already works with a provider like OpenAI or Mistral, choose your own key and paste it instead.`}`;
  } else if (ai === null) {
    // Core couldn't say: no providers are shown, so nothing is asked of them here.
    body = `${why} ${t`You can set it up later in Settings.`}`;
    spoken = `${because} ${t`Don’t let it hold you up, you can set it up later in Settings.`}`;
  }
  const canContinue = ready || (way === "grasp" && graspOffered);
  return (
    <CalmStep
      body={body}
      end={
        canContinue ? (
          <Button
            disabled={grasp.busy}
            onClick={() => {
              void onContinue();
            }}
            size="lg"
            status={grasp.busy ? "loading" : "idle"}
          >
            {t`Continue`}
          </Button>
        ) : null
      }
      spoken={spoken}
      title={t`Grasp needs an AI to work`}
    >
      <AiChoice ai={ai} onReady={onReady} onWay={setWay} way={way} />
      <ErrorText>{grasp.failure}</ErrorText>
    </CalmStep>
  );
};

/** The plan: told as a small story, then their campaign as plain rows (plan-story.tsx). */
const About = ({ onward, today }: StepProps) => (
  <PlanStory onward={onward} today={today} />
);

/** The steps people told two ways and nobody could explain, each settled in core. `changing` are the settled ones decided again. */
const Differences = ({
  differences,
  changing,
  onChanging,
}: {
  differences: Difference[];
  changing: string[];
  onChanging: (changing: string[]) => void;
}) => {
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  const settle = async (work: string, holds: SettleChoice) => {
    if (busy) {
      return;
    }
    const settled = await run(async (session) => {
      await session.onboarding.settle(work, holds);
      await refresh();
      return true;
    });
    if (settled === true) {
      onChanging(changing.filter((each) => each !== work));
    }
  };
  return (
    <>
      <ErrorText>{failure}</ErrorText>
      {differences.map((difference) => (
        <DifferenceItem
          difference={difference}
          key={difference.work}
          onReopen={() => {
            onChanging([...changing, difference.work]);
          }}
          onSettle={(holds) => {
            void settle(difference.work, holds);
          }}
          open={changing.includes(difference.work)}
        />
      ))}
    </>
  );
};

/**
 * What only the admin can settle, each with a way to settle it. Nothing
 * moves on by itself: they read what they settled, and go on once nothing
 * is open.
 */
const Review = (props: StepProps) => {
  const { t } = useLingui();
  const [changing, setChanging] = useState<string[]>([]);
  const { differences } = props.data.review;
  const mail = openItems(props.settled, mailToLetThrough(props.data)).length;
  const open =
    mail +
    differences.filter(
      ({ work, holds }) => holds === null || changing.includes(work)
    ).length;
  return (
    <CalmStep
      body={t`I’ve handled everything else.`}
      end={
        open === 0 ? (
          <Button
            onClick={() => {
              void props.onward();
            }}
            size="lg"
          >
            {t`Continue`}
            <Icon icon={ArrowRightIcon} />
          </Button>
        ) : null
      }
      spoken={plural(open, {
        0: "I’ve been through all the conversations now, and I’ve handled everything I could. Nothing needs you here.",
        1: "I’ve been through all the conversations now, and I’ve handled almost everything myself. There’s just one thing I’d like you to decide.",
        other:
          "I’ve been through all the conversations now, and I’ve handled most of it myself. There are # things I’d like you to decide.",
      })}
      title={plural(open, {
        0: "Nothing needs you",
        1: "Just one thing for you",
        other: "# things for you",
      })}
    >
      <section aria-label={t`What needs you`} {...stylex.props(styles.stack)}>
        {differences.length === 0 ? null : (
          <Differences
            changing={changing}
            differences={differences}
            onChanging={setChanging}
          />
        )}
        <MailToLetThrough
          data={props.data}
          onSettle={props.onSettle}
          settled={props.settled}
        />
      </section>
    </CalmStep>
  );
};

/** How often the last step asks core again whether Grasp gave its go. */
const goCheckMs = 15_000;

/**
 * The end of the setup: who Stephen talked with and how much of the work
 * is mapped. Until Grasp gives its go, that it opens once it has checked
 * everything with the admin, asking core again now and then; after, the
 * way in.
 */
const Open = ({ data, onward }: StepProps) => {
  const { t } = useLingui();
  const refresh = useRefresh();
  const { open } = data.gate;
  const { progress } = data.view;
  const talked = (progress?.talked ?? 0) + (progress?.leadsTalked ?? 0);
  const { mapped } = data.review;
  const { admin } = data;
  useEffect(() => {
    if (open) {
      return () => {
        // Nothing to ask.
      };
    }
    const id = window.setInterval(() => {
      void refresh();
    }, goCheckMs);
    return () => {
      window.clearInterval(id);
    };
  }, [open, refresh]);
  const said = plural(talked, {
    one: "I talked with # person.",
    other: "I talked with # people.",
  });
  const ready =
    mapped === 0
      ? ""
      : plural(mapped, {
          one: "One piece of work is mapped and ready for you.",
          other: "# pieces of work are mapped and ready for you.",
        });
  const opens = open
    ? ""
    : t`We open your platform once we’ve checked everything with you. You’ll hear from us.`;
  return (
    <CalmStep
      body={[said, ready, opens].filter((each) => each !== "").join(" ")}
      end={
        open ? (
          <Button
            onClick={(event) => {
              // He says it as he does it, then hands them over to the platform.
              speak(t`Here’s your Grasp.`);
              void handOver(event.currentTarget, onward);
            }}
            size="lg"
          >
            {t`Open Grasp`}
          </Button>
        ) : null
      }
      spoken={[
        t`That’s it from me. Thank you, ${admin}.`,
        said,
        ready,
        open
          ? t`Your Grasp is ready whenever you are.`
          : t`Before we open it, we check everything with you once more. You’ll hear from us.`,
      ]
        .filter((each) => each !== "")
        .join(" ")}
      title={t`Thank you, ${admin}`}
    />
  );
};

/** One screen per step. The campaign page stands in for `listening` (routes/setup.tsx). */
const bodies: Record<
  Exclude<SetupStep, "pulse" | "listening">,
  ComponentType<StepProps>
> = {
  welcome: Welcome,
  ai: Ai,
  about: About,
  company: CompanyStep,
  sources: SourcesStep,
  documents: DocumentsStep,
  leads: LeadsStep,
  team: TeamStep,
  review: Review,
  open: Open,
};

export const SetupStepBody = ({
  step,
  ...props
}: StepProps & { step: Exclude<SetupStep, "pulse" | "listening"> }) => {
  const Body = bodies[step];
  return <Body {...props} />;
};
