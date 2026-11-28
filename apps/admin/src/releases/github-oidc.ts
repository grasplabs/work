/**
 * Which CI run a request comes from, as GitHub vouches for it: the
 * OpenID Connect token GitHub Actions gives a job with `id-token: write`,
 * sent as a bearer token. The admin trusts a request with one only when
 * it's CI's publish of a release: the CI workflow of grasplabs/work, run
 * for a push to main, in the stage's GitHub environment, on GitHub's own
 * runners, and for this admin (the token's audience is the admin's
 * origin, so one asked for staging's admin never passes at production's).
 *
 * A token lives about five minutes, and is asked for anew for each
 * request (scripts/release/publisher-lib.ts). A run's token says nothing of
 * the code it runs beyond its commit: what main holds is what CI does.
 * Claims and keys as at token.actions.githubusercontent.com/.well-known/
 * openid-configuration (read 27 November 2026).
 */
import "@tanstack/react-start/server-only";
import { errors } from "jose";
import { z } from "zod";

import { verifyIssuerJwt } from "../issuer-keys.ts";

export const githubIssuer = "https://token.actions.githubusercontent.com";

/**
 * The publish run's claims, each exactly. The repository by its id too,
 * which a repository deleted and made again under the same name doesn't
 * keep; `workflow_ref` pins the workflow file and the branch it ran from.
 */
const publishRunSchema = z.object({
  repository: z.literal("grasplabs/work"),
  repository_id: z.literal("1386316902"),
  workflow_ref: z.literal(
    "grasplabs/work/.github/workflows/ci.yml@refs/heads/main"
  ),
  // The job's own workflow, where GitHub names one: never a reusable
  // workflow ci.yml calls.
  job_workflow_ref: z
    .literal("grasplabs/work/.github/workflows/ci.yml@refs/heads/main")
    .optional(),
  ref: z.literal("refs/heads/main"),
  event_name: z.literal("push"),
  runner_environment: z.literal("github-hosted"),
  environment: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  run_id: z.string(),
  run_attempt: z.string(),
});

/** A publish run GitHub vouches for: the commit it runs, and the run. */
export interface PublishRun {
  commit: string;
  runId: string;
  runAttempt: string;
}

/**
 * The publish run `request`'s bearer token names, for the admin of
 * `stage` (its GitHub environment's name); null when it has none, it
 * doesn't verify, or it's any other run. Throws when GitHub's keys can't
 * be fetched, which may pass.
 */
export const publishRunOf = async (
  request: Request,
  stage: string
): Promise<PublishRun | null> => {
  const [scheme, token] = (request.headers.get("authorization") ?? "").split(
    " "
  );
  if (scheme?.toLowerCase() !== "bearer" || token === undefined) {
    return null;
  }
  try {
    const { payload } = await verifyIssuerJwt(token, {
      issuer: githubIssuer,
      audience: new URL(request.url).origin,
      keysUrl: `${githubIssuer}/.well-known/jwks`,
    });
    const run = publishRunSchema.parse(payload);
    if (run.environment !== stage) {
      return null;
    }
    return { commit: run.sha, runId: run.run_id, runAttempt: run.run_attempt };
  } catch (error) {
    if (error instanceof errors.JOSEError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
};
