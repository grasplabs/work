import { leadWaitWorkingDays } from "@grasp-os/shared/onboarding";
import type { Agreements, OnboardingView } from "@grasp-os/shared/onboarding";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import { staffStages } from "@grasp-os/shared/onboarding-staff";
import type {
  StaffNeed,
  StaffStage,
  StageTodo,
  StageView,
} from "@grasp-os/shared/onboarding-staff";

import { addWorkingDays, closesOn, dayOf, takingPart } from "./rules.ts";
import type { InterviewState } from "./rules.ts";

// Grasp's onboarding area (GRA-319): where the onboarding stands as stages
// to tick off, and what needs Grasp, the most pressing first, from what
// the store holds. Pure, so tested on its own. Ported from the prototype
// (grasplabs/prototype, packages/grasp: src/lib/admin-todo.ts and `Need`
// in src/lib/onboarding-admin.ts), for one deployment's one onboarding.

/** What the area reads beside the admin's view and the gate: exact, by person. */
export interface StaffFacts {
  agreements: Agreements | null;
  sent: ReadonlySet<string>;
  sentAt: ReadonlyMap<string, string>;
  interviews: ReadonlyMap<string, InterviewState>;
  /** Whether the kickoff's transcript is in and read. */
  kickoff: boolean;
}

const agreementKinds = ["processing", "assessment", "council"] as const;

/** Whether one of the agreements is in. */
const agreementIn = (
  agreements: Agreements | null,
  what: (typeof agreementKinds)[number]
): boolean => {
  if (agreements === null) {
    return false;
  }
  return what === "council"
    ? agreements.council !== "waiting"
    : agreements[what];
};

/** What each stage asks for. */
const todosOf = (
  view: OnboardingView,
  gate: GateView,
  facts: StaffFacts
): Record<StaffStage, StageTodo[]> => {
  const { roster, plan } = view;
  const taking = roster?.people.filter((one) => takingPart(roster, one)) ?? [];
  const teams = roster?.teams.filter((team) => !team.off) ?? [];
  const leads = teams.flatMap((team) =>
    team.lead === null ? [] : [team.lead]
  );
  const talked = (person: string) =>
    (facts.interviews.get(person)?.completedAt ?? null) !== null;
  return {
    kickoff: [{ kind: "kickoff", done: facts.kickoff }],
    agreements: agreementKinds.map((what) => ({
      kind: what,
      done: agreementIn(facts.agreements, what),
    })),
    people: [{ kind: "people", done: roster !== null }],
    leads: [
      {
        kind: "leadsNamed",
        done: teams.length > 0 && teams.every((team) => team.lead !== null),
      },
      {
        kind: "leadsTalked",
        done: leads.length > 0 && leads.every(talked),
        count: leads.filter(talked).length,
        of: leads.length,
      },
    ],
    interviews: [
      { kind: "plan", done: plan !== null },
      {
        kind: "linksOut",
        done: taking.length > 0 && taking.every(({ id }) => facts.sent.has(id)),
        count: taking.filter(({ id }) => facts.sent.has(id)).length,
        of: taking.length,
      },
      {
        kind: "talked",
        done: taking.length > 0 && taking.every(({ id }) => talked(id)),
        count: taking.filter(({ id }) => talked(id)).length,
        of: taking.length,
      },
    ],
    open: [
      {
        kind: "known",
        done: gate.known >= gate.threshold,
        known: gate.known,
        threshold: gate.threshold,
      },
      { kind: "go", done: gate.open && roster !== null },
    ],
  };
};

/**
 * The stages, each done once all it asks is; the first not done is the
 * one the onboarding is at, and so is any other not done with something
 * done in it already.
 */
export const stagesOf = (
  view: OnboardingView,
  gate: GateView,
  facts: StaffFacts
): StageView[] => {
  const todos = todosOf(view, gate, facts);
  let seenOpen = false;
  return staffStages.map((stage): StageView => {
    const mine = todos[stage];
    const done = mine.every((todo) => todo.done);
    const started = mine.some((todo) => todo.done);
    let status: StageView["status"] = "later";
    if (done) {
      status = "done";
    } else if (!seenOpen || started) {
      status = "now";
    }
    if (!done) {
      seenOpen = true;
    }
    return { stage, status, todos: mine };
  });
};

/**
 * Leads who haven't talked `leadWaitWorkingDays` working days after their
 * link went out: their team waits on them.
 */
const quietLeads = (
  { roster }: OnboardingView,
  facts: StaffFacts,
  now: string
): StaffNeed[] =>
  (roster?.teams ?? []).flatMap((team): StaffNeed[] => {
    const lead = roster?.people.find(
      (one) => one.id === team.lead && !one.away
    );
    if (team.off || lead === undefined) {
      return [];
    }
    const sentAt = facts.sentAt.get(lead.id);
    const talked =
      (facts.interviews.get(lead.id)?.completedAt ?? null) !== null;
    const waited =
      sentAt !== undefined &&
      dayOf(now) >= addWorkingDays(sentAt, leadWaitWorkingDays);
    return waited && !talked
      ? [{ kind: "lead", team: team.id, teamName: team.name, lead: lead.name }]
      : [];
  });

/** What needs Grasp now, the most pressing first. */
export const needsOf = (
  view: OnboardingView,
  gate: GateView,
  facts: StaffFacts,
  now: string
): StaffNeed[] => {
  const { roster, plan } = view;
  const begun = roster !== null || plan !== null;
  const needs: StaffNeed[] = [];
  if (begun) {
    for (const what of agreementKinds) {
      if (!agreementIn(facts.agreements, what)) {
        needs.push({ kind: "agreement", what });
      }
    }
  }
  if (view.paused) {
    needs.push({ kind: "paused" });
  }
  needs.push(...quietLeads(view, facts, now));
  const over = plan !== null && dayOf(now) > closesOn(plan);
  if (!gate.open && over && gate.known < gate.threshold) {
    needs.push({ kind: "short", known: gate.known, threshold: gate.threshold });
  } else if (!gate.open && gate.ready) {
    needs.push({ kind: "go", known: gate.known, threshold: gate.threshold });
  }
  return needs;
};
