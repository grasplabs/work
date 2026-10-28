/**
 * The approved plan of a build, signed (GRA-689): what the agent's session
 * puts in the new connector's folder, and what CI holds the branch to
 * (the repository's scripts/connector-guard.ts). The admin signs with
 * `PLAN_SIGNING_KEY`, an Ed25519 private key in Secrets Store that only it
 * reads; CI verifies with its public half, the repository variable
 * `CONNECTOR_PLAN_KEY`. The agent never holds the key, so it can't sign a
 * plan nobody approved, nor change the hosts of one somebody did.
 *
 * Only a plan a person approved is signed, and only while its build goes
 * on from that approval: a build sent back, stopped or never approved
 * gets no signature. The signature covers the app, the plan round the
 * person approved and the plan itself, so it passes for no other app and
 * no other round.
 */
import {
  planDocumentText,
  signPlanText,
} from "@grasp-os/connector-kit/plan-signature";

import { adminDatabase } from "../db/act.ts";
import { storeSecret } from "../deploy/context.ts";
import { BuildError, buildOf } from "./builds.ts";
import type { BuildStage } from "./builds.ts";

/** The stages a build is in after a person approved its plan. */
const approvedStages: ReadonlySet<BuildStage> = new Set([
  "credentials",
  "writing",
  "in_review",
  "merged",
]);

/** A build's approved plan, as the connector's folder carries it. */
export interface SignedPlanFiles {
  /** The plan document's exact text (`planDocumentText`). */
  text: string;
  /** Its Ed25519 signature, base64. */
  signature: string;
}

/**
 * The approved plan of the build of `app`, signed: refused with
 * `wrong_stage` unless a person approved it and the build goes on from
 * there, and `unknown_build` when there is none.
 */
export const signedPlan = async (
  env: Env,
  app: string
): Promise<SignedPlanFiles> => {
  const build = await buildOf(adminDatabase(env.DB), app);
  if (build === null) {
    throw new BuildError("unknown_build", `There is no build of ${app}`);
  }
  if (
    build.plan === null ||
    build.approvedBy === null ||
    !approvedStages.has(build.stage)
  ) {
    throw new BuildError(
      "wrong_stage",
      `The build of ${app} has no plan a person approved`
    );
  }
  const text = planDocumentText({
    app,
    round: build.planRound,
    plan: build.plan,
  });
  const key = await storeSecret(env, "PLAN_SIGNING_KEY");
  return { text, signature: await signPlanText(key, text) };
};
