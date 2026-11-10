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
  "about",
  "company",
  "sources",
  "documents",
  "pulse",
  "leads",
  "interviews",
] as const;
export type FlowStep = (typeof flowSteps)[number];

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
