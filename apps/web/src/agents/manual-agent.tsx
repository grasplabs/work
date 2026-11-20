import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ComponentType, SubmitEvent } from "react";

import { wait } from "../core.ts";
import { AgentFigure, AgentFigureAura } from "../grasp/agent-figure/index.ts";
import { Backdrop } from "../grasp/backdrop/index.ts";
import { useAction } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { arrive } from "../grasp/motion/arrive.ts";
import { Shimmer } from "../grasp/shimmer/index.ts";
import { StepFoot } from "../grasp/step-foot/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { briefOf, instructionsOf, ownBrief } from "./agent-brief.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { agentTemplates } from "./agent-templates.ts";
import type { AgentTemplate } from "./agent-templates.ts";
import { faceOf, lookFromName } from "./figure/look.ts";
import { AbilitiesStep } from "./setup/abilities-step.tsx";
import { AppsStep } from "./setup/apps-step.tsx";
import { AudienceStep } from "./setup/audience-step.tsx";
import { InstructionsStep } from "./setup/instructions-step.tsx";
import { JobStep } from "./setup/job-step.tsx";
import { blank, classesOf, cronOfSchedule, steps } from "./setup/model.ts";
import type { CatalogApp, Setup, Step, StepProps } from "./setup/model.ts";
import { NameStep } from "./setup/name-step.tsx";
import { ReviewStep } from "./setup/review-step.tsx";
import { ScheduleStep } from "./setup/schedule-step.tsx";
import { ThinkingStep } from "./setup/thinking-step.tsx";

// A new agent, set up by hand (Ruben, 19 Nov 2026): Grasp takes the
// person by the hand, one question at a time, never a page of blocks.
// It has the whole card, on the library's backdrop, with no chat box at
// its foot (the route says so). Above each question the agent takes form
// as it is answered: its figure, drawn from its name. The backdrop is the
// canvas (Ruben: no cards): each question stands straight on it, large,
// its answer in the card's very middle, Back and Next under it, and comes
// in as the last one goes. Each step is a file of its own (setup/), on
// the contract in setup/model.ts; this file holds the flow and the frame.
//
// What core keeps today is saved: its words, model, schedule, whom it
// answers and its kinds of work. The rest (its apps, web, workflows and
// Apps access, its effort, and "just me", as core keeps no maker) is asked
// as Ruben decided and waits on core (.context/core-needs.md); until then
// "just me" reaches nobody else.

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
  // The backdrop is the canvas: it takes the whole card, and the setup
  // stands straight on it, no card of its own.
  ground: {
    display: "grid",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    // The card's height left under the page's bar, no more: it grows into
    // the page's column and may shrink, so the setup never makes the page
    // scroll (100% overshot by the bar's own height).
    minHeight: 0,
    paddingInline: grasp.space6,
    paddingBlock: grasp.space6,
  },
  // Three rows of equal weight round the question, so its answer stands in
  // the card's very middle whatever comes above it: the progress and the
  // agent above, Back and Next under.
  stage: {
    display: "grid",
    // The agent and the foot keep their room; a question taller than what
    // is left scrolls in its own middle row, never the page.
    gridTemplateRows:
      "minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr)",
    justifyItems: "center",
    gap: grasp.space6,
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
    gap: grasp.space6,
    width: "100%",
  },
  // The agent coming to life, alone in the card's middle.
  birth: {
    display: "grid",
    alignSelf: "center",
    justifySelf: "center",
    justifyItems: "center",
    gap: grasp.space6,
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
    borderRadius: grasp.cornerCircle,
    isolation: "isolate",
  },
  // Never taller than the card leaves it; a step that is taller still
  // scrolls in here, not the page.
  middle: {
    boxSizing: "content-box",
    width: "100%",
    maxWidth: "40rem",
    minHeight: 0,
    overflowY: "auto",
    scrollbarWidth: "none",
    // Room for what stands on its edge (a card's border, its shadow, a
    // focus ring), which a scrolling box would cut: taken back outside.
    padding: grasp.space3,
    margin: `calc(-1 * ${grasp.space3})`,
  },
  // The `hidden` attribute alone loses to the stage's own display.
  away: { display: "none" },
  // The foot under the answer, as wide as its column.
  foot: { alignSelf: "start", width: "100%", maxWidth: "40rem" },
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
      // Large while it is being named, smaller once the questions need the room.
      size={step === "name" || step === "job" ? "lg" : "md"}
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
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const [setup, setSetup] = useState<Setup>(blank);
  const [at, setAt] = useState(0);
  // The setup, then the agent coming to life while core makes it, then made.
  const [phase, setPhase] = useState<"setup" | "making" | "made">("setup");
  // The column the backdrop keeps clear of, so the words read on it.
  const column = useRef<HTMLDivElement>(null);
  const step: Step = steps[at] ?? "review";
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
    setAt(Math.min(at + 1, steps.length - 1));
  };
  const pick = (template: AgentTemplate) => {
    const job = i18n._(template.job);
    setSetup({
      ...setup,
      job,
      template: template.key,
      ...(setup.instructionsTouched ? {} : proposal(template, job)),
    });
    setAt(Math.min(at + 1, steps.length - 1));
  };

  const make = async (): Promise<void> => {
    setPhase("making");
    const job = setup.job.trim();
    const made = await run(async (session) => {
      const agent = await session.connections.makeAgent({
        name,
        job,
        instructions: setup.instructions,
        face: faceOf(lookFromName(name)),
        model: setup.model,
        modelRole: null,
      });
      // Its kinds of work: core makes it with none; each one on is as the
      // company has it.
      const classes = [...setup.abilities].flatMap(
        (ability) => classesOf[ability] ?? []
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
      return agent;
    });
    if (made === undefined) {
      // Back to the last question: the button says it failed, and why
      // stands above the question, from core.
      setPhase("setup");
      throw new Error("The agent wasn't made.");
    }
    setPhase("made");
    await wait(readyFor);
    await navigate({ to: "/agents/$agent", params: { agent: made.id } });
  };
  // Making it takes a few calls to core: the button says it is working.
  const making = useAction(make, {
    working: t`Making ${name}…`,
    done: t`Made`,
    failed: t`Not made`,
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
  const stepCount = steps.length;
  return (
    <Backdrop
      clear={column}
      fadeFoot
      layout={styles.ground}
      variant={{ backdrop: "dots", pattern: "bayer", tone: "mint" }}
    >
      {phase === "setup" ? null : <Birth made={phase === "made"} name={name} />}
      <form
        hidden={phase !== "setup"}
        onSubmit={submit}
        {...stylex.props(styles.stage, phase !== "setup" && styles.away)}
      >
        <div {...stylex.props(styles.top)}>
          {/* The last step's card shows the agent itself. */}
          {step === "review" ? null : <Becoming setup={setup} step={step} />}
        </div>
        <div ref={column} {...stylex.props(styles.middle)}>
          <AgentFailure>{failure}</AgentFailure>
          {/* Keyed by step: each question comes in fresh, its first field taking focus. */}
          <div key={step} {...stylex.props(arrive.in)}>
            <Asked
              apps={apps}
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
        {/* The library's guided-flow foot (Ruben): Back, how far through,
            Next as the step's one action, "Make agent" on the last. Next
            submits this form; Enter and Mod+Enter go on, Alt+← goes back. */}
        <StepFoot
          disabled={!ready[step]}
          finishLabel={t`Make agent`}
          layout={styles.foot}
          loading={making.status.status === "working"}
          onBack={() => {
            setAt(at - 1);
          }}
          step={{ index: at, count: stepCount }}
        />
      </form>
    </Backdrop>
  );
};
