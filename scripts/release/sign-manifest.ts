/**
 * Signs a release's manifest, as CI's `sign-release` job does with each
 * merge (.github/workflows/ci.yml): the one place the private key is
 * used. The job holds it as a secret of the `release-signing` GitHub
 * environment, which only main may use, and runs nothing but GitHub's own
 * actions and this file, on the runner's own Node: no install, no
 * dependency, nothing of the repo's but this. So it imports nothing but
 * Node's built-ins (scripts/release/sign-manifest.test.ts holds it to
 * that, and to the job's shape).
 *
 * What it signs, it checks first: the run is a push to main, and the
 * manifest is a release manifest of this very commit (`GITHUB_SHA`),
 * under a published id (`YY.MM.N`), as the publish's stage job stamped
 * it. Its contents it can't check: what the run's
 * build and stage jobs made is what's signed. The signature proves "CI
 * built this from that commit on main", not that its dependencies were
 * clean.
 *
 * It writes the signature file beside the manifest
 * (`manifest.signature.json`): an Ed25519 signature over
 * "grasp-release-manifest\n" and the manifest's exact bytes, with the
 * public key, both base64url. Every verifier reads it with the shared
 * package's release-signature module, which builds the same bytes; this
 * file's tests verify what it signs there.
 *
 * Env: RELEASE_SIGNING_KEY (the Ed25519 private key, as a JWK), and
 *      GITHUB_EVENT_NAME, GITHUB_REF and GITHUB_SHA, which GitHub sets
 * Usage: node scripts/release/sign-manifest.ts <dir holding manifest.json>
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const fail = (reason: string): never => {
  throw new Error(`${reason}; nothing signed`);
};

const env = (name: string): string =>
  process.env[name] ?? fail(`${name} is required`);

/** `name` of a parsed JSON value, if it's an object that has it. */
const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;

/** `text` as JSON, or the end with `reason`. */
const parsed = (text: string, reason: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return fail(reason);
  }
};

const dir = process.argv[2] ?? fail("Usage: sign-manifest.ts <release dir>");

if (env("GITHUB_EVENT_NAME") !== "push") {
  fail(`Only a push signs a release, not ${env("GITHUB_EVENT_NAME")}`);
}
if (env("GITHUB_REF") !== "refs/heads/main") {
  fail(`Only main signs a release, not ${env("GITHUB_REF")}`);
}

const manifestBytes = readFileSync(path.join(dir, "manifest.json"));
const manifest = parsed(
  manifestBytes.toString("utf-8"),
  "manifest.json isn't JSON"
);

const commit = fieldOf(manifest, "commit");
if (commit !== env("GITHUB_SHA")) {
  fail(
    `The manifest is commit ${String(commit)}'s; this run is ${env("GITHUB_SHA")}'s`
  );
}
// A published id (`YY.MM.N`, @grasp-os/shared/release-id), never a local
// build's: the stage job stamped it.
const releaseId = fieldOf(manifest, "releaseId");
if (
  typeof releaseId !== "string" ||
  !/^\d{2}\.(?:0[1-9]|1[0-2])\.[1-9]\d{0,8}$/u.test(releaseId)
) {
  fail(`Release ${String(releaseId)} isn't a published release's id`);
}

// An Ed25519 key, whatever else the JWK says; its public half as the
// private one makes it, never as the JWK says.
const jwk = parsed(
  env("RELEASE_SIGNING_KEY"),
  "RELEASE_SIGNING_KEY isn't a JWK"
);
const privateKey = (() => {
  const d = fieldOf(jwk, "d");
  const x = fieldOf(jwk, "x");
  const notKey = "RELEASE_SIGNING_KEY isn't an Ed25519 private key as a JWK";
  if (typeof d !== "string" || typeof x !== "string") {
    return fail(notKey);
  }
  try {
    return createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d, x },
      format: "jwk",
    });
  } catch {
    return fail(notKey);
  }
})();
const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;

const signature = sign(
  null,
  Buffer.concat([Buffer.from("grasp-release-manifest\n"), manifestBytes]),
  privateKey
);
writeFileSync(
  path.join(dir, "manifest.signature.json"),
  JSON.stringify({ key: publicKey, signature: signature.toString("base64url") })
);
console.info(`Signed release ${String(releaseId)} of ${String(commit)}`);
