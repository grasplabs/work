/**
 * A releases bucket, through R2's S3 API, as Promote release's scripts
 * reach it: its keys' URLs and signed requests.
 *
 * Every request goes through `fetch` here, with one retry policy, which
 * CI's publish takes too (publisher-lib.ts, publish-release.ts, through
 * `sendWithRetries`): a request that fails on the network (a reset
 * connection, a timeout) or that R2 answers with a 5xx or 429 is sent
 * again, up to `ATTEMPTS` times,
 * after a backoff with full jitter. The answer is read whole inside the
 * try, so a connection that drops while the body arrives is retried too.
 * aws4fetch's own retries are off (they cover only 5xx and 429, and never
 * a thrown error), so no request is retried by two policies at once.
 *
 * The bucket's requests are all idempotent: GET, HEAD, and a PUT of
 * fixed bytes at a key, plain or only if absent (`If-None-Match: *`). CI's
 * POSTs to the admin are too: asking start or finish again gives the
 * same id and links, or says the commit is published.
 * Sent again, a plain PUT stores the same bytes; one only if absent whose
 * first try took but whose answer was lost finds them there (412). Its
 * caller tells that from another writer's bytes by the stored SHA-256
 * (upload-release.ts, `putIfAbsent`), so a lost answer is never taken for
 * a failure, and nothing another writer stored is ever replaced.
 *
 * Env: R2_ENDPOINT (https://<account id>.eu.r2.cloudflarestorage.com),
 *      R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */
import { setTimeout as sleep } from "node:timers/promises";

import { AwsClient } from "aws4fetch";

/**
 * Requests a script keeps in flight at once to the bucket, through
 * `mapConcurrently`. R2 sets no rate limit on reading and writing objects
 * through the S3 API, only one write a second to the same key, which
 * content-addressed blobs never repeat. Each request waits on the network
 * far more than on the runner, so the time falls with the number in
 * flight: publishing a release of 1,163 blobs (80 new) to a stand-in that
 * answers each request after 230 ms took 40 s at 8, 22 s at 16, 13 s at
 * 32, 9 s at 64 and 7 s at 128, of which 2 s are the runner's own work
 * (November 2026). 64 takes most of the gain with a pool of connections
 * one runner holds easily.
 */
export const REQUESTS_AT_ONCE = 64;

/** Tries per request, the first included. */
const ATTEMPTS = 5;
/** The backoff before the second try is up to this; each try after doubles it. */
const BACKOFF_MS = 250;
/** No backoff longer than this. */
const BACKOFF_CAP_MS = 4000;
/**
 * How long one try may take, its answer read whole, so a connection that
 * hangs is dropped and retried rather than left to undici's five minutes:
 * 30 s, and a second more for each 256 KB it sends (a PUT's body) and,
 * once the answer's headers arrive, each 256 KB they say it will get. A
 * HEAD or a blob's PUT has about 30 s; the largest object, a 99 MB model
 * file, about 7 minutes, so a slow link still moves it.
 */
const TRY_MS = 30_000;
const BYTES_PER_SECOND = 256 * 1024;
const MS_PER_SECOND = 1000;
const allowance = (bytes: number): number =>
  TRY_MS + (bytes / BYTES_PER_SECOND) * MS_PER_SECOND;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/** Whether R2 answered `status` for a reason that may pass: overloaded or rate limited. */
const isTransient = (status: number): boolean =>
  status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR;

/** A thrown error's message, with its cause's (undici puts ECONNRESET there). */
const describe = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error
    ? `${error.message} (${error.cause.message})`
    : error.message;
};

/** How long to wait before try `attempt + 1`: full jitter, capped. */
const backoff = (attempt: number): number =>
  Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** (attempt - 1));

/**
 * `send`s a request until it gets an answer that isn't transient or runs
 * out of tries (the policy above), its answer read whole inside each try.
 * `what` names it in the logs; `init` is what it sends, for its time
 * allowance.
 */
export const sendWithRetries = async (
  what: string,
  init: RequestInit | undefined,
  send: (signal: AbortSignal) => Promise<Response>
): Promise<Response> => {
  const sent = init?.body instanceof Uint8Array ? init.body.byteLength : 0;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const giveUpAfter = (bytes: number): NodeJS.Timeout => {
      const ms = allowance(bytes);
      return setTimeout(() => {
        controller.abort(
          new Error(`no answer within ${Math.round(ms / MS_PER_SECOND)} s`)
        );
      }, ms);
    };
    let timer = giveUpAfter(sent);
    let failure: string;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time
      const response = await send(controller.signal);
      clearTimeout(timer);
      timer = giveUpAfter(
        Number(response.headers.get("content-length") ?? "0") || 0
      );
      // oxlint-disable-next-line no-await-in-loop -- read inside the try, so a drop mid-body is retried
      const body = await response.arrayBuffer();
      if (!isTransient(response.status) || attempt === ATTEMPTS) {
        return new Response(body.byteLength === 0 ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      failure = String(response.status);
    } catch (error) {
      if (attempt === ATTEMPTS) {
        throw new Error(`${what}: ${describe(error)}, ${ATTEMPTS} tries`, {
          cause: error,
        });
      }
      failure = describe(error);
    } finally {
      clearTimeout(timer);
    }
    console.warn(
      `${what}: ${failure}; trying again (${attempt + 1} of ${ATTEMPTS})`
    );
    // oxlint-disable-next-line no-await-in-loop -- the backoff before the next try
    await sleep(backoff(attempt));
  }
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

export interface ReleasesBucket {
  /** The bucket's name. */
  name: string;
  /** A key's URL in the bucket. */
  url: (key: string) => string;
  /**
   * A request signed for the bucket, sent until it gets an answer that
   * isn't transient or runs out of tries (above). The answer's body is
   * read already: reading it again never touches the network.
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** The bucket the environment names. */
export const releasesBucketFromEnv = (): ReleasesBucket => {
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/u, "");
  const bucket = requireEnv("R2_BUCKET");
  const client = new AwsClient({
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
    // The retries are this module's (above).
    retries: 0,
  });

  const base = `${endpoint}/${bucket}`;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> =>
    await sendWithRetries(
      // As the logs name it: the key.
      `${init?.method ?? "GET"} ${url.slice(base.length + 1)}`,
      init,
      async (signal) => await client.fetch(url, { ...init, signal })
    );

  return {
    name: bucket,
    url: (key) => `${base}/${key}`,
    fetch,
  };
};
