/**
 * Has the staging admin sign a manifest for CI's publish
 * (apps/admin/src/releases/sign.ts): its bytes, POSTed with GitHub's
 * OpenID Connect token for this run, asked for anew each time (a token
 * lives about five minutes), with the signer's origin as its audience.
 * The signature that comes back is checked against the keys this
 * checkout trusts before anything is stored, so a release nothing would
 * import is never published. CI never holds the key.
 *
 * Retried as the bucket's requests are (bucket-lib.ts): signing the same
 * bytes again gives the same signature.
 *
 * Env: RELEASE_SIGNER_URL (https://<the staging admin's host>/release-publish),
 *      ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN,
 *      which GitHub sets in a job with `id-token: write`
 */
import { releaseSignatureProblem } from "@grasp-os/shared/release-signature";
import { releaseSigningKeys } from "@grasp-os/shared/release-signing-keys";
import { z } from "zod";

import { requireEnv, sendWithRetries } from "./bucket-lib.ts";

const tokenAnswer = z.object({ value: z.string() });

/** GitHub's token for this run, for `audience`. */
const githubToken = async (audience: string): Promise<string> => {
  const url = new URL(requireEnv("ACTIONS_ID_TOKEN_REQUEST_URL"));
  url.searchParams.set("audience", audience);
  const answer = await sendWithRetries(
    "GitHub's token for the run",
    undefined,
    async (signal) =>
      await fetch(url, {
        headers: {
          authorization: `bearer ${requireEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
        },
        signal,
      })
  );
  if (!answer.ok) {
    throw new Error(`GitHub's token for the run: ${answer.status}`);
  }
  return tokenAnswer.parse(await answer.json()).value;
};

/** Signs release manifests, each its bytes as about to be published, with the signer the environment names. */
export const releaseSignerFromEnv = () => {
  const signer = requireEnv("RELEASE_SIGNER_URL");
  return async (releaseId: string, manifestBytes: Buffer): Promise<Buffer> => {
    const token = await githubToken(new URL(signer).origin);
    const init = {
      method: "POST",
      body: manifestBytes,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    };
    const answer = await sendWithRetries(
      `POST ${signer}`,
      init,
      async (signal) => await fetch(signer, { ...init, signal })
    );
    if (!answer.ok) {
      throw new Error(
        `The signer refused release ${releaseId}: ${answer.status} ${await answer.text()}; nothing published`
      );
    }
    const signature = Buffer.from(await answer.arrayBuffer());
    const problem = await releaseSignatureProblem(
      releaseId,
      manifestBytes,
      signature,
      releaseSigningKeys
    );
    if (problem !== undefined) {
      throw new Error(
        `Release ${releaseId} as signed ${problem}; nothing published`
      );
    }
    return signature;
  };
};
