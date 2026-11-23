import { agentAppOf } from "@grasp-os/shared/agents";
import { failureText } from "@grasp-os/shared/errors";
import {
  instructionFileErrors,
  instructionsMaxLength,
  instructionsTooLong,
} from "@grasp-os/shared/instruction-files";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { StepperNav } from "@grasp-os/ui/components/stepper";
import { useAction } from "@grasp-os/ui/hooks/use-action";
import { radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ComponentType, SubmitEvent } from "react";

import { wait } from "../core.ts";
import { orNull } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { briefOf, instructionsOf, ownBrief } from "./agent-brief.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { agentTemplates } from "./agent-templates.ts";
import type { AgentTemplate } from "./agent-templates.ts";
import { AgentFigure, AgentFigureAura } from "./figure/agent-figure.tsx";
import { faceOf, lookFromName } from "./figure/look.ts";
import { AbilitiesStep } from "./setup/abilities-step.tsx";
import { AppsStep } from "./setup/apps-step.tsx";
import { arrive } from "./setup/arrive.ts";
import { AudienceStep } from "./setup/audience-step.tsx";
import { InstructionsStep } from "./setup/instructions-step.tsx";
import { JobStep } from "./setup/job-step.tsx";
import {
  audiences,
  blank,
  classesOf,
  companySteps,
  cronOfSchedule,
  steps,
} from "./setup/model.ts";
import type { CatalogApp, Setup, Step, StepProps } from "./setup/model.ts";
import { NameStep } from "./setup/name-step.tsx";
import { ReviewStep } from "./setup/review-step.tsx";
import { ScheduleStep } from "./setup/schedule-step.tsx";
import { ThinkingStep } from "./setup/thinking-step.tsx";
import { keepUnfinished } from "./unfinished-setup.ts";
import { saveFirstInstructions } from "./unsaved-instructions.ts";

// A new agent, set up by hand (Ruben, 19 Nov 2026): Grasp takes the
// person by the hand, one question at a time, never a page of blocks.
// Above each question the agent takes form as it is answered: its
// figure, drawn from its name. Each question stands straight on the page,
// large, its answer in the middle, Back and Next under it, and comes in as
// the last one goes. Each step is a file of its own (setup/), on the
// contract in setup/model.ts; this file holds the flow and the frame.
//
// What core keeps today is saved: its words, model, apps, schedule, whom
// it answers and its kinds of work, and its instructions as its
// instruction file. "Just me" makes one of the person's own (core's
// `makeOwnAgent`), which reaches them alone, has no kinds of work or
// schedule of its own, and which they may offer the company later. Anyone
// of the company makes one of their own; only its admins one for the
// company. Who may use it is asked first, and only where there is a
// choice, so the questions after it are the ones its answer leaves: what
// it may do and when it works only for one of the company's. An admin's
// starts as the company's, for everyone. The rest (web, workflows and
// Apps access, its effort) is asked as Ruben decided and waits on core.
// Should its instructions not save once it is made, its page opens on
// Instructions with them as an unsaved draft (unsaved-instructions.ts).

/** Each step's question. */
const questions: Record<Step, ComponentType<StepProps>> = {
  name: NameStep,
  job: JobStep,
  instructions: InstructionsStep,
  apps: AppsStep,
  abilities: AbilitiesStep,
  thinking: ThinkingStep,
  schedule: ScheduleStep,
  audience: AudienceStep,
  review: ReviewStep,
};

/** The figure before it has a name: Grasp's own orb, waiting for one. */
const unnamed = { shape: "orb", palette: "evergreen" } as const;

const styles = stylex.create({
  // The setup stands straight on the page, no card of its own.
  ground: {
    display: "grid",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    // The card's height left under the page's bar, no more: it grows into
    // the page's column and may shrink, so the setup never makes the page
    // scroll (100% overshot by the bar's own height).
    minHeight: 0,
    paddingInline: space["6"],
    paddingBlock: space["6"],
  },
  // Three rows of equal weight round the question, so its answer stands in
  // the card's very middle whatever comes above it: the progress and the
  // agent above, Back and Next under.
  stage: {
    display: "grid",
    // The bar and the agent keep their room; a question taller than what
    // is left scrolls in its own middle row, never the page.
    gridTemplateRows:
      "minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr)",
    justifyItems: "center",
    gap: space["6"],
    width: "100%",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  top: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["6"],
    width: "100%",
  },
  // The agent coming to life, alone in the card's middle.
  birth: {
    display: "grid",
    alignSelf: "center",
    justifySelf: "center",
    justifyItems: "center",
    gap: space["6"],
    textAlign: "center",
  },
  // Its light: a round of the aura behind the figure.
  light: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: "24rem",
    maxWidth: "100%",
    aspectRatio: "1",
    overflow: "hidden",
    borderRadius: radius.circle,
    isolation: "isolate",
  },
  // Never taller than the card leaves it; a step that is taller still
  // scrolls in here, not the page.
  middle: {
    boxSizing: "content-box",
    width: "100%",
    // The settings column's width, as an agent's page has it.
    maxWidth: size.containerSm,
    minHeight: 0,
    overflowY: "auto",
    scrollbarWidth: "none",
    // Room for what stands on its edge (a card's border, its shadow, a
    // focus ring), which a scrolling box would cut: taken back outside.
    padding: space["3"],
    margin: `calc(-1 * ${space["3"]})`,
  },
  // The `hidden` attribute alone loses to the stage's own display.
  away: { display: "none" },
  // The foot under the answer: the way on, in its middle.
  foot: { display: "grid", justifyItems: "center", alignContent: "start" },
  // The bar at the top, as wide as the answer's column.
  bar: { display: "block", width: "100%", maxWidth: size.containerSm },
});

/** The pose the figure takes at a step: listening while it is told about itself, done at the end. */
const poseAt = (step: Step, named: boolean) => {
  if (step === "review") {
    return "done" as const;
  }
  return named ? ("listening" as const) : ("idle" as const);
};

/** The agent taking form above its question: its figure, drawn from its name. */
const Becoming = ({ setup, step }: { setup: Setup; step: Step }) => {
  const { t } = useLingui();
  const named = setup.name.trim() !== "";
  const look = named ? lookFromName(setup.name.trim()) : unnamed;
  return (
    <AgentFigure
      follow
      aria-label={named ? setup.name : t`The new agent`}
      look={look}
      // Large until it is named, smaller once the questions need the room.
      size={
        step === "audience" || step === "name" || step === "job" ? "lg" : "md"
      }
      state={poseAt(step, named)}
    />
  );
};

/** How long "ready" stands before its page opens: seen once, so longer than an answer. */
const readyFor = 1600;

/**
 * The agent coming to life once Make agent is pressed: the setup gives
 * way to the agent alone, large on its own light, thinking while core
 * makes it, then done, its name said as ready before its page opens.
 */
const Birth = ({ name, made }: { name: string; made: boolean }) => {
  const { t } = useLingui();
  const look = lookFromName(name);
  return (
    <div {...stylex.props(styles.birth)}>
      <span {...stylex.props(styles.light)}>
        <AgentFigureAura ground="page" look={look} />
        <AgentFigure
          follow
          aria-label={name}
          look={look}
          size="xl"
          state={made ? "done" : "thinking"}
        />
      </span>
      {made ? (
        <span {...stylex.props(arrive.in)}>
          <Heading level={1} size="xl">
            {t`${name} is ready`}
          </Heading>
        </span>
      ) : (
        <Shimmer>{t`Bringing ${name} to life…`}</Shimmer>
      )}
    </div>
  );
};

/** A new agent set up by hand, a question at a time: see the file's head. */
export const ManualAgent = ({
  models,
  apps,
  teams,
  taken,
  personId,
  company,
  own,
}: {
  /** The models the organization chose, which an agent can be given. */
  models: readonly string[];
  /** The company's catalog of apps, connected ones marked. */
  apps: readonly CatalogApp[];
  teams: StephenReach["teams"];
  /** The names other agents have: core keeps each name to one agent. */
  taken: readonly string[];
  /** The person making it: a schedule chosen here works for them. */
  personId: string;
  /** Whether they may make one for the company: its own admins. */
  company: boolean;
  /** Whether the company lets people have agents of their own. */
  own: boolean;
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  // Who it may be for: one of their own only while the company lets them,
  // the company's only for its admins.
  const offered = audiences.filter((each) => (each === "me" ? own : company));
  const [setup, setSetup] = useState<Setup>({
    ...blank,
    audience: company ? "everyone" : "me",
  });
  const asked = steps.filter((each) =>
    each === "audience"
      ? offered.length > 1
      : setup.audience !== "me" || !companySteps.has(each)
  );
  const [at, setAt] = useState(0);
  // The setup, then the agent coming to life while core makes it, then made.
  const [phase, setPhase] = useState<"setup" | "making" | "made">("setup");
  const step: Step = asked[at] ?? "review";
  const change = (next: Partial<Setup>) => {
    setSetup({ ...setup, ...next });
  };

  const name = setup.name.trim();
  const nameTaken = taken.some(
    (other) =>
      other.localeCompare(name, undefined, { sensitivity: "base" }) === 0
  );
  const ready: Record<Step, boolean> = {
    name: name !== "" && !nameTaken,
    job: setup.job.trim() !== "",
    instructions: setup.instructions.trim() !== "",
    apps: true,
    abilities: true,
    thinking: true,
    schedule:
      setup.schedule.frequency === "asked" ||
      cronOfSchedule(setup.schedule) !== undefined,
    audience: setup.audience !== "teams" || setup.teams.size > 0,
    review: true,
  };

  /** The brief Grasp proposes for a job: the starting point's, or one from the job's words. */
  const proposal = (template: AgentTemplate | undefined, job: string) => {
    const brief =
      template !== undefined && i18n._(template.job) === job
        ? briefOf(template, i18n)
        : ownBrief(job, i18n);
    return { instructions: instructionsOf(brief, i18n), goal: brief.goal };
  };
  const forward = () => {
    // Leaving what it is for: Grasp proposes the brief from it, unless it
    // was written by hand.
    const job = setup.job.trim();
    const template = agentTemplates.find(({ key }) => key === setup.template);
    const proposed =
      step === "job" && !setup.instructionsTouched
        ? proposal(template, job)
        : {};
    change(proposed);
    setAt(Math.min(at + 1, asked.length - 1));
  };
  const pick = (template: AgentTemplate) => {
    const job = i18n._(template.job);
    setSetup({
      ...setup,
      job,
      template: template.key,
      ...(setup.instructionsTouched ? {} : proposal(template, job)),
    });
    setAt(Math.min(at + 1, asked.length - 1));
  };

  const make = async (): Promise<void> => {
    setPhase("making");
    const job = setup.job.trim();
    const { instructions } = setup;
    const mine = setup.audience === "me";
    const made = await run(async (session) => {
      // Refused before anything is made, as their save would be.
      if (instructionsTooLong(instructions)) {
        throw instructionFileErrors.create("instructions.too_large", {
          maxLength: instructionsMaxLength,
        });
      }
      const input = {
        name,
        job,
        face: faceOf(lookFromName(name)),
        model: setup.model,
        modelRole: null,
      };
      const agent = mine
        ? await session.connections.makeOwnAgent(input)
        : await session.connections.makeAgent(input);
      // The rest is set one call at a time, once it exists: what fails
      // then is said on its page, where it can be set, as the agent is
      // made and its name taken (unfinished-setup.ts).
      let told = true;
      const finish = async (): Promise<void> => {
        // Its apps, as the catalog names each.
        await Promise.all(
          apps
            .filter(({ id }) => setup.apps.has(id))
            .map(async ({ source, id }) => {
              await session.connections.setAgentApp(
                agent.id,
                agentAppOf(source, id),
                true
              );
            })
        );
        told =
          instructions.trim() === "" ||
          (await saveFirstInstructions(session, agent.id, instructions));
        if (mine) {
          return;
        }
        // Its kinds of work: core makes it with none; each one on is as the
        // company has it.
        const classes = [...setup.abilities].flatMap(
          (ability) => classesOf[ability]
        );
        await Promise.all(
          classes.map(async (toolClass) => {
            await session.connections.setAgentToolClass(agent.id, toolClass, {
              who: "asClass",
            });
          })
        );
        if (setup.audience === "everyone") {
          await session.connections.setAgentReach(agent.id, true, {
            who: "everyone",
          });
        }
        if (setup.audience === "teams") {
          await session.connections.setAgentReach(agent.id, true, {
            who: "teams",
            teams: [...setup.teams],
          });
        }
        const cron = cronOfSchedule(setup.schedule);
        if (cron !== undefined) {
          await session.connections.makeAgentWake(agent.id, {
            cron,
            personId,
            opening: job === "" ? name : job,
          });
        }
      };
      try {
        await finish();
      } catch (error) {
        keepUnfinished(agent.id, failureText(error));
      }
      return { agent, told };
    });
    if (made === undefined) {
      // Back to the last question: the button says it failed, and why
      // stands above the question, from core.
      setPhase("setup");
      throw new Error("The agent wasn't made.");
    }
    setPhase("made");
    const agent = made.agent.id;
    // Its instructions didn't save: its page opens where they wait.
    const search = made.told ? {} : { tab: "instructions" as const };
    // Its page is read while it stands ready, so the page comes whole, with
    // no loading step between (Ruben, 21 November: "very smooth"); one
    // that can't be read now loads as any page does.
    await Promise.all([
      wait(readyFor),
      // One that fails to read now is read again as the page opens.
      orNull(
        async () =>
          await router.preloadRoute({
            to: "/agents/$agent",
            params: { agent },
            search,
          })
      ),
    ]);
    // The ready agent fades into its page (a view transition), where the
    // browser has them; at once where it doesn't, or with less motion.
    await navigate({
      to: "/agents/$agent",
      params: { agent },
      search,
      viewTransition: true,
    });
  };
  // Making it takes a few calls to core: the button says it is working.
  const making = useAction(make, {
    loadingLabel: t`Making ${name}…`,
    successLabel: t`Made`,
    errorLabel: t`Not made`,
  });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready[step]) {
      return;
    }
    if (step === "review") {
      void making.run();
      return;
    }
    forward();
  };

  const Asked = questions[step];
  const stepCount = asked.length;
  return (
    <div {...stylex.props(styles.ground)}>
      {phase === "setup" ? null : <Birth made={phase === "made"} name={name} />}
      <form
        hidden={phase !== "setup"}
        onSubmit={submit}
        {...stylex.props(styles.stage, phase !== "setup" && styles.away)}
      >
        <div {...stylex.props(styles.top)}>
          {/* Damsko's quiet bar at the top of a guided flow: ghost Back
              and Next round the thin progress, "Make agent" on the last
              step. Next submits this form; Enter and Mod+Enter go on,
              Alt+← goes back. The same way on stands under the answer. */}
          <span {...stylex.props(styles.bar)}>
            <StepperNav
              disabled={!ready[step]}
              finishLabel={t`Make agent`}
              loading={making.status === "loading"}
              onBack={() => {
                setAt(at - 1);
              }}
              step={at}
              total={stepCount}
              variant="bar"
            />
          </span>
          {/* The last step's card shows the agent itself. */}
          {step === "review" ? null : <Becoming setup={setup} step={step} />}
        </div>
        <div {...stylex.props(styles.middle)}>
          <AgentFailure>{failure}</AgentFailure>
          {/* Keyed by step: each question comes in fresh, its first field taking focus. */}
          <div key={step} {...stylex.props(arrive.in)}>
            <Asked
              apps={apps}
              audiences={offered}
              change={change}
              models={models}
              name={name}
              nameTaken={nameTaken}
              pick={pick}
              setup={setup}
              teams={teams}
            />
          </div>
        </div>
        {/* The way on, under the answer where the eye already is (Ruben,
            21 November); the bar above keeps its arrows both ways. */}
        <div {...stylex.props(styles.foot)}>
          <Button
            disabled={!ready[step] || making.status === "loading"}
            size="lg"
            type="submit"
          >
            {step === "review" ? t`Make ${name}` : t`Next`}
          </Button>
        </div>
      </form>
    </div>
  );
};
