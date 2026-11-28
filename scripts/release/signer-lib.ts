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
import { setTimeout as sleep } from "node:timers/promises";

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

const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
/**
 * While the signer answers 503 after a round of tries (bucket-lib.ts's,
 * a few seconds), it's asked again after `UNAVAILABLE_WAIT_MS`, up to
 * `UNAVAILABLE_ROUNDS` rounds: past the admin's 30 seconds of answering
 * 503 once GitHub's keys couldn't be fetched (apps/admin/src/issuer-keys.ts).
 */
const UNAVAILABLE_ROUNDS = 4;
const UNAVAILABLE_WAIT_MS = 15_000;

/**
 * Signs release manifests, each its bytes as about to be published, with
 * the signer the environment names: the signature, or undefined when the
 * signer says the release's id is published already (409), as another
 * publish claimed it since its listing, or an earlier try of this one.
 */
export const releaseSignerFromEnv = () => {
  const signer = requireEnv("RELEASE_SIGNER_URL");
  return async (
    releaseId: string,
    manifestBytes: Buffer
  ): Promise<Buffer | undefined> => {
    const ask = async (): Promise<Response> => {
      const token = await githubToken(new URL(signer).origin);
      const init = {
        method: "POST",
        body: manifestBytes,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      };
      return await sendWithRetries(
        `POST ${signer}`,
        init,
        async (signal) => await fetch(signer, { ...init, signal })
      );
    };
    let answer = await ask();
    for (
      let round = 1;
      answer.status === HTTP_UNAVAILABLE && round < UNAVAILABLE_ROUNDS;
      round += 1
    ) {
      console.warn(
        `The signer is unavailable (503); asking again in ${UNAVAILABLE_WAIT_MS / 1000} s`
      );
      // oxlint-disable-next-line no-await-in-loop -- a round at a time
      await sleep(UNAVAILABLE_WAIT_MS);
      // oxlint-disable-next-line no-await-in-loop -- a round at a time
      answer = await ask();
    }
    if (answer.status === HTTP_CONFLICT) {
      return undefined;
    }
    if (!answer.ok) {
      throw new Error(
        `The signer refused release ${releaseId}: ${answer.status} ${await answer.text()}; nothing published`
      );
    }
    const signature = Buffer.from(await answer.arrayBuffer());
    const problem = await releaseSignatureProblem(
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
