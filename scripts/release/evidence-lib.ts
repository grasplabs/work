/**
 * A release's limit evidence, as CI's publish writes it next to the
 * manifest (evidence-release.ts; @grasp-os/shared/release,
 * `limitEvidenceFileSchema`): what its platform limits are raised over
 * (the release published before it), and an entry per raised limit and
 * profile. Refused, so nothing is published, when a raise has no evidence
 * or the evidence isn't the release's own (`verifyLimitEvidence`).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  limitEvidenceFile,
  limitEvidenceFileSchema,
  limitEvidenceSchema,
  platformLimitsSchema,
  runtimeProfileSchema,
  verifyLimitEvidence,
} from "@grasp-os/shared/release";
import type {
  LimitEvidence,
  LimitEvidenceFile,
  PreviousRelease,
  ReleaseManifest,
} from "@grasp-os/shared/release";
import { releaseIdSchema } from "@grasp-os/shared/release-id";
import { z } from "zod";

/**
 * The release before, from its manifest as previous-release.ts fetched it
 * (`null` when nothing was published before). One from before limits were
 * recorded has none: this release is then the first that records them,
 * and raises nothing.
 */
export const previousReleaseOf = (previous: unknown): PreviousRelease => {
  const parsed = z
    .object({
      releaseId: releaseIdSchema,
      platformLimits: platformLimitsSchema.optional(),
    })
    .nullable()
    .parse(previous);
  return parsed?.platformLimits === undefined
    ? null
    : { releaseId: parsed.releaseId, platformLimits: parsed.platformLimits };
};

/**
 * The limit evidence file for `manifest`, raised over `previous` with the
 * entries `evidence` gives (GRA-942 produces them; none until then).
 * Throws unless it is exactly what the release's raises need.
 */
export const limitEvidenceFor = (
  manifest: ReleaseManifest,
  previous: unknown,
  evidence: unknown = []
): LimitEvidenceFile => {
  if (manifest.platformLimits === undefined) {
    throw new Error(
      `Release ${manifest.releaseId} records no platform limits: build it again`
    );
  }
  const previousRelease = previousReleaseOf(previous);
  if (previousRelease?.releaseId === manifest.releaseId) {
    throw new Error(`Release ${manifest.releaseId} is its own previous`);
  }
  const file = limitEvidenceFileSchema.parse({
    releaseId: manifest.releaseId,
    commit: manifest.commit,
    previousRelease,
    limitEvidence: z.array(limitEvidenceSchema).parse(evidence),
  });
  verifyLimitEvidence({ ...file, platformLimits: manifest.platformLimits });
  return file;
};

/**
 * The bytes of the limit evidence file in `releaseDir`, checked against
 * `manifest` as the admin's import checks them: required of a release that
 * records limits, the release's own, and covering each of its raises.
 * Undefined for one that records none (built before limits were).
 */
export const readLimitEvidence = (
  releaseDir: string,
  manifest: ReleaseManifest
): Buffer | undefined => {
  if (manifest.platformLimits === undefined) {
    return undefined;
  }
  const file = path.join(releaseDir, limitEvidenceFile);
  if (!existsSync(file)) {
    throw new Error(
      `Release ${manifest.releaseId} has no ${limitEvidenceFile}: run release:evidence first`
    );
  }
  const bytes = readFileSync(file);
  const evidence = limitEvidenceFileSchema.parse(
    JSON.parse(bytes.toString("utf-8"))
  );
  if (
    evidence.releaseId !== manifest.releaseId ||
    evidence.commit !== manifest.commit
  ) {
    throw new Error(
      `${limitEvidenceFile} is for ${evidence.releaseId} at ${evidence.commit}, not ${manifest.releaseId} at ${manifest.commit}`
    );
  }
  verifyLimitEvidence({ ...evidence, platformLimits: manifest.platformLimits });
  return bytes;
};

/** A capacity run's result (scripts/capacity), as evidence-lib reads it. */
const capacityResultsSchema = z.array(
  z.strictObject({
    limit: z.string(),
    raisedTo: z.int().nonnegative().nullable(),
    profile: runtimeProfileSchema,
    commit: z.string(),
  })
);

/**
 * The evidence entries for `manifest` from its capacity runs (`results`,
 * run-capacity.ts's output) in CI job `jobId`, each with the security
 * review of the change: one per raised limit and profile that passed.
 */
export const evidenceFromCapacity = (
  manifest: ReleaseManifest,
  results: unknown,
  jobId: number,
  securityReviews: readonly { pullRequest: number; approvedBy: string }[]
): LimitEvidence[] =>
  capacityResultsSchema.parse(results).map((result) => ({
    limit: result.limit,
    raisedTo: result.raisedTo,
    commit: manifest.commit,
    releaseId: manifest.releaseId,
    profile: result.profile,
    capacityRun: { jobId, commit: result.commit, profile: result.profile },
    securityReviews: [...securityReviews],
  }));
