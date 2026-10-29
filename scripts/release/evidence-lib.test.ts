import { describe, expect, it } from "vite-plus/test";

import {
  evidenceFromCapacity,
  limitEvidenceFor,
  previousReleaseOf,
} from "./evidence-lib.ts";
import { builds, info } from "./fixture-release.ts";
import { generateManifest } from "./manifest-lib.ts";

const manifest = generateManifest(info, await builds());

/** The fixture's limits, `workflowSteps` lower: what it raises over. */
const before = (releaseId = "r000000-0000000") => ({
  releaseId,
  platformLimits: { ...info.platformLimits, workflowSteps: 500 },
});

describe("a release's limit evidence at publish", () => {
  it("is raised over the release published before it, and nothing when that one recorded no limits or there was none", () => {
    expect({
      none: previousReleaseOf(null),
      unrecorded: previousReleaseOf({ releaseId: "r000000-0000000" }),
      recorded: previousReleaseOf(before()),
    }).toStrictEqual({ none: null, unrecorded: null, recorded: before() });
  });

  it("refuses a raise without evidence, and evidence for another release, so nothing is published", () => {
    const raising = (): unknown => limitEvidenceFor(manifest, before());
    const borrowed = (): unknown =>
      limitEvidenceFor(manifest, before(), [
        {
          limit: "workflowSteps",
          raisedTo: 1000,
          commit: manifest.commit,
          releaseId: "r000000-0000000",
          profile: "cloudflare",
          capacityRun: {
            jobId: 1,
            commit: manifest.commit,
            profile: "cloudflare",
          },
          securityReviews: [{ pullRequest: 1, approvedBy: "nickruigrok" }],
        },
      ]);
    const itself = (): unknown =>
      limitEvidenceFor(manifest, before(manifest.releaseId));
    expect(raising).toThrow(/raises workflowSteps to 1000 without capacity/u);
    expect(borrowed).toThrow(/is for release r000000-0000000/u);
    expect(itself).toThrow(/is its own previous/u);
  });

  it("writes the release's own file, with each raise's evidence", () => {
    const evidence = {
      limit: "workflowSteps",
      raisedTo: 1000,
      commit: manifest.commit,
      releaseId: manifest.releaseId,
      profile: "workerd" as const,
      capacityRun: {
        jobId: 7,
        commit: manifest.commit,
        profile: "workerd" as const,
      },
      securityReviews: [{ pullRequest: 3, approvedBy: "nickruigrok" }],
    };

    expect(limitEvidenceFor(manifest, before(), [evidence])).toStrictEqual({
      releaseId: manifest.releaseId,
      commit: manifest.commit,
      previousRelease: before(),
      limitEvidence: [evidence],
    });
  });

  it("makes an entry of each passing capacity run, with the job and the review, that the release's own check takes", () => {
    const evidence = evidenceFromCapacity(
      manifest,
      [
        {
          limit: "workflowSteps",
          raisedTo: 1000,
          profile: "workerd",
          commit: manifest.commit,
        },
      ],
      987_654,
      [{ pullRequest: 42, approvedBy: "nickruigrok" }]
    );

    expect(
      limitEvidenceFor(manifest, before(), evidence).limitEvidence
    ).toStrictEqual([
      {
        limit: "workflowSteps",
        raisedTo: 1000,
        commit: manifest.commit,
        releaseId: manifest.releaseId,
        profile: "workerd",
        capacityRun: {
          jobId: 987_654,
          commit: manifest.commit,
          profile: "workerd",
        },
        securityReviews: [{ pullRequest: 42, approvedBy: "nickruigrok" }],
      },
    ]);
  });
});
