/**
 * CI's release signer (sign-manifest.ts) run as sign-release runs it, for
 * the tests: in a Node of its own, from a directory holding nothing but
 * the signer and its identifiers (as the job's sparse checkout leaves
 * it), with the environment GitHub gives the job, on a set clock, against
 * stand-ins for the three services it calls.
 *
 * Loaded first in that Node (`node --import`), this module is the
 * stand-in: with `FAKE_GOOGLE` set (JSON, {@link FakeGoogle}) it takes
 * over `fetch` for GitHub's OIDC token service (the address the job's
 * environment names), Google's Security Token Service and Cloud KMS. It
 * writes each request down, answers as each service does, and KMS signs
 * with the tests' key whatever it's sent, after checking it against its
 * CRC32C. Unless set, it does nothing: never loaded outside the tests.
 */
import { spawn } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";

import { z } from "zod";

import type { TestSigningKey } from "../../packages/shared/test/release-signing-keys.ts";

const faultSchema = z.enum([
  "githubRefuses",
  "stsRefuses",
  "kmsRefuses",
  "otherKeyVersion",
  "signatureCrc",
  "dataCrcUnchecked",
]);

/** How a stand-in fails, if one does. */
export type GoogleFault = z.infer<typeof faultSchema>;

/** What the stand-ins are set to: `FAKE_GOOGLE`. */
const fakeGoogleSchema = z.object({
  /** The key KMS signs with, under its id. */
  key: z.object({
    id: z.string(),
    jwk: z.object({
      kty: z.literal("OKP"),
      crv: z.literal("Ed25519"),
      x: z.string(),
      d: z.string(),
    }),
  }),
  fault: faultSchema.optional(),
  /** The file each request is written to, a JSON line each. */
  log: z.string(),
});
type FakeGoogle = z.infer<typeof fakeGoogleSchema>;

/** A request as the stand-ins took it. */
const takenRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  redirect: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
});
export type TakenRequest = z.infer<typeof takenRequestSchema>;

/** What GitHub's token service gives, and what Google's exchanges it for. */
export const GITHUB_TOKEN = "github-oidc-token";
export const ACCESS_TOKEN = "google-access-token";

/* oxlint-disable no-bitwise -- CRC32C is 32-bit arithmetic */
const CRC32C_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? (crc >>> 1) ^ 0x82_f6_3b_78 : crc >>> 1;
  }
  return crc >>> 0;
});

/** CRC32C (Castagnoli) of `bytes`, by table: KMS's integrity check. */
export const crc32c = (bytes: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};
/* oxlint-enable no-bitwise */

const answer = (status: number, body: unknown): Response =>
  Response.json(body, { status });

const KMS_ADDRESS =
  /^https:\/\/cloudkms\.googleapis\.com\/v1\/(?<version>.+):asymmetricSign$/u;

const kmsRequestSchema = z.object({ data: z.string(), dataCrc32c: z.string() });

/** KMS's answer to `body`, signed with `key`, as `fault` has it. */
const kmsAnswer = (
  { key, fault }: FakeGoogle,
  version: string,
  body: unknown
): Response => {
  if (fault === "kmsRefuses") {
    return answer(403, {
      error: {
        code: 403,
        message: `Permission 'cloudkms.cryptoKeyVersions.useToSign' denied on resource '${version}' (or it may not exist).`,
        status: "PERMISSION_DENIED",
      },
    });
  }
  const request = kmsRequestSchema.safeParse(body);
  const signed = Buffer.from(request.data?.data ?? "", "base64");
  if (request.data?.dataCrc32c !== String(crc32c(signed))) {
    return answer(400, {
      error: {
        code: 400,
        message: "The checksum in field data_crc32c did not match the data.",
        status: "INVALID_ARGUMENT",
      },
    });
  }
  const signature = sign(
    null,
    signed,
    createPrivateKey({ key: key.jwk, format: "jwk" })
  );
  const signatureCrc32c = crc32c(signature);
  return answer(200, {
    signature: signature.toString("base64"),
    signatureCrc32c: String(
      fault === "signatureCrc" ? signatureCrc32c + 1 : signatureCrc32c
    ),
    verifiedDataCrc32c: fault !== "dataCrcUnchecked",
    name: fault === "otherKeyVersion" ? `${version}0` : version,
    protectionLevel: "SOFTWARE",
  });
};

/** The stand-ins' answer to a request. */
const respond = (
  fake: FakeGoogle,
  input: string | URL | Request,
  init: RequestInit | undefined
): Response => {
  const url = input instanceof Request ? input.url : input.toString();
  const taken: TakenRequest = {
    method: init?.method ?? "GET",
    url,
    ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    headers: Object.fromEntries(new Headers(init?.headers)),
  };
  if (typeof init?.body === "string") {
    const body: unknown = JSON.parse(init.body);
    taken.body = body;
  }
  appendFileSync(fake.log, `${JSON.stringify(taken)}\n`);
  const tokenService = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (tokenService !== undefined && url.startsWith(tokenService)) {
    return fake.fault === "githubRefuses"
      ? answer(500, { message: "Unable to get the token" })
      : answer(200, { count: 1, value: GITHUB_TOKEN });
  }
  if (url === "https://sts.googleapis.com/v1/token") {
    return fake.fault === "stsRefuses"
      ? answer(400, {
          error: "unauthorized_client",
          error_description:
            "The given credential is rejected by the attribute condition.",
        })
      : answer(200, {
          access_token: ACCESS_TOKEN,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3599,
        });
  }
  const version = KMS_ADDRESS.exec(url)?.groups?.version;
  if (version !== undefined) {
    return kmsAnswer(fake, version, taken.body);
  }
  return answer(404, { error: `No stand-in for ${url}` });
};

const configured = process.env.FAKE_GOOGLE;
if (configured !== undefined) {
  const fake = fakeGoogleSchema.parse(JSON.parse(configured));
  globalThis.fetch = async (input, init) =>
    await Promise.resolve(respond(fake, input, init));
}

/** The workload identity provider the tests' signer is given. */
export const TEST_PROVIDER =
  "projects/123456789012/locations/global/workloadIdentityPools/grasp-release-signing/providers/github";

/** Where GitHub's token service is for the tests' job. */
export const TOKEN_REQUEST_URL =
  "https://pipelines.actions.test/idtoken/run?api-version=2.0";

/** The environment GitHub gives sign-release for a push to main of `commit`. */
export const pushToMain = (commit: string): Record<string, string> => ({
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: commit,
  ACTIONS_ID_TOKEN_REQUEST_URL: TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
});

/** When the tests' releases are made and signed, unless said: mid-month, UTC. */
export const TEST_NOW = "2026-11-15T12:00:00Z";

/**
 * A module that sets Node's clock to `at` before a script runs: the
 * signer, and the publish that stamps an id, read the month from it,
 * untouched.
 */
export const clockAt = (at: string): string =>
  `data:text/javascript,${encodeURIComponent(
    `const at = Date.parse(${JSON.stringify(at)}); const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length > 0 ? args : [at])); } static now() { return at; } };`
  )}`;

/**
 * Runs the signer on `dir` (holding manifest.json) at `at`, with `env` as
 * GitHub's, KMS signing with `key` and failing as `fault` says, the signer
 * given `config` as its identifiers (the tests' provider and `key`'s id
 * unless said). Its exit code, what it said, and the requests it made.
 */
export const runSigner = async (
  dir: string,
  {
    env,
    at = TEST_NOW,
    key,
    fault,
    config = { workloadIdentityProvider: TEST_PROVIDER, keyVersion: key.id },
  }: {
    env: Record<string, string>;
    at?: string;
    key: TestSigningKey;
    fault?: GoogleFault;
    config?: Record<string, string>;
  }
): Promise<{
  code: number | null;
  output: string;
  requests: TakenRequest[];
}> => {
  const job = mkdtempSync(path.join(tmpdir(), "grasp-os-sign-job-"));
  try {
    const signer = path.join(job, "sign-manifest.ts");
    copyFileSync(path.join(import.meta.dirname, "sign-manifest.ts"), signer);
    writeFileSync(
      path.join(job, "release-signing.json"),
      JSON.stringify(config)
    );
    const log = path.join(job, "requests.jsonl");
    writeFileSync(log, "");
    const child = spawn(
      "node",
      ["--import", clockAt(at), "--import", import.meta.filename, signer, dir],
      {
        cwd: job,
        env: {
          PATH: process.env.PATH,
          ...env,
          FAKE_GOOGLE: JSON.stringify({ key, fault, log }),
        },
      }
    );
    const closed = once(child, "close");
    const [stdout, stderr] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
    ]);
    await closed;
    const requests = readFileSync(log, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => takenRequestSchema.parse(JSON.parse(line)));
    return { code: child.exitCode, output: stdout + stderr, requests };
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
};
