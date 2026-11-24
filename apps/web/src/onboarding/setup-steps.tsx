import type { Difference, SettleChoice } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ComponentType } from "react";

import { AgentFigure } from "../agents/figure/agent-figure.tsx";
import { stephensLook } from "../agents/figure/look.ts";
import { ErrorText } from "../error-text.tsx";
import { chooseLocale, isLocale } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { AiChoice } from "./ai-choice.tsx";
import { CalmStep } from "./calm-frame.tsx";
import { CompanyStep } from "./company-step.tsx";
import { DocumentsStep } from "./documents-step.tsx";
import type { CarryStyle } from "./field/engine.ts";
import { useField } from "./field/stephen-field.tsx";
import { flags } from "./flags.ts";
import { ForgetKickoff } from "./forget-kickoff.tsx";
import { LanguageCards } from "./language-cards.tsx";
import { LeadsStep } from "./leads-step.tsx";
import { PlanBody } from "./plan.tsx";
import { DifferenceItem, MailToLetThrough } from "./review-parts.tsx";
import { afterAi, openItems } from "./setup.ts";
import type { SetupStep } from "./setup.ts";
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

/**
 * Concepts only, for Ruben to compare, until he picks one: how Stephen
 * carries the page on from the welcome, `?carry=a|b|c` on the address.
 */
const carryStyle = (): CarryStyle => {
  const asked = new URLSearchParams(window.location.search).get("carry");
  if (asked === "b") {
    return "reading";
  }
  return asked === "c" ? "wave" : "flag";
};

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
  const field = useField();
  const { admin } = data;
  return (
    <CalmStep
      body={t`I’ll set up Grasp with you, one step at a time. Which language would you like?`}
      centred
      title={admin === "" ? t`Hi, I’m Stephen` : t`Hi ${admin}, I’m Stephen`}
    >
      <div {...stylex.props(styles.stack)}>
        <LanguageCards
          chosen={picked && isLocale(i18n.locale) ? i18n.locale : null}
          onPick={(locale, card) => {
            // Stephen takes the flag from the card and carries the page to its next screen.
            void field.carry(
              card,
              flags[locale],
              async () => {
                setPicked(true);
                languagePicked = true;
                await chooseLocale(locale);
                await onward();
              },
              carryStyle()
            );
          }}
        />
        <ForgetKickoff kickoff={data.view.kickoff} onForgotten={refresh} />
      </div>
    </CalmStep>
  );
};

/**
 * Which AI Grasp thinks with, on the organization's own key or Grasp's
 * own where this deployment offers it. Until a model answers, the choice
 * itself is the way on; once one does, Continue.
 */
const Ai = ({ data, furthest, path, go, onward }: StepProps) => {
  const { t } = useLingui();
  const { ai } = data;
  const ready = ai === null || ai.ready;
  const graspOffered = ai?.listing.grasp.available === true;
  // Back to where they were, for an admin sent back here; else on.
  const onReady = () => {
    const next = afterAi(furthest, path);
    if (next === undefined) {
      void onward();
    } else {
      go(next);
    }
  };
  let body = t`Everything I read and say runs on it. Paste a key from your provider, and you pay them directly.`;
  if (ready && ai?.listing.source === "grasp") {
    body = t`Everything I read and say runs on it. You use Grasp’s AI, and it’s ready.`;
  } else if (ready && ai !== null) {
    body = t`Everything I read and say runs on it. Your own key works, and it’s ready.`;
  } else if (graspOffered) {
    body = t`Everything I read and say runs on it. Grasp’s AI works right away, or you can use your own key.`;
  }
  return (
    <CalmStep
      body={body}
      end={
        ready ? (
          <Button onClick={onReady} size="lg">
            {t`Continue`}
          </Button>
        ) : null
      }
      title={t`Which AI should I use?`}
    >
      <AiChoice ai={ai} onReady={onReady} />
    </CalmStep>
  );
};

/** The plan: their campaign as plain rows, and what a finding looks like. */
const About = ({ onward }: StepProps) => {
  const { t } = useLingui();
  return (
    <CalmStep
      body={t`I talk with your team for one week. Then you get what I learned, team by team.`}
      end={
        <Button
          onClick={() => {
            void onward();
          }}
          size="lg"
        >
          {t`Continue`}
        </Button>
      }
      title={t`Here’s the plan`}
    >
      <PlanBody today={new Date()} />
    </CalmStep>
  );
};

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
          </Button>
        ) : null
      }
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
            onClick={() => {
              void onward();
            }}
            size="lg"
          >
            {t`Open Grasp`}
          </Button>
        ) : null
      }
      figure={<AgentFigure look={stephensLook} size="xl" state="done" />}
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
