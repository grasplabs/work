import { z } from "zod";

// How much onboarding one company goes through, as Grasp's staff set it
// from the admin (`onboarding.flow`, admin-command.ts) and core keeps it:
// whether there is an onboarding at all, the admin's steps in order with
// each on or off, and which of Grasp's own steps are asked of this
// company. A company whose flow nobody set goes through all of it, in the
// order below (`defaultFlow`).

/**
 * The admin's steps a flow orders and switches. The interviews are one
 * step here: telling the team, Stephen listening, what needs the admin
 * and the way in only make sense together.
 */
export const flowSteps = [
  "welcome",
  "ai",
  "company",
  "sources",
  "documents",
  "leads",
  "interviews",
  "about",
] as const;
export type FlowStep = (typeof flowSteps)[number];

/**
 * The screens the admin's onboarding has, in the order they come while
 * nobody set another. The interviews' four come with the flow's one
 * `interviews` step.
 */
export const setupSteps = [
  "welcome",
  "ai",
  "company",
  "sources",
  "documents",
  "leads",
  "team",
  "about",
  "listening",
  "review",
  "open",
] as const;
export type SetupStepId = (typeof setupSteps)[number];

/**
 * Where the company's admin is in their onboarding: the screens they
 * finished, by name and never by place, so it holds when the order
 * changes. Kept by core, so they go on from it on any device, and
 * Grasp's staff see how far they are.
 */
export const setupPlaceSchema = z.strictObject({
  done: z.array(z.enum(setupSteps)).max(setupSteps.length),
});
export type SetupPlace = z.infer<typeof setupPlaceSchema>;

/** `place` with `steps` finished too: each once, in the screens' order. */
export const withDone = (
  place: SetupPlace,
  steps: readonly SetupStepId[]
): SetupPlace => ({
  done: setupSteps.filter(
    (step) => place.done.includes(step) || steps.includes(step)
  ),
});

/** The agreements Grasp can ask of a company before its interviews. */
export const flowAgreements = ["processing", "assessment", "council"] as const;
export type FlowAgreement = (typeof flowAgreements)[number];

const flowStepSchema = z.strictObject({
  id: z.enum(flowSteps),
  on: z.boolean(),
});

/** Why a flow can't work, by what is wrong with it. */
export type FlowProblem =
  /** A step is listed twice, or one is missing. */
  | "steps"
  /** Team leads or the interviews are on without who's who, or before it. */
  | "staff_list";

/** The steps that need the staff list, which who's who gives. */
const needsStaffList: ReadonlySet<FlowStep> = new Set(["leads", "interviews"]);

/**
 * What is wrong with a flow's steps, if anything: every step once, and
 * who's who on and before team leads and the interviews where either is
 * on, since both go by the staff list.
 */
export const flowProblemOf = (
  steps: readonly { id: FlowStep; on: boolean }[]
): FlowProblem | null => {
  const ids = steps.map(({ id }) => id);
  if (
    ids.length !== flowSteps.length ||
    flowSteps.some((step) => !ids.includes(step))
  ) {
    return "steps";
  }
  const company = steps.findIndex(({ id }) => id === "company");
  const needing = steps.findIndex(({ id, on }) => on && needsStaffList.has(id));
  if (needing !== -1 && (steps[company]?.on !== true || company > needing)) {
    return "staff_list";
  }
  return null;
};

/** One company's onboarding flow. */
export const onboardingFlowSchema = z
  .strictObject({
    /** Whether the company goes through an onboarding at all. */
    on: z.boolean(),
    /** The admin's steps, in the order they come, each on or off. */
    steps: z.array(flowStepSchema).length(flowSteps.length),
    /** Grasp's own steps. */
    grasp: z.strictObject({
      /** The first conversation, brought in as a transcript. */
      kickoff: z.boolean(),
      /** Which agreements have to be in before the interviews. */
      agreements: z.strictObject({
        processing: z.boolean(),
        assessment: z.boolean(),
        council: z.boolean(),
      }),
    }),
  })
  .refine(({ steps }) => flowProblemOf(steps) === null, {
    message: "The steps can't come in this order.",
    path: ["steps"],
  });
export type OnboardingFlow = z.infer<typeof onboardingFlowSchema>;

/** The flow of a company whose flow nobody set: everything, in order. */
export const defaultFlow: OnboardingFlow = {
  on: true,
  steps: flowSteps.map((id) => ({ id, on: true })),
  grasp: {
    kickoff: true,
    agreements: { processing: true, assessment: true, council: true },
  },
};

/**
 * The flow kept as `stored` (JSON, or null where nobody set one), and
 * whether staff set it. One that can't be read, such as one kept before
 * a step was added, reads as all of it: the company is then asked for
 * more than staff meant, never for less.
 */
export const storedFlowOf = (
  stored: string | null
): { flow: OnboardingFlow; set: boolean } => {
  if (stored === null) {
    return { flow: defaultFlow, set: false };
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(stored);
  } catch {
    // Not JSON: unreadable, as below.
  }
  const read = onboardingFlowSchema.safeParse(raw);
  return read.success
    ? { flow: read.data, set: true }
    : { flow: defaultFlow, set: false };
};

/** Whether the company's people are interviewed in this flow. */
export const flowInterviews = (flow: OnboardingFlow): boolean =>
  flow.on && flow.steps.some(({ id, on }) => id === "interviews" && on);

/**
 * The agreements this flow asks for before the interviews; none where
 * the company goes through no onboarding.
 */
export const flowAgreementsOf = (flow: OnboardingFlow): FlowAgreement[] =>
  flow.on
    ? flowAgreements.filter((agreement) => flow.grasp.agreements[agreement])
    : [];

/** `flow` with the steps in `off` switched off, in the order they were. */
const without = (off: readonly FlowStep[]): OnboardingFlow["steps"] =>
  flowSteps.map((id) => ({ id, on: !off.includes(id) }));

/**
 * The flows staff start from. `full` is all of it. `short` keeps who is
 * who, the team leads and the interviews. `setup` is the admin's own
 * setting up, with no interviews and nothing of Grasp's before them.
 * `none` is no onboarding: people sign in straight to the platform.
 */
export const flowPresets = {
  full: defaultFlow,
  short: {
    on: true,
    steps: without(["about", "sources", "documents"]),
    grasp: defaultFlow.grasp,
  },
  setup: {
    on: true,
    steps: without(["about", "leads", "interviews"]),
    grasp: {
      kickoff: false,
      agreements: { processing: false, assessment: false, council: false },
    },
  },
  none: { ...defaultFlow, on: false },
} as const satisfies Record<string, OnboardingFlow>;
export type FlowPreset = keyof typeof flowPresets;

/** The flows staff start from, by name, in the order they are offered. */
export const flowPresetNames = ["full", "short", "setup", "none"] as const;

/**
 * The flow a company's onboarding starts with, from what its deployment's
 * config names (`ONBOARDING_START`, which Grasp's admin sets from what
 * staff chose as they added the company): one of the flows staff start
 * from. None for the whole onboarding, which a company goes through
 * anyway, and for anything else the config says.
 */
export const startingFlowOf = (named: unknown): OnboardingFlow | null => {
  const preset = flowPresetNames.find((name) => name === named);
  return preset === undefined || preset === "full" ? null : flowPresets[preset];
};

/** `flow` with step `id` moved to place `to`, from 0, the others keeping their order. */
export const withStepMoved = (
  flow: OnboardingFlow,
  id: FlowStep,
  to: number
): OnboardingFlow => {
  const moved = flow.steps.find((step) => step.id === id);
  if (moved === undefined) {
    return flow;
  }
  const rest = flow.steps.filter((step) => step.id !== id);
  const at = Math.min(Math.max(to, 0), rest.length);
  return { ...flow, steps: [...rest.slice(0, at), moved, ...rest.slice(at)] };
};

/**
 * The screen that comes with the flow's `interviews` step: telling the
 * team and planning the day. The screens after Stephen listening (what
 * needs the admin, the way in) are no longer shown; their names stay in
 * `setupSteps` so places kept with them still read.
 */
const interviewScreens: readonly SetupStepId[] = ["team"];

/**
 * Where the admin watches the interviews run, the flow's last screen
 * wherever it has the `interviews` step. Nothing on it is the admin's to
 * finish: it stands until Grasp's go, and holds nobody (`heldBy`).
 */
const watching: SetupStepId = "listening";

/**
 * The screens the admin goes through in this flow, in order; none where
 * there is no onboarding. The interviews' screens come after the others
 * wherever the flow has the step, then the story of what happens next
 * (`about`), wherever staff put it: it tells what the admin just chose.
 * Last of all, where its people are interviewed, the page the admin
 * watches the interviews on.
 */
export const flowScreens = (flow: OnboardingFlow): SetupStepId[] => {
  if (!flow.on) {
    return [];
  }
  const on = flow.steps.filter((step) => step.on).map(({ id }) => id);
  return [
    ...on.flatMap((id): SetupStepId[] =>
      id === "interviews" || id === "about" ? [] : [id]
    ),
    ...(on.includes("interviews") ? interviewScreens : []),
    ...(on.includes("about") ? (["about"] as const) : []),
    ...(on.includes("interviews") ? [watching] : []),
  ];
};

/**
 * The screens of this flow the admin has to finish before going on into
 * the platform: all but the one they only watch the interviews on.
 */
const heldBy = (flow: OnboardingFlow): SetupStepId[] =>
  flowScreens(flow).filter((screen) => screen !== watching);

/**
 * Whether the company has its onboarding behind it, by its flow: at once
 * where it has no screens; once its admins finished every screen it has;
 * and where its people are interviewed, for everyone else only once
 * Grasp gave its go (`open`). So an admin who told the team goes on into
 * the platform while the interviews run, the page they watch them on
 * holding nobody, and everyone else waits for the go, as the sign-in gate
 * keeps them out until then anyway.
 */
export const onboardingBehind = ({
  flow,
  done,
  open,
  admin = false,
}: {
  flow: OnboardingFlow;
  /** The screens the admins finished, as core keeps them. */
  done: readonly SetupStepId[];
  open: boolean;
  /** Whether it is asked for one of the company's admins, who did the screens. */
  admin?: boolean;
}): boolean => {
  const screens = heldBy(flow);
  if (screens.length === 0) {
    return true;
  }
  const finished = screens.every((screen) => done.includes(screen));
  if (!flowInterviews(flow)) {
    return finished;
  }
  return open || (admin && finished);
};

/**
 * How the platform opens to the company in this flow: on Grasp's `go`
 * once the interviews told enough; once the admin `finished` the last
 * screen, where nobody is interviewed; or `at_once`, where there is
 * nothing to go through.
 */
export const flowOpening = (
  flow: OnboardingFlow
): "go" | "finished" | "at_once" => {
  if (flowInterviews(flow)) {
    return "go";
  }
  return flowScreens(flow).length > 0 ? "finished" : "at_once";
};
