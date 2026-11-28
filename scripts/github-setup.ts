/**
 * Applies the repository settings, the branch rulesets in
 * `.github/rulesets` and the release signing key's environment
 * (scripts/release/signing-environment-lib.ts) to GitHub, so they are
 * versioned and reviewed like code. Re-run after any change: existing
 * rulesets are updated by name, and the environment is read back and
 * checked. Needs `gh` signed in as an admin of the repository.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  applySigningEnvironment,
  githubApi,
  SIGNING_ENVIRONMENT,
  signingEnvironmentProblem,
} from "./release/signing-environment-lib.ts";

const RULESETS_DIR = path.join(import.meta.dirname, "../.github/rulesets");

/** Squash merges into main through the merge queue, nothing else. */
const REPOSITORY_SETTINGS = {
  allow_auto_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_squash_merge: true,
  allow_update_branch: true,
  default_branch: "main",
  delete_branch_on_merge: true,
  security_and_analysis: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
  squash_merge_commit_message: "PR_BODY",
  squash_merge_commit_title: "PR_TITLE",
};

const gh = (args: string[], input?: string): string =>
  execFileSync("gh", args, { encoding: "utf-8", input });

const repo = gh([
  "repo",
  "view",
  "--json",
  "nameWithOwner",
  "--jq",
  ".nameWithOwner",
]).trim();

gh(
  ["api", "--method", "PATCH", `repos/${repo}`, "--input", "-"],
  JSON.stringify(REPOSITORY_SETTINGS)
);
console.info(`Updated settings for ${repo}`);

// Ruleset ids by name, one "<id> <name>" per line.
const existing = new Map(
  gh([
    "api",
    `repos/${repo}/rulesets`,
    "--jq",
    String.raw`.[] | "\(.id) \(.name)"`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", name = ""] = line.split(" ");
      return [name, id] as const;
    })
);

// Each file is named after its ruleset: main.json holds "main".
for (const file of readdirSync(RULESETS_DIR)) {
  const name = path.basename(file, ".json");
  const body = readFileSync(path.join(RULESETS_DIR, file), "utf-8");
  const id = existing.get(name);
  const [method, endpoint] =
    id === undefined
      ? ["POST", `repos/${repo}/rulesets`]
      : ["PUT", `repos/${repo}/rulesets/${id}`];
  gh(["api", "--method", method, endpoint, "--input", "-"], body);
  console.info(`${id === undefined ? "Created" : "Updated"} ruleset ${name}`);
}

const api = githubApi(gh(["auth", "token"]).trim());
await applySigningEnvironment(api, repo);
const problem = await signingEnvironmentProblem(api, repo);
if (problem !== undefined) {
  throw new Error(`${problem}, read back after setting it`);
}
console.info(`Set environment ${SIGNING_ENVIRONMENT}: main alone may use it`);
