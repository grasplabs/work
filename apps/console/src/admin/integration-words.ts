/**
 * The admin's words for the integrations Grasp builds into the platform,
 * as the prototype has them (grasplabs/prototype
 * `components/admin/integration-words.ts`). The console speaks English
 * only, so they are written here, not translated.
 */
import type { BuildStep } from "@grasp-os/shared/admin/admin-integrations";

import type { BuildRecord } from "../builds/functions.ts";
import type { BuildPlan } from "../builds/plan.ts";
import type { IntegrationRow } from "./integration-builds.ts";

/** Each step of a build in a word or two, as the list and the build show it. */
export const stepWords: Record<BuildStep, string> = {
  requested: "Asked for",
  researching: "Researching",
  plan: "Plan ready",
  credentials: "Credentials",
  writing: "Writing",
  testing: "Testing",
  selfReview: "Self-review",
  review: "In review",
  merged: "Merged",
  rollout: "Rolling out",
  live: "Live",
};

/** What happens at each step, for the step a build stands on. */
export const stepLines: Record<BuildStep, string> = {
  requested: "A company asked for it, and Composio does not have it.",
  researching:
    "Grasp’s agent reads the app’s docs and writes a plan: the actions, what each may reach, and how it signs in.",
  plan: "A person at Grasp approves the plan, or sends it back.",
  credentials:
    "A person at Grasp registers Grasp with the app and puts the keys in the console. The agent never sees them.",
  writing:
    "The agent writes the connection and its tests, on a branch of its own.",
  testing: "The checks and tests run, against a stand-in for the app.",
  selfReview:
    "A second agent checks the work against Grasp’s rules for connections.",
  review: "Nick or Jakob reviews the pull request and merges it.",
  merged: "It goes into the next release by itself.",
  rollout:
    "The release reaches the companies ring by ring, as a person at Grasp approves each.",
  live: "Every company that asked can connect it, like any other app.",
};

/** How Grasp signs in to the app, as the plan says. */
export const signInWords: Record<BuildPlan["signIn"], string> = {
  oauth2: "Sign-in with OAuth2, Grasp’s own app at the provider",
  api_key: "An API key each company gives",
};

/** Why a build stopped for a person, by its run's code (src/builds/workflow.ts). */
const reasonWords: Record<string, string> = {
  researching_timed_out: "The agent wrote no plan within a day.",
  plan_ready_timed_out: "Nobody approved or sent back the plan within 30 days.",
  credentials_timed_out: "Nobody added the credentials within 30 days.",
  writing_timed_out: "The agent opened no pull request within a day.",
  in_review_timed_out: "The pull request wasn’t merged within 30 days.",
  too_many_plans: "No plan was approved in 5 rounds.",
};

/** Why a build stopped for a person, in a sentence; a code the page doesn't know, as it is. */
export const reasonLine = (reason: string | null): string =>
  reason === null
    ? "Its run stopped."
    : (reasonWords[reason] ?? `Its run stopped: ${reason}.`);

/** What a build the console records waits for now. */
const buildWaitingLine = (build: BuildRecord): string => {
  switch (build.stage) {
    case "asked": {
      return "Grasp’s agent is starting";
    }
    case "researching": {
      return "Grasp’s agent is reading the docs";
    }
    case "plan_ready": {
      return "The plan waits for Grasp’s approval";
    }
    case "credentials": {
      return "Waiting for Grasp to add the credentials";
    }
    case "writing": {
      return "Grasp’s agent is writing it";
    }
    case "in_review": {
      return "Waiting for Nick or Jakob to review the pull request";
    }
    case "merged": {
      return "Goes into the next release by itself";
    }
    case "needs_person": {
      return "Needs a person at Grasp";
    }
    default: {
      return build.stage satisfies never;
    }
  }
};

/** What the build waits for now, in a line: the one thing that moves it on. */
export const waitingLine = ({ build }: IntegrationRow): string => {
  if (build === null) {
    return "Waiting for Grasp to start it";
  }
  return buildWaitingLine(build);
};
