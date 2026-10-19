import type { Ring, Rollout, RolloutTarget } from "./admin-platform.ts";

/**
 * The apps the companies' workflows need that Composio does not have, which Grasp builds into the
 * platform itself: once for every company that asked, since every company runs the same platform.
 * A build goes from being asked for, through Grasp's agent writing it on a branch of its own and a
 * pull request a person reviews, to a release that reaches the companies ring by ring. People at
 * Grasp stay in it at four points: the plan, the credentials, the review and the rollout. Only
 * what the admin reads of a build is here; moving one on stays a button a person presses. Pure.
 */

/** The steps of a build, in order. A build that Grasp decided not to make is `declined`, beside them. */
export const BUILD_STAGES = [
  "requested",
  "researching",
  "plan",
  "credentials",
  "writing",
  "testing",
  "selfReview",
  "review",
  "merged",
  "rollout",
  "live",
] as const;
export type BuildStep = (typeof BUILD_STAGES)[number];
export type BuildStage = BuildStep | "declined";

/** Who a build waits on now: Grasp's agent (or the release, which runs by itself), a person at Grasp, the companies, or nobody. */
export type Waiter = "agent" | "grasp" | "company" | "nobody";

/** How Grasp signs in to the app. */
export type AuthKind = "oauth2" | "apiKey" | "none";

/** One company's request: which of its workflows need the app, when it was asked and by whom. */
export interface BuildRequest {
  /** The organization, by its id in the admin. */
  org: string;
  workflows: string[];
  on: string;
  by: string;
}

/** Something the workflows need to do in the app: read, or change. */
export interface NeededAction {
  name: string;
  access: "read" | "write";
}

export interface BuildCheck {
  name: string;
  state: "passed" | "failed" | "running" | "waiting";
}

/**
 * Where the release with the build stands at one company that asked, as the console's rollout has
 * it: the company's ring, its status in the rollout, and the day it went live there.
 */
export interface OrgRollout {
  status: RolloutTarget["status"];
  org: string;
  ring: Ring;
  live: string | null;
}

/** What Grasp's agent did so far, and where its work is. */
export interface BuildWork {
  /** The agent's session. */
  session: string;
  branch: string;
  /** How long the agent worked, in minutes. */
  minutes: number;
  /** What the agent cost so far, in euros. */
  cost: number;
  tests?: { passed: number; total: number };
  pr?: { number: number; url: string; checks: BuildCheck[]; reviewer: string };
  /** The release the merge went into, as the console names it: `r<run>-<sha7>`. */
  release?: string;
  rollout?: OrgRollout[];
}

export interface IntegrationBuild {
  id: string;
  app: string;
  logo?: string;
  /** What the app is, in a line. */
  about: string;
  docs: string;
  auth: AuthKind;
  actions: NeededAction[];
  requests: BuildRequest[];
  stage: BuildStage;
  /** The day each step was reached. */
  reached: Partial<Record<BuildStage, string>>;
  /** The agent's plan, once it wrote one: what it will build and what it asks. */
  plan?: { summary: string; questions: string[] };
  work?: BuildWork;
  /** Why Grasp does not build it. */
  declined?: string;
}

/** Who the stage waits on. */
export const waitsOn = (stage: BuildStage): Waiter => {
  switch (stage) {
    case "requested":
    case "plan":
    case "credentials":
    case "review":
    case "rollout": {
      return "grasp";
    }
    case "researching":
    case "writing":
    case "testing":
    case "selfReview":
    case "merged": {
      return "agent";
    }
    case "live": {
      return "company";
    }
    case "declined": {
      return "nobody";
    }
    default: {
      return stage satisfies never;
    }
  }
};

/** The rollout's companies in the order the rings reach them. */
export const rolloutOf = (build: IntegrationBuild): OrgRollout[] =>
  (build.work?.rollout ?? []).toSorted((a, b) => a.ring - b.ring);

/** The next ring the release still has to reach, if any. */
export const nextRing = (build: IntegrationBuild): Ring | undefined => {
  const rollout = rolloutOf(build);
  // While a ring is being deployed, the next one is not up for approval yet.
  if (rollout.some((each) => each.status === "deploying")) {
    return undefined;
  }
  return rollout.find((each) => each.status === "pending")?.ring;
};

/** Whether a person at Grasp has to do something for the build to go on: in the rollout, only while the next ring waits for a go. */
export const needsGrasp = (build: IntegrationBuild): boolean =>
  waitsOn(build.stage) === "grasp" &&
  (build.stage !== "rollout" || nextRing(build) !== undefined);

/** How many builds wait on a person at Grasp: the admin sidebar's count. */
export const waitingOnGrasp = (builds: readonly IntegrationBuild[]): number =>
  builds.filter(needsGrasp).length;

/** The organizations that asked for the app, once each, in the order they asked. */
export const askedBy = (build: IntegrationBuild): string[] => [
  ...new Set(
    build.requests
      .toSorted((a, b) => a.on.localeCompare(b.on))
      .map((request) => request.org)
  ),
];

/** The day the app was first asked for. */
export const firstAsked = (build: IntegrationBuild): string =>
  build.requests.map((request) => request.on).toSorted()[0] ?? "";

const ORDER: Record<Waiter, number> = {
  grasp: 0,
  agent: 1,
  company: 2,
  nobody: 3,
};

/**
 * What waits on Grasp first, then what Grasp's agent is on, then what the companies can connect,
 * then what Grasp does not build. Within each, the app most companies asked for first, then the
 * one asked for longest ago.
 */
export const sortBuilds = (
  builds: readonly IntegrationBuild[]
): IntegrationBuild[] =>
  builds.toSorted(
    (a, b) =>
      ORDER[waitsOn(a.stage)] - ORDER[waitsOn(b.stage)] ||
      askedBy(b).length - askedBy(a).length ||
      firstAsked(a).localeCompare(firstAsked(b)) ||
      a.app.localeCompare(b.app)
  );

/**
 * The build as the console's rollout has it, when its merge is in the release that rollout takes
 * out: each company that asked stands where the rollout's target for it stands, so the admin's
 * integrations and its platforms say the same. Once every one of them runs it, the build is live.
 * A build in another release, or none, is as it was.
 */
export const withRollout = (
  build: IntegrationBuild,
  rollout: Rollout
): IntegrationBuild => {
  const { work } = build;
  if (
    work?.release === undefined ||
    work.release === "" ||
    work.release !== rollout.release ||
    (build.stage !== "rollout" && build.stage !== "live")
  ) {
    return build;
  }
  const day = rollout.at.slice(0, 10);
  const entries = askedBy(build).map((org): OrgRollout => {
    const before = work.rollout?.find((each) => each.org === org);
    const target = rollout.targets.find((each) => each.org === org);
    if (!target) {
      return before ?? { org, ring: 2, status: "pending", live: null };
    }
    return {
      org,
      ring: target.ring,
      status: target.status,
      live: target.status === "done" ? (before?.live ?? day) : null,
    };
  });
  const live = entries.every((each) => each.status === "done");
  return {
    ...build,
    stage: live ? "live" : "rollout",
    reached: live
      ? { ...build.reached, live: build.reached.live ?? day }
      : build.reached,
    work: { ...work, rollout: entries },
  };
};
