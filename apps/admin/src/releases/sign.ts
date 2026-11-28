/**
 * Signs a release's manifest for CI's publish (scripts/release/
 * upload-release.ts): `POST /release-publish` with the manifest's
 * bytes, as it's about to be published, and GitHub's token for the run
 * (src/releases/github-oidc.ts) as its bearer token. The answer is the
 * signature file (@grasp-os/shared/release-signature) that CI stores
 * before the manifest, and that every import, Promote release and an
 * on-premises install verify.
 *
 * The key is the admin's alone, `RELEASE_SIGNING_KEY` in the account's
 * Secrets Store, put there by hand and never in 1Password or CI
 * (scripts/optional-secrets.ts, `handKeptSecrets`): CI can have a
 * manifest signed while GitHub vouches for its run, but never holds the
 * key, so nothing it runs can take the key away and sign later. Only
 * staging's admin has one; production's answers 404, as CI publishes to
 * staging alone.
 *
 * What it signs, it checks first: a release manifest of the very commit
 * GitHub says the run is building, under an id of this month's that isn't
 * published yet, as CI claims ids (scripts/release/upload-release.ts):
 * signing comes before each claim. Its contents it can't check: what
 * CI's publish of main sends is what's released. Each signature is
 * audited (`release.sign`), with the run that asked.
 *
 * Reached without Cloudflare Access: Access lets this one path through
 * (an application of its own, Bypass), and GitHub's token is the only
 * credential here. src/server.ts routes it before the Access check.
 */
import "@tanstack/react-start/server-only";
import { errorName, log } from "@grasp-os/shared/log";
import {
  manifestKey,
  releaseManifestSchema,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import {
  parsePublishedReleaseId,
  releaseMonthPrefix,
} from "@grasp-os/shared/release-id";
import { signReleaseManifest } from "@grasp-os/shared/release-signature";
import { releaseSigningKeys } from "@grasp-os/shared/release-signing-keys";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { auditEvents } from "../db/schema.ts";
import { optionalStoreSecret } from "../deploy/context.ts";
import { boundedBytes } from "../request-body.ts";
import { publishRunOf } from "./github-oidc.ts";
import { MAX_MANIFEST_BYTES } from "./import.ts";

/** Where CI asks for a signature. */
export const releasePublishPath = "/release-publish";

/** The signing key as the store holds it: an Ed25519 private JWK. */
const signingKeySchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string(),
  d: z.string(),
});

const answer = (status: number, text: string): Response =>
  new Response(text, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });

/** The manifest `bytes` hold, or why they're none CI may have signed. */
const manifestIn = (
  bytes: Uint8Array
): z.infer<typeof releaseManifestSchema> | string => {
  try {
    const manifest = releaseManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
    return parsePublishedReleaseId(manifest.releaseId) === undefined
      ? "The manifest's release id isn't a published one"
      : manifest;
  } catch {
    return "Not a release manifest";
  }
};

const signed = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return answer(405, "POST a manifest");
  }
  const stored = await optionalStoreSecret(env, "RELEASE_SIGNING_KEY");
  if (stored === undefined) {
    return answer(404, "This admin signs no releases");
  }
  const run = await publishRunOf(request, env.STAGE);
  if (run === null) {
    return answer(403, "Only CI's publish of a release on main may ask");
  }
  const bytes = await boundedBytes(request, MAX_MANIFEST_BYTES);
  if (bytes === undefined) {
    return answer(413, `A manifest is at most ${MAX_MANIFEST_BYTES} bytes`);
  }
  const manifest = manifestIn(bytes);
  if (typeof manifest === "string") {
    return answer(400, manifest);
  }
  if (manifest.commit !== run.commit) {
    return answer(
      403,
      `The manifest is commit ${manifest.commit}'s; this run builds ${run.commit}`
    );
  }
  // Only an id CI's publish could be claiming now: one of this month's,
  // not yet published. A far-off id would stay the newest for good.
  if (!manifest.releaseId.startsWith(releaseMonthPrefix(new Date()))) {
    return answer(403, `Release ${manifest.releaseId} isn't this month's`);
  }
  if ((await env.RELEASES.head(manifestKey(manifest.releaseId))) !== null) {
    return answer(409, `Release ${manifest.releaseId} is published already`);
  }
  let key: ReturnType<typeof signingKeySchema.safeParse>;
  try {
    key = signingKeySchema.safeParse(JSON.parse(stored));
  } catch {
    key = signingKeySchema.safeParse(null);
  }
  if (!key.success || !releaseSigningKeys.includes(key.data.x)) {
    // A key no verifier trusts would sign releases nothing imports.
    log.error("release.sign_key_untrusted", {});
    return answer(503, "The signing key isn't one Grasp trusts");
  }
  const signature = await signReleaseManifest(bytes, key.data);
  const manifestSha256 = await sha256OfBytes(bytes);
  await adminDatabase(env.DB)
    .insert(auditEvents)
    .values({
      id: crypto.randomUUID(),
      at: new Date(),
      actor: "system",
      action: "release.sign",
      target: manifest.releaseId,
      detail: JSON.stringify({
        commit: manifest.commit,
        manifestSha256,
        run: run.runId,
        attempt: run.runAttempt,
      }),
    });
  return new Response(signature, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
};

/**
 * Answers a request to `releasePublishPath`. What may pass (GitHub's keys
 * or the store not answering) answers 503, which CI tries again.
 */
export const signRelease = async (
  request: Request,
  env: Env
): Promise<Response> => {
  try {
    return await signed(request, env);
  } catch (error) {
    log.error("release.sign_failed", { error: errorName(error) });
    return answer(503, "Couldn't sign now; try again");
  }
};
