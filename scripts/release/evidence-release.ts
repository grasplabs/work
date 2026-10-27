/**
 * Writes a release's limit evidence (evidence-lib.ts) into its directory,
 * at publish, for upload-release.ts to put next to its manifest. Fails,
 * so nothing is published, when the release raises a platform limit over
 * the release before it without evidence for it.
 *
 * The evidence for each raise comes from the capacity job's results
 * (`--capacity`, scripts/capacity/run-capacity.ts), each with this CI
 * job's id and the security review of the change: the pull request
 * merged as the release's commit and its CODEOWNER's approval
 * (review-lib.ts), read from GitHub's API. Nothing is asked of GitHub for
 * a release that raises nothing.
 *
 * Env, with capacity results: GITHUB_TOKEN, GITHUB_REPOSITORY,
 *      GITHUB_API_URL, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, and CI_JOB_NAME,
 *      this job's name
 * Usage: vp run release:evidence --release <dir> --previous <file>
 *        [--capacity <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { limitEvidenceFile } from "@grasp-os/shared/release";
import { z } from "zod";

import { evidenceFromCapacity, limitEvidenceFor } from "./evidence-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";
import { catchAllOwners, mergedAs, ownerApproval } from "./review-lib.ts";
import type { SecurityReview } from "./review-lib.ts";

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    previous: { type: "string" },
    capacity: { type: "string" },
  },
});
if (args.release === undefined || args.previous === undefined) {
  throw new Error("--release <dir> and --previous <file> are required");
}
const releaseDir = path.resolve(args.release);
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.resolve(file), "utf-8"));

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

/** GitHub's API, as this job's token reads it. */
const github = async (
  route: string,
  accept = "application/vnd.github+json"
): Promise<Response> => {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(
    `${api}/repos/${requireEnv("GITHUB_REPOSITORY")}/${route}`,
    {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub ${route}: ${response.status}`);
  }
  return response;
};

/** Every page of a list `route` answers. */
const pages = async (route: string): Promise<unknown[]> => {
  const all: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const separator = route.includes("?") ? "&" : "?";
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const response = await github(
      `${route}${separator}per_page=100&page=${page}`
    );
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const items = z.array(z.unknown()).parse(await response.json());
    all.push(...items);
    if (items.length < 100) {
      return all;
    }
  }
};

/** The security review of commit `commit`: its pull request and CODEOWNER's approval. */
const securityReviewOf = async (commit: string): Promise<SecurityReview> => {
  const pull = mergedAs(await pages(`commits/${commit}/pulls`), commit);
  const owners = await github(
    `contents/.github/CODEOWNERS?ref=${commit}`,
    "application/vnd.github.raw+json"
  );
  const codeowners = await owners.text();
  return ownerApproval(
    pull,
    await pages(`pulls/${pull.number}/reviews`),
    catchAllOwners(codeowners)
  );
};

/** This CI job's id, by its name in this run's attempt. */
const thisJobId = async (): Promise<number> => {
  const name = requireEnv("CI_JOB_NAME");
  const response = await github(
    `actions/runs/${requireEnv("GITHUB_RUN_ID")}/attempts/${requireEnv("GITHUB_RUN_ATTEMPT")}/jobs?per_page=100`
  );
  const { jobs } = z
    .object({ jobs: z.array(z.object({ id: z.int(), name: z.string() })) })
    .parse(await response.json());
  const job = jobs.find((each) => each.name === name);
  if (job === undefined) {
    throw new Error(`No job ${name} in this run`);
  }
  return job.id;
};

const { manifest } = await verifyRelease(releaseDir);
const results =
  args.capacity === undefined
    ? []
    : z.array(z.unknown()).parse(readJson(args.capacity));
const evidence =
  results.length === 0
    ? []
    : evidenceFromCapacity(
        manifest,
        results,
        await thisJobId(),
        await securityReviewOf(manifest.commit)
      );
const file = limitEvidenceFor(manifest, readJson(args.previous), evidence);
writeFileSync(
  path.join(releaseDir, limitEvidenceFile),
  `${JSON.stringify(file, null, 2)}\n`
);
console.info(
  `Release ${manifest.releaseId}: raised over ${file.previousRelease?.releaseId ?? "nothing"}, ${file.limitEvidence.length} evidence entries`
);
