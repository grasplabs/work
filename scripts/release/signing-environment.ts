/**
 * The release signing key's GitHub environment (signing-environment-lib.ts):
 *
 * - `check` (CI's signing-environment job, before sign-release): fails
 *   unless the environment lets main alone use it, with no admin bypass.
 *   It reads only what anyone can read of a public repository, with the
 *   job's own token.
 * - `key` (`vp run release:signing-key`, by an owner, with `gh` signed in
 *   as a repository admin): sets the environment so, reads it back, and
 *   only once the check passes makes an Ed25519 key on this machine, puts
 *   its private half in the environment's secret through `gh secret set`
 *   (never on disk, never printed) and prints the public half for
 *   packages/shared/src/release-signing-keys.ts. Run again to rotate: the
 *   new public key goes in the list beside the old one first.
 *
 * Nothing but Node's built-ins, so CI's check runs before any install.
 *
 * Env: `check`: GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL (GitHub sets them)
 * Usage: node scripts/release/signing-environment.ts check | key
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

import {
  applySigningEnvironment,
  githubApi,
  SIGNING_ENVIRONMENT,
  SIGNING_SECRET,
  signingEnvironmentProblem,
} from "./signing-environment-lib.ts";

const gh = (args: string[], input?: string): string =>
  execFileSync("gh", args, { encoding: "utf-8", input }).trim();

const [command] = process.argv.slice(2);

if (command === "check") {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const api = githubApi(
    process.env.GITHUB_TOKEN ?? "",
    process.env.GITHUB_API_URL
  );
  const problem = await signingEnvironmentProblem(api, repo);
  if (problem !== undefined) {
    throw new Error(`${problem}; nothing may be signed until it's fixed`);
  }
  console.info(`${SIGNING_ENVIRONMENT} lets main alone use it`);
} else if (command === "key") {
  const repo = gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  const api = githubApi(gh(["auth", "token"]));
  await applySigningEnvironment(api, repo);
  const problem = await signingEnvironmentProblem(api, repo);
  if (problem !== undefined) {
    throw new Error(`${problem}, read back after setting it; no key made`);
  }
  const jwk = generateKeyPairSync("ed25519").privateKey.export({
    format: "jwk",
  });
  gh(
    [
      "secret",
      "set",
      SIGNING_SECRET,
      "--env",
      SIGNING_ENVIRONMENT,
      "--repo",
      repo,
    ],
    JSON.stringify(jwk)
  );
  console.info(
    `${SIGNING_ENVIRONMENT} lets main alone use it, and holds the new key as ${SIGNING_SECRET}.\nPut its public key in packages/shared/src/release-signing-keys.ts:\n  ${String(jwk.x)}`
  );
} else {
  throw new Error("Usage: signing-environment.ts check | key");
}
