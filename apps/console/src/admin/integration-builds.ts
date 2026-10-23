/**
 * Where each integration to build stands, as the prototype works it out
 * (grasplabs/prototype `lib/admin-integrations.ts`: `waitsOn`,
 * `needsGrasp`, `sortBuilds`, `stepsOf`), from what the console has: the
 * apps the companies asked for (`askedApps`) and the builds it records
 * (src/builds/builds.ts), met by the app's key.
 *
 * The console's build has fewer stages than the prototype's steps: it
 * writes, tests and reviews itself all in `writing`, and what comes
 * after the merge (the release, the rollout, live) is the releases', not
 * the build's. So `writing` stands on the writing step until the pull
 * request is open, and a merged build stands on merged. A build that
 * needs a person stands, waiting on Grasp, on the step it stopped at.
 * Pure.
 */
import {
  BUILD_STAGES,
  waitsOn,
} from "@grasp-os/shared/admin/admin-integrations";
import type {
  BuildStep,
  Waiter,
} from "@grasp-os/shared/admin/admin-integrations";

import type { BuildStage } from "../builds/builds.ts";
import type { BuildRecord } from "../builds/functions.ts";
import type { AppAsk, AskedApp } from "./integrations-asked.ts";

/** One app to build: who asked for it, and its build once Build it was confirmed. */
export interface IntegrationRow {
  /** The app's key: its connector name once it has a build. */
  key: string;
  name: string;
  /** The companies that asked, in the order they asked; none for a build no company asks for now. */
  asks: AppAsk[];
  build: BuildRecord | null;
}

/** The prototype's step each of the console's stages stands on; a build that needs a person, on the one it stopped at. */
const stepOfStage: Record<Exclude<BuildStage, "needs_person">, BuildStep> = {
  asked: "requested",
  researching: "researching",
  plan_ready: "plan",
  credentials: "credentials",
  writing: "writing",
  in_review: "review",
  merged: "merged",
};

/** The step a build stands on, or `requested` before Build it. */
export const stepOf = (build: BuildRecord | null): BuildStep => {
  if (build === null) {
    return "requested";
  }
  const stage = build.stage === "needs_person" ? build.stoppedAt : build.stage;
  return stage === null || stage === "needs_person"
    ? "requested"
    : stepOfStage[stage];
};

/**
 * Who the app waits on now: Grasp to start it, or wherever its build
 * stands. A build that needs a person waits on Grasp; one confirmed but
 * whose run hasn't started researching yet waits on its run.
 */
export const waiterOf = ({ build }: IntegrationRow): Waiter => {
  if (build === null || build.stage === "needs_person") {
    return "grasp";
  }
  if (build.stage === "asked") {
    return "agent";
  }
  return waitsOn(stepOf(build));
};

/** Whether a person at Grasp has to do something for the app's build to go on. */
export const needsGrasp = (row: IntegrationRow): boolean =>
  waiterOf(row) === "grasp";

/** Where one step of the build stands. */
export type StepState = "done" | "now" | "later";

/** The steps where a person at Grasp decides: the plan, the credentials, the review, the rollout. */
const personSteps: ReadonlySet<BuildStep> = new Set([
  "plan",
  "credentials",
  "review",
  "rollout",
]);

/** The build's steps, each done, now or later, and whether a person decides there. */
export const stepsOf = (
  row: IntegrationRow
): { step: BuildStep; state: StepState; person: boolean }[] => {
  const at = BUILD_STAGES.indexOf(stepOf(row.build));
  return BUILD_STAGES.map((step, index) => {
    let state: StepState = "later";
    if (index < at) {
      state = "done";
    } else if (index === at) {
      state = "now";
    }
    return { step, state, person: personSteps.has(step) };
  });
};

const order: Record<Waiter, number> = {
  grasp: 0,
  agent: 1,
  company: 2,
  nobody: 3,
};

/** The day the app was first asked for, or its build started where no company asks now. */
const firstAsked = (row: IntegrationRow): string =>
  row.asks[0]?.on ?? row.build?.createdAt ?? "";

/**
 * Every app asked for, and every build, once each by key: what waits on
 * Grasp first, then what Grasp's agent is on, then the rest. Within each,
 * the app most companies asked for first, then the one asked for longest
 * ago, as the prototype's `sortBuilds`.
 */
export const integrationRows = (
  asked: readonly AskedApp[],
  builds: readonly BuildRecord[]
): IntegrationRow[] => {
  const byKey = new Map(builds.map((build) => [build.app, build]));
  const rows: IntegrationRow[] = asked.map((app) => ({
    ...app,
    build: byKey.get(app.key) ?? null,
  }));
  const keys = new Set(asked.map((app) => app.key));
  for (const build of builds) {
    if (!keys.has(build.app)) {
      rows.push({ key: build.app, name: build.name, asks: [], build });
    }
  }
  return rows.toSorted(
    (a, b) =>
      order[waiterOf(a)] - order[waiterOf(b)] ||
      b.asks.length - a.asks.length ||
      firstAsked(a).localeCompare(firstAsked(b)) ||
      a.name.localeCompare(b.name)
  );
};
