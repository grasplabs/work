/**
 * Signs a release's manifest, as CI's `sign-release` job does with each
 * merge (.github/workflows/ci.yml). The key is in Google Cloud KMS, which
 * never lets it out; this job holds no secret. It proves who it is with
 * GitHub's OIDC token for the job, which Google's Security Token Service
 * exchanges for a short-lived access token only when the token's claims
 * meet the workload identity provider's condition (this repository by id
 * and name, main, a push, ci.yml, a GitHub-hosted runner, the
 * `release-signing` environment, which no other job names); the key's
 * IAM policy lets that identity alone sign with it. The job runs nothing
 * but GitHub's own actions and this file, on the runner's own Node: no
 * install, no dependency, nothing of the repo's but this and the
 * identifiers it reads (release-signing.json, beside it). So it imports
 * nothing but Node's built-ins (scripts/release/sign-manifest.test.ts
 * holds it to that, and to the job's shape).
 *
 * What it signs, it checks first: the run is a push to main, and the
 * manifest is a release manifest of this very commit (`GITHUB_SHA`),
 * under an id of this month (`YY.MM.N`), as the publish's stage job
 * stamped it. Its contents it can't check: what the run's build and
 * stage jobs made is what's signed. The signature proves "CI built this
 * from that commit on main", not that its dependencies were clean.
 *
 * KMS signs, with Ed25519, "grasp-release-manifest\n", the id, "\n" and
 * the manifest's SHA-256 (hex), the bytes every verifier rebuilds with
 * the shared package's release-signature module; this file's tests verify
 * what it signs there. Both ways the bytes are checked against CRC32C as
 * KMS asks, and the answer must name the key version asked for. It writes
 * the signature file beside the manifest (`manifest.signature.json`):
 * the algorithm, the key version (the key's id in the trusted list) and
 * the signature, base64url. A failure fails the job; the next merge, or
 * a re-run, signs again.
 *
 * Env: ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN
 *      (GitHub sets them for a job with `id-token: write`), and
 *      GITHUB_EVENT_NAME, GITHUB_REF and GITHUB_SHA
 * Usage: node scripts/release/sign-manifest.ts <dir holding manifest.json>
 */
import { createHash } from "node:crypto";
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

/** `name` of `value`, a string matching `pattern`, or the end with `reason`. */
const stringOf = (
  value: unknown,
  name: string,
  pattern: RegExp,
  reason: string
): string => {
  const field = fieldOf(value, name);
  return typeof field === "string" && pattern.test(field)
    ? field
    : fail(reason);
};

/* oxlint-disable no-bitwise -- CRC32C is 32-bit arithmetic */
/** CRC32C (Castagnoli) of `bytes`, as KMS checks what it's sent and sent back. */
const crc32c = (bytes: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x82_f6_3b_78 : crc >>> 1;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};
/* oxlint-enable no-bitwise */

/**
 * The JSON `what` answers to `init` at `url`, or the end, with what it
 * said. A redirect is an error: each address is the service's own, and a
 * token is never sent on to another.
 */
const ask = async (
  what: string,
  url: string,
  init: RequestInit
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error" });
  } catch (error) {
    return fail(`${what} couldn't be reached (${String(error)})`);
  }
  const body = await response.text();
  if (!response.ok) {
    return fail(`${what} answered ${response.status}: ${body.slice(0, 2000)}`);
  }
  return parsed(body, `${what} answered with something that isn't JSON`);
};

// The identifiers Google gave the key and the identity, which aren't
// secrets: the workload identity provider
// (`projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`)
// and the key version that signs.
const config = parsed(
  readFileSync(path.join(import.meta.dirname, "release-signing.json"), "utf-8"),
  "release-signing.json isn't JSON"
);
const provider = stringOf(
  config,
  "workloadIdentityProvider",
  /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/u,
  "release-signing.json names no workload identity provider"
);
const keyVersion = stringOf(
  config,
  "keyVersion",
  /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[\w-]+\/cryptoKeys\/[\w-]+\/cryptoKeyVersions\/\d+$/u,
  "release-signing.json names no key version"
);

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
// An id of this month (`YY.MM.N`, UTC, @grasp-os/shared/release-id), as
// the stage job stamps it: the admin moves Edge only to a newer id, and
// published manifests can't be rewritten, so a signed id far ahead would
// hold Edge for good. Of this month, such an id holds it until the month
// ends at most. The month before passes for `ROLLOVER_HOURS` into a new
// month, so a release staged before midnight is still signed after it;
// its ids sort below the new month's anyway. N stays within
// `MAX_RELEASE_N`, far above any month's releases (a few hundred).
const ROLLOVER_HOURS = 6;
const MAX_RELEASE_N = 99_999;
const monthOf = (at: Date): string =>
  `${String(at.getUTCFullYear() % 100).padStart(2, "0")}.${String(at.getUTCMonth() + 1).padStart(2, "0")}.`;
const now = new Date();
const months = new Set([
  monthOf(now),
  monthOf(new Date(now.getTime() - ROLLOVER_HOURS * 60 * 60 * 1000)),
]);
const releaseId = fieldOf(manifest, "releaseId");
const parts =
  typeof releaseId === "string"
    ? /^(?<month>\d{2}\.\d{2}\.)(?<n>[1-9]\d{0,4})$/u.exec(releaseId)?.groups
    : undefined;
if (
  typeof releaseId !== "string" ||
  parts?.month === undefined ||
  !months.has(parts.month) ||
  Number(parts.n) > MAX_RELEASE_N
) {
  fail(
    `Release ${String(releaseId)} isn't an id of this month's (${[...months].join(" or ")}N, N at most ${MAX_RELEASE_N})`
  );
}

const message = Buffer.from(
  `grasp-release-manifest\n${String(releaseId)}\n${createHash("sha256").update(manifestBytes).digest("hex")}`
);

// 1. GitHub's OIDC token for this job, for the provider's default
// audience.
const idToken = fieldOf(
  await ask(
    "GitHub's token service",
    `${env("ACTIONS_ID_TOKEN_REQUEST_URL")}&audience=${encodeURIComponent(`https://iam.googleapis.com/${provider}`)}`,
    {
      headers: {
        authorization: `bearer ${env("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
      },
    }
  ),
  "value"
);
if (typeof idToken !== "string") {
  fail("GitHub's token service gave no token");
}

// 2. Google's federated access token for it, with no service account:
// the key's IAM policy names the federated identity itself.
const accessToken = fieldOf(
  await ask(
    "Google's Security Token Service",
    "https://sts.googleapis.com/v1/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: `//iam.googleapis.com/${provider}`,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        subjectToken: idToken,
      }),
    }
  ),
  "access_token"
);
if (typeof accessToken !== "string") {
  fail("Google's Security Token Service gave no access token");
}

// 3. The signature, by the key version named, over exactly the message.
const signed = await ask(
  "Cloud KMS",
  `https://cloudkms.googleapis.com/v1/${keyVersion}:asymmetricSign`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(accessToken)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      data: message.toString("base64"),
      dataCrc32c: String(crc32c(message)),
    }),
  }
);
if (fieldOf(signed, "name") !== keyVersion) {
  fail(
    `Cloud KMS signed with ${String(fieldOf(signed, "name"))}, not ${keyVersion}`
  );
}
if (fieldOf(signed, "verifiedDataCrc32c") !== true) {
  fail("Cloud KMS didn't check the message against its CRC32C");
}
const encoded = fieldOf(signed, "signature");
const signature = Buffer.from(
  typeof encoded === "string" ? encoded : "",
  "base64"
);
if (
  signature.length === 0 ||
  fieldOf(signed, "signatureCrc32c") !== String(crc32c(signature))
) {
  fail("Cloud KMS's signature doesn't match its CRC32C");
}

writeFileSync(
  path.join(dir, "manifest.signature.json"),
  JSON.stringify({
    alg: "Ed25519",
    keyId: keyVersion,
    signature: signature.toString("base64url"),
  })
);
console.info(
  `Signed release ${String(releaseId)} of ${String(commit)} with ${keyVersion}`
);
