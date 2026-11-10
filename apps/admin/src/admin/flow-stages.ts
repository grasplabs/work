import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import { flowAgreementsOf } from "@grasp-os/shared/onboarding-flow";
import type {
  FlowStep,
  OnboardingFlow,
} from "@grasp-os/shared/onboarding-flow";

// Which of an onboarding's steps, as Grasp's staff follow them (Steps),
// a company's flow has: a step whose part of the flow is off isn't shown,
// since nothing will ever happen on it.

/**
 * The steps `flow` has, in order. The first conversation and the research
 * that follows it come with Grasp's first conversation; Agreed with any
 * agreement asked for; Connected, Team leads and Interviews with the
 * admin's steps of those names. Grasp opens either way. All of them for
 * a company whose Grasp says no flow.
 */
export const stagesIn = (flow?: OnboardingFlow): Stage[] => {
  if (flow === undefined) {
    return [...STAGES];
  }
  const on = (step: FlowStep): boolean =>
    flow.on && flow.steps.some(({ id, on: stepOn }) => id === step && stepOn);
  const has: Record<Stage, boolean> = {
    conversation: flow.on && flow.grasp.kickoff,
    research: flow.on && flow.grasp.kickoff,
    agreed: flowAgreementsOf(flow).length > 0,
    connected: on("company"),
    leads: on("leads"),
    interviews: on("interviews"),
    open: true,
  };
  return STAGES.filter((stage) => has[stage]);
};

/**
 * The step that is open: the one `asked` for while the flow has it, else
 * the first of the flow's steps that isn't done, else its last.
 */
export const stageShown = (
  shown: readonly Stage[],
  asked: Stage,
  statuses: Record<Stage, StageStatus>
): Stage =>
  shown.find((stage) => stage === asked) ??
  shown.find((stage) => statuses[stage] !== "done") ??
  shown.at(-1) ??
  "open";
