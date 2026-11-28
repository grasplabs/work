/**
 * CI's publish as the staging admin takes it (apps/admin/src/releases/
 * publish.ts): each step a POST of a manifest with GitHub's OpenID Connect
 * token for this run, asked for anew each time (a token lives about five
 * minutes), with the admin's origin as its audience. CI's publish holds
 * no key to the bucket: the admin gives it the release's id and upload
 * links, and the manifest's link only for a manifest whose signature
 * (made by CI's sign-release job) verifies.
 *
 * Retried as the bucket's requests are (bucket-lib.ts): each step asks
 * the same of the admin when it's asked again.
 *
 * Env: RELEASE_PUBLISH_URL (https://<the staging admin's host>/release-publish),
 *      ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN,
 *      which GitHub sets in a job with `id-token: write`
 */
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { requireEnv, sendWithRetries } from "./bucket-lib.ts";

const HTTP_UNAVAILABLE = 503;
/**
 * How long a step's answer may take: start heads every blob and finish
 * reads back every one the import would read, about 1,200 for a release
 * nothing before it checked (a cold publish), at most 25 MiB in memory at
 * once. A try given up on starts over, so it must fit in one.
 */
const ANSWER_MS = 10 * 60 * 1000;
/**
 * While the admin answers 503 after a round of tries (bucket-lib.ts's,
 * a few seconds), it's asked again after `UNAVAILABLE_WAIT_MS`, up to
 * `UNAVAILABLE_ROUNDS` rounds: past the admin's 30 seconds of answering
 * 503 once GitHub's keys couldn't be fetched (apps/admin/src/issuer-keys.ts).
 */
const UNAVAILABLE_ROUNDS = 4;
const UNAVAILABLE_WAIT_MS = 15_000;

const tokenAnswer = z.object({ value: z.string() });

/** An upload link: a PUT of one object to `url`, with exactly `headers`. */
const uploadLinkSchema = z.object({
  key: z.string(),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
});
export type UploadLink = z.infer<typeof uploadLinkSchema>;

const startAnswer = z.union([
  z.object({ publishedAs: z.string() }),
  z.object({ id: z.string(), uploads: z.array(uploadLinkSchema) }),
]);

const finishAnswer = z.union([
  z.object({ publishedAs: z.string() }),
  z.object({ upload: uploadLinkSchema }).transform(({ upload }) => upload),
]);

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

/** `answer`'s JSON; throws when the admin refused `step`. */
const accepted = async (step: string, answer: Response): Promise<unknown> => {
  if (!answer.ok) {
    throw new Error(
      `The staging admin refused the publish's ${step}: ${answer.status} ${await answer.text()}; nothing published`
    );
  }
  return await answer.json();
};

/** The staging admin's publish, as the environment names it. */
export const releasePublisherFromEnv = () => {
  const publisher = requireEnv("RELEASE_PUBLISH_URL");

  /** POSTs `manifestBytes` to `step`, with `headers`: the admin's answer, read whole. */
  const askOnce = async (
    step: string,
    manifestBytes: Buffer,
    headers: Record<string, string>
  ): Promise<Response> => {
    const url = new URL(publisher);
    url.searchParams.set("step", step);
    const token = await githubToken(url.origin);
    const init = {
      method: "POST",
      body: manifestBytes,
      headers: {
        ...headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    };
    return await sendWithRetries(
      `POST ${url.pathname}?step=${step}`,
      init,
      async (signal) => await fetch(url, { ...init, signal }),
      ANSWER_MS
    );
  };

  const ask = async (
    step: string,
    manifestBytes: Buffer,
    headers: Record<string, string> = {}
  ): Promise<Response> => {
    let answer = await askOnce(step, manifestBytes, headers);
    for (
      let round = 1;
      answer.status === HTTP_UNAVAILABLE && round < UNAVAILABLE_ROUNDS;
      round += 1
    ) {
      console.warn(
        `The staging admin is unavailable (503); asking again in ${UNAVAILABLE_WAIT_MS / 1000} s`
      );
      // oxlint-disable-next-line no-await-in-loop -- a round at a time
      await sleep(UNAVAILABLE_WAIT_MS);
      // oxlint-disable-next-line no-await-in-loop -- a round at a time
      answer = await askOnce(step, manifestBytes, headers);
    }
    return answer;
  };

  return {
    /**
     * The id the built manifest's release is published as, and a link for
     * each blob the bucket lacks; or the id it's published as already.
     */
    start: async (manifestBytes: Buffer) =>
      startAnswer.parse(
        await accepted("start", await ask("start", manifestBytes))
      ),

    /**
     * The link for a manifest, `manifestBytes` as stamped with its id,
     * once the admin took `signature` (its signature file) and its blobs;
     * or the id it's published as already, by an earlier try. Throws when
     * the admin refused.
     */
    finish: async (manifestBytes: Buffer, signature: Buffer) =>
      finishAnswer.parse(
        await accepted(
          "finish",
          await ask("finish", manifestBytes, {
            "x-release-signature": signature.toString("base64url"),
          })
        )
      ),
  };
};
