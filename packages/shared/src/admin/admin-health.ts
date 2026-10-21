import type { AdminView } from "./admin-view.ts";
import { KNOWLEDGE_SOURCES, listenDays } from "./onboarding-admin.ts";
import type {
  KnowledgeSource,
  Need,
  WorkEvidence,
} from "./onboarding-admin.ts";

/**
 * How one organization is doing, in a few signals Grasp can act on before the company asks: its
 * phase, the health of what it connected, its interviews, its brain, its workflows and its
 * account. Everything follows from the admin's view of the organization on its day; nothing is
 * stored. Pure.
 */

/** The phases Grasp's list of organizations is cut into: from the first conversation until the company works in Grasp. */
export const ADMIN_PHASES = [
  "start",
  "agreements",
  "interviews",
  "ready",
  "open",
] as const;
export type AdminPhase = (typeof ADMIN_PHASES)[number];

/** Where an organization is: open once Grasp gave its go, ready once enough is known, otherwise by the step it is at. */
export const phaseOf = (view: AdminView): AdminPhase => {
  if (view.open) {
    return "open";
  }
  if (view.knowledge.ready) {
    return "ready";
  }
  if (view.stage === "conversation" || view.stage === "research") {
    return "start";
  }
  if (view.stage === "agreed" || view.stage === "connected") {
    return "agreements";
  }
  return "interviews";
};

/** A piece of work Grasp knows well enough to design from: complete, with its variants explained, or counted by hand. */
export const isKnown = (work: WorkEvidence): boolean =>
  work.byHand || work.state === "complete" || work.state === "variants";

/** Nothing to say yet; all is well; worth a look; needs Grasp. */
export type HealthLevel = "none" | "good" | "watch" | "attention";

export const HEALTH_AREAS = [
  "connections",
  "interviews",
  "brain",
  "workflows",
  "account",
] as const;
export type HealthArea = (typeof HEALTH_AREAS)[number];

export type HealthSignal =
  /** What the company connected, how many of those stopped, and whether its sign-in is in. */
  | {
      area: "connections";
      level: HealthLevel;
      connected: number;
      stopped: number;
      signIn: boolean;
    }
  /** Who talked of everyone asked, on which day of the interviews, and how many teams have gone quiet. */
  | {
      area: "interviews";
      level: HealthLevel;
      talked: number;
      asked: number;
      day: number;
      quiet: number;
      told: boolean;
      closed: boolean;
    }
  /** How much of what Grasp needs is known, against the share it opens at. */
  | {
      area: "brain";
      level: HealthLevel;
      percent: number;
      threshold: number;
      covered: number;
      teams: number;
    }
  /** Pieces of work known of all, and once open, how many run and whether any stand still. */
  | {
      area: "workflows";
      level: HealthLevel;
      known: number;
      of: number;
      live: number;
      designs: number;
      stuck: number;
      open: boolean;
    }
  /** The contract and what it covers: what of it needs Grasp. */
  | { area: "account"; level: HealthLevel; needs: Need["kind"][] };

/** One team as the brain has heard it. */
export interface BrainTeam {
  id: string;
  name: string;
  /** It does not take part: nothing is asked of it. */
  off: boolean;
  /** Interviews its people agreed to, of everyone asked there. */
  agreed: number;
  asked: number;
  /** Facts written down in those interviews and agreed to. */
  facts: number;
  /** Its pieces of work, and how many Grasp knows well enough to design from. */
  works: number;
  known: number;
  /** What its people could not say when asked: the next interviews' questions. */
  questions: number;
}

/**
 * What the company's brain stands on, as counts only: how much of what Grasp needs is known by
 * source, which teams it has heard and how well, and what is still open. Never what anyone said.
 */
export interface BrainHealth {
  percent: number;
  threshold: number;
  /** Each source of what is known, 0 to 1, with how much it can add, the largest gap first. */
  sources: { source: KnowledgeSource; weight: number; known: number }[];
  teams: BrainTeam[];
  /** Teams that take part and have at least one agreed interview. */
  covered: number;
  facts: number;
  questions: number;
  /** Pieces of work two people tell differently, with nobody able to say why yet. */
  differs: number;
  /** Agreed interviews in all. */
  interviews: number;
}

export const brainOf = (view: AdminView): BrainHealth => {
  const approved = view.interviews.filter((interview) => interview.approved);
  const teams = view.teams.map((team): BrainTeam => {
    const ids = new Set(team.people.map((person) => person.person.id));
    const theirs = approved.filter((interview) => ids.has(interview.person.id));
    return {
      id: team.team.id,
      name: team.team.name,
      off: team.off,
      agreed: theirs.length,
      asked: team.asked,
      // An interview counts every fact written down; those taken out at the read-back were not agreed to.
      facts: theirs.reduce(
        (sum, interview) => sum + interview.facts - interview.out,
        0
      ),
      works: team.works.length,
      known: team.works.filter(isKnown).length,
      questions: theirs.reduce(
        (sum, interview) => sum + interview.followUps,
        0
      ),
    };
  });
  const weighed = view.knowledge.sources.map(({ source, weight, known }) => ({
    source,
    weight,
    known,
  }));
  return {
    percent: view.knowledge.percent,
    threshold: view.knowledge.threshold,
    sources: weighed.toSorted(
      (a, b) =>
        b.weight * (1 - b.known) - a.weight * (1 - a.known) ||
        KNOWLEDGE_SOURCES.indexOf(a.source) -
          KNOWLEDGE_SOURCES.indexOf(b.source)
    ),
    teams,
    covered: teams.filter((team) => !team.off && team.agreed > 0).length,
    facts: teams.reduce((sum, team) => sum + team.facts, 0),
    questions: teams.reduce((sum, team) => sum + team.questions, 0),
    differs: view.works.filter((work) => work.differs && work.unexplained > 0)
      .length,
    interviews: approved.length,
  };
};

const ACCOUNT_NEEDS: ReadonlySet<Need["kind"]> = new Set<Need["kind"]>([
  "contract",
  "ending",
  "budget",
  "overdue",
]);

/** The connections: one stopped needs a look; the sign-in in place is good. */
const connectionsLevel = (stopped: number, signIn: boolean): HealthLevel => {
  if (stopped > 0) {
    return "attention";
  }
  return signIn ? "good" : "none";
};

/** The interviews, once the company is told: someone quiet needs a look, falling behind is worth watching. */
const interviewsLevel = (
  view: AdminView,
  quiet: number,
  behind: boolean
): HealthLevel => {
  if (!view.told) {
    return "none";
  }
  if (quiet > 0) {
    return "attention";
  }
  return behind ? "watch" : "good";
};

/** The brain: good once it knows enough; short of that after the interviews closed, it needs a look. */
const brainLevel = (view: AdminView, brain: BrainHealth): HealthLevel => {
  if (brain.percent >= brain.threshold) {
    return "good";
  }
  if (view.closed) {
    return "attention";
  }
  return view.told ? "watch" : "none";
};

/** The workflows: once open, whether they run; before, whether any is blocked or known. */
const workflowsLevel = (
  view: AdminView,
  stopped: number,
  known: number
): HealthLevel => {
  if (view.open) {
    if (stopped > 0) {
      return "attention";
    }
    return view.value.live === 0 ? "watch" : "good";
  }
  if (view.works.some((work) => work.state === "blocked")) {
    return "attention";
  }
  return known > 0 ? "good" : "none";
};

/** The account: anything of it that needs Grasp needs a look; a signed contract is good. */
const accountLevel = (
  view: AdminView,
  account: Need["kind"][]
): HealthLevel => {
  if (account.length > 0) {
    return "attention";
  }
  return view.contract.status === "signed" ? "good" : "none";
};

/** The health of one organization, one signal an area, in the order of `HEALTH_AREAS`. */
export const healthOf = (view: AdminView): HealthSignal[] => {
  const brain = brainOf(view);
  const stopped = view.integrations.filter(
    (integration) => integration.again
  ).length;
  const signIn = view.stages.connected === "done";
  const quiet = view.needs.filter(
    (need) => need.kind === "quiet" || need.kind === "lead"
  ).length;
  const talked = view.counts.completed;
  // Halfway through the organization's own interviews, fewer than a third of the people asked having talked is worth a look.
  const behind =
    view.told &&
    !view.closed &&
    view.day >= listenDays(view.org) / 2 &&
    view.asked > 0 &&
    talked / view.asked < 1 / 3;
  const known = view.works.filter(isKnown).length;
  const account = view.needs
    .filter((need) => ACCOUNT_NEEDS.has(need.kind))
    .map((need) => need.kind);
  return [
    {
      area: "connections",
      level: connectionsLevel(stopped, signIn),
      connected: view.integrations.length,
      stopped,
      signIn,
    },
    {
      area: "interviews",
      level: interviewsLevel(view, quiet, behind),
      talked,
      asked: view.asked,
      day: view.day,
      quiet,
      told: view.told,
      closed: view.closed,
    },
    {
      area: "brain",
      level: brainLevel(view, brain),
      percent: brain.percent,
      threshold: brain.threshold,
      covered: brain.covered,
      teams: brain.teams.filter((team) => !team.off).length,
    },
    {
      area: "workflows",
      level: workflowsLevel(view, stopped, known),
      known,
      of: view.works.length,
      live: view.value.live,
      designs: view.value.designs,
      // A workflow that works in an app whose connection stopped stands still until someone signs in again.
      stuck: view.open ? stopped : 0,
      open: view.open,
    },
    {
      area: "account",
      level: accountLevel(view, account),
      needs: account,
    },
  ];
};
