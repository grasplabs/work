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

import type { OrgSection } from "./sections.ts";

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
 * The steps Steps opens nothing for, each shown in a section of its own
 * with what staff do there: what was agreed in the Contract, the team
 * leads and the interviews in Interviews. Their step goes there: the
 * section, and its tab where that isn't its first.
 */
export const opensElsewhere = {
  agreed: { section: "details", search: { tab: "contract" } },
  leads: { section: "interviews", search: { tab: "people" } },
  interviews: { section: "interviews", search: {} },
} as const satisfies Partial<
  Record<Stage, { section: OrgSection; search: { tab?: string } }>
>;

/**
 * The step that is open, of those that open here: the one `asked` for
 * while the flow has it. For one that opens elsewhere, or that the flow
 * lacks: the first here that is in someone's hands now, else the first
 * here after it, else the first that isn't done, else the last.
 */
export const stageShown = (
  shown: readonly Stage[],
  asked: Stage,
  statuses: Record<Stage, StageStatus>
): Stage => {
  const here = shown.filter((stage) => !(stage in opensElsewhere));
  const after = shown.includes(asked)
    ? here.find((stage) => STAGES.indexOf(stage) > STAGES.indexOf(asked))
    : undefined;
  return (
    here.find((stage) => stage === asked) ??
    here.find(
      (stage) => statuses[stage] === "now" || statuses[stage] === "waits"
    ) ??
    after ??
    here.find((stage) => statuses[stage] !== "done") ??
    here.at(-1) ??
    "open"
  );
};
