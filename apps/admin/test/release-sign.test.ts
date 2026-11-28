/**
 * The admin signing a release's manifest for CI's publish
 * (src/releases/sign.ts), through the Worker's entry, with no Access JWT:
 * GitHub's token is the only credential. A stand-in for GitHub's token
 * service serves its keys at their real address and signs the tokens a
 * run would get, and the ones it never would.
 *
 * Threat model: anyone on the internet can reach this path. They must not
 * get a signature without a token GitHub signed for CI's publish of a
 * push to main in the stage's environment, for this admin; a run must
 * not get one for another commit than its own; the key must never leave
 * the admin; and an admin with a key nobody trusts signs nothing.
 */
import { manifestKey, sha256OfBytes } from "@grasp-os/shared/release";
import { nextReleaseId } from "@grasp-os/shared/release-id";
import { releaseSignatureProblem } from "@grasp-os/shared/release-signature";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  releaseSigningKeys,
  testReleaseSigningKey,
} from "../../../packages/shared/test/release-signing-keys.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents } from "../src/db/schema.ts";
import worker from "../src/server.ts";
import { buildRelease } from "./releases.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const db = adminDatabase(env.DB);
const issuer = "https://token.actions.githubusercontent.com";
const jwksUrl = `${issuer}/.well-known/jwks`;
const origin = "https://admin.staging.grasp.test";
const keyId = "github-test-key";

const githubKeys = await generateKeyPair("RS256", { extractable: true });
const strangerKeys = await generateKeyPair("RS256");
const githubJwk = await exportJWK(githubKeys.publicKey);

/** The staging admin's env, its signing key in the store. */
const staging = { ...env, STAGE: "staging" };

/** The claims of CI's publish run of `sha`, as GitHub puts them in its token. */
const publishClaims = (sha: string): JWTPayload => ({
  iss: issuer,
  aud: origin,
  sub: "repo:grasplabs/work:environment:staging",
  repository: "grasplabs/work",
  repository_id: "1386316902",
  repository_owner: "grasplabs",
  workflow_ref: "grasplabs/work/.github/workflows/ci.yml@refs/heads/main",
  job_workflow_ref: "grasplabs/work/.github/workflows/ci.yml@refs/heads/main",
  ref: "refs/heads/main",
  ref_type: "branch",
  event_name: "push",
  environment: "staging",
  runner_environment: "github-hosted",
  sha,
  run_id: "46000000001",
  run_attempt: "1",
});

/** A token as GitHub signs one, with `claims`, by `key`, expiring in `expiresIn` seconds. */
const githubToken = async (
  claims: JWTPayload,
  { stranger = false, expiresIn = 300 } = {}
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(stranger ? strangerKeys.privateKey : githubKeys.privateKey);
};

/** CI's ask for a signature of `body`, with `token` as its bearer token. */
const ask = async (
  body: BodyInit,
  token: string | undefined,
  on: Env = staging
): Promise<Response> =>
  await worker.fetch(
    new Request(`${origin}/release-publish`, {
      method: "POST",
      body,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
    on
  );

/** The status the admin answers CI's ask for a signature of `body` with. */
const statusOf = async (
  body: BodyInit,
  token: string | undefined
): Promise<number> => {
  const response = await ask(body, token);
  return response.status;
};

const taken: string[] = [];
/**
 * A release built under the next id of this month, as CI's publish would
 * be claiming, built from `notes`.
 */
const claimable = async (notes: string) => {
  const id = nextReleaseId(taken, new Date());
  taken.push(id);
  return await buildRelease({ notes }, id);
};

describe("signing a release for CI's publish", () => {
  useStoreSecrets({ deployer: "deployer-token" });

  beforeEach(async () => {
    await setStoreSecret(
      env.RELEASE_SIGNING_KEY,
      "RELEASE_SIGNING_KEY",
      JSON.stringify(testReleaseSigningKey)
    );
    // GitHub's keys at their real address; nothing else goes out.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== jwksUrl) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      await request.body?.cancel();
      return Response.json({
        keys: [{ ...githubJwk, kid: keyId, alg: "RS256", use: "sig" }],
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs CI's publish of the commit it builds with the key every verifier trusts, audited, with no Access JWT", async () => {
    const release = await claimable("feat(core): signed");
    const response = await ask(
      release.manifestText,
      await githubToken(publishClaims(release.manifest.commit))
    );
    const signature = new Uint8Array(await response.arrayBuffer());
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "release.sign"),
          eq(auditEvents.target, release.id)
        )
      );

    const audited: unknown = JSON.parse(event?.detail ?? "{}");
    // A job that calls no reusable workflow may come without one named.
    const { job_workflow_ref: _direct, ...directClaims } = publishClaims(
      release.manifest.commit
    );
    const direct = await ask(
      release.manifestText,
      await githubToken(directClaims)
    );
    expect({
      direct: direct.status,
      status: response.status,
      problem: await releaseSignatureProblem(
        new TextEncoder().encode(release.manifestText),
        signature,
        releaseSigningKeys
      ),
      audited,
    }).toStrictEqual({
      direct: 200,
      status: 200,
      problem: undefined,
      audited: {
        commit: release.manifest.commit,
        manifestSha256: await sha256OfBytes(
          new TextEncoder().encode(release.manifestText)
        ),
        run: "46000000001",
        attempt: "1",
      },
    });
  });

  it("refuses anyone but CI's publish of a push to main, in the stage's environment, for this admin", async () => {
    const release = await claimable("feat(core): forged");
    const claims = publishClaims(release.manifest.commit);
    const tokens = {
      none: undefined,
      notJwt: "not-a-jwt",
      strangerKey: await githubToken(claims, { stranger: true }),
      expired: await githubToken(claims, { expiresIn: -60 }),
      otherIssuer: await githubToken({ ...claims, iss: "https://evil.test" }),
      otherAudience: await githubToken({
        ...claims,
        aud: "https://admin.grasp.test",
      }),
      fork: await githubToken({
        ...claims,
        repository: "someone/work",
        repository_id: "1",
      }),
      recreated: await githubToken({ ...claims, repository_id: "2" }),
      otherWorkflow: await githubToken({
        ...claims,
        workflow_ref:
          "grasplabs/work/.github/workflows/promote-release.yml@refs/heads/main",
      }),
      branch: await githubToken({
        ...claims,
        ref: "refs/heads/feat/x",
        workflow_ref:
          "grasplabs/work/.github/workflows/ci.yml@refs/heads/feat/x",
      }),
      pullRequest: await githubToken({ ...claims, event_name: "pull_request" }),
      byHand: await githubToken({ ...claims, event_name: "workflow_dispatch" }),
      nightly: await githubToken({ ...claims, event_name: "schedule" }),
      reusableWorkflow: await githubToken({
        ...claims,
        job_workflow_ref:
          "grasplabs/work/.github/workflows/deploy-platform.yml@refs/heads/main",
      }),
      productionEnvironment: await githubToken({
        ...claims,
        environment: "production",
      }),
      selfHosted: await githubToken({
        ...claims,
        runner_environment: "self-hosted",
      }),
    };

    const statuses = Object.fromEntries(
      await Promise.all(
        Object.entries(tokens).map(
          async ([name, token]) =>
            [name, await statusOf(release.manifestText, token)] as const
        )
      )
    );

    expect(statuses).toStrictEqual(
      Object.fromEntries(Object.keys(tokens).map((name) => [name, 403]))
    );
  });

  it("signs only a manifest of the run's own commit, under an id of this month's not yet published", async () => {
    const release = await claimable("feat(core): other");
    const token = await githubToken(publishClaims("b".repeat(40)));
    const local = await buildRelease({ notes: "feat(core): local" }, "dev-abc");

    const ownToken = await githubToken(publishClaims(release.manifest.commit));
    const localToken = await githubToken(publishClaims(local.manifest.commit));
    // Far off: it would stay the newest release for good.
    const farOff = await buildRelease({ notes: "feat(core): far off" });
    const farOffToken = await githubToken(
      publishClaims(farOff.manifest.commit)
    );
    const published = await claimable("feat(core): published");
    await env.RELEASES.put(manifestKey(published.id), published.manifestText);
    const publishedToken = await githubToken(
      publishClaims(published.manifest.commit)
    );

    expect({
      otherCommit: await statusOf(release.manifestText, token),
      notManifest: await statusOf("{ not json", ownToken),
      local: await statusOf(local.manifestText, localToken),
      farOff: await statusOf(farOff.manifestText, farOffToken),
      published: await statusOf(published.manifestText, publishedToken),
      tooLarge: await statusOf(
        `{"padding":"${"x".repeat(1_000_001)}"}`,
        ownToken
      ),
    }).toStrictEqual({
      otherCommit: 403,
      notManifest: 400,
      local: 400,
      farOff: 403,
      published: 409,
      tooLarge: 413,
    });
  });

  it("answers 503, which CI tries again, when GitHub's keys can't be fetched", async () => {
    const release = await claimable("feat(core): keys down");
    // A key id the kept keys don't have, as after GitHub rotates them: the
    // admin fetches them again, and GitHub answers 500.
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      await request.body?.cancel();
      return new Response("unavailable", { status: 500 });
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(publishClaims(release.manifest.commit))
      .setProtectedHeader({ alg: "RS256", kid: "rotated-key" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(githubKeys.privateKey);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // The failed fetch is logged; the test reads the answer.
    });
    const status = await statusOf(release.manifestText, token);
    errors.mockRestore();

    expect(status).toBe(503);
  });

  it("signs nothing on an admin without a key, as production's, nor with a key no verifier trusts", async () => {
    const release = await claimable("feat(core): keyless");
    const token = await githubToken(publishClaims(release.manifest.commit));
    await setStoreSecret(env.RELEASE_SIGNING_KEY, "RELEASE_SIGNING_KEY", "");
    const keyless = await statusOf(release.manifestText, token);
    await setStoreSecret(
      env.RELEASE_SIGNING_KEY,
      "RELEASE_SIGNING_KEY",
      JSON.stringify({
        kty: "OKP",
        crv: "Ed25519",
        x: "A2VEuP3eHRFGIPqELZm-RDZnYWKhUXJLPFsDL5Y8xVY",
        d: "7Bs1IAjNMwqAVTTNRQkEsTjYn2p3b4Vz3RhHn0GXi8o",
      })
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // The untrusted key is logged; the test reads the answer.
    });
    const untrusted = await statusOf(release.manifestText, token);
    errors.mockRestore();

    expect({ keyless, untrusted }).toStrictEqual({
      keyless: 404,
      untrusted: 503,
    });
  });
});
