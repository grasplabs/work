import { fromBase64Url } from "@grasp-os/shared/encoding";
import { portableFunctionPath } from "@grasp-os/shared/portable";

import { isPlainObject } from "./value-descriptor.ts";

// How a portable host's client (spec 10.7.1: `new GraspClient({ url,
// getToken })`, outside Grasp's own shell) reaches core: a plain `fetch`
// of `POST <url>/api/portable/app-functions/<app>` per call, with the
// person's App token from `getToken()` as `Authorization: Bearer`, asked
// for afresh on every call so a host that renews tokens is always
// current. Answers and refusals read as the frame's transport reads
// them: core's `{ result }`, or a coded refusal; anything else (no
// answer, an answer that isn't core's) is a lost response.
//
// - A token sent where it shouldn't go: only to the configured origin,
//   over HTTPS (plain HTTP only on this machine), never along a redirect,
//   and never with the browser's cookies for it.
// - Data of one person shown to another: the client reads whose a token
//   is (its `sub`) before it is sent, and when that changes clears what
//   it holds before anything of the new person's arrives (client-core.ts).
//   The claim is only read, never trusted: core checks the token.
// - A host that has no token: nothing is sent; the call is refused as
//   `auth.unauthenticated`, as core would refuse it.

/** How a portable host's client reaches the deployment. */
export interface PortableClientOptions {
  /**
   * The deployment's origin, as configured: `https://<host>`, nothing
   * after it. Plain `http:` only for this machine.
   */
  readonly url: string;
  /**
   * The person's current App token, from the host's own sign-in, asked
   * for before every call; `null` while nobody is signed in.
   */
  readonly getToken: () => Promise<string | null>;
}

/** A refusal before anything was sent, coded as core codes its own. */
const refusal = (
  code: string,
  message: string,
  details?: { retryAfterMs: number }
): Error =>
  Object.assign(new Error(message), {
    code,
    ...(details === undefined ? {} : { details }),
  });

const loopbackHosts: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/** `url` as an origin a token may go to; throws a `TypeError` otherwise. */
const originOf = (url: unknown): string => {
  if (typeof url !== "string") {
    throw new TypeError("url is the deployment's origin, as a string.");
  }
  const parsed = new URL(url);
  const secure =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname));
  const bare =
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.username === "" &&
    parsed.password === "";
  if (!(secure && bare)) {
    throw new TypeError(
      "url is the deployment's https origin, with nothing after it."
    );
  }
  return parsed.origin;
};

/** Whose `token` is: its `sub`, read without checking it; or `undefined`. */
const subjectOf = (token: string): string | undefined => {
  const [, payload, signature, ...more] = token.split(".");
  if (payload === undefined || signature === undefined || more.length > 0) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload))
    );
    const sub = isPlainObject(claims) ? claims.sub : undefined;
    return typeof sub === "string" && sub.length > 0 ? sub : undefined;
  } catch {
    return undefined;
  }
};

/** A token as the client read it: what it sends, and whose it is. */
export interface PortableToken {
  readonly text: string;
  readonly principal: string;
}

/** A portable host's way to core (see the header). */
export class PortableTransport {
  readonly #origin: string;
  readonly #getToken: () => Promise<string | null>;

  constructor(options: PortableClientOptions) {
    if (typeof options.getToken !== "function") {
      throw new TypeError("getToken is a function answering a token.");
    }
    this.#origin = originOf(options.url);
    this.#getToken = options.getToken;
  }

  /**
   * The person's current token, or a coded refusal: `auth.unauthenticated`
   * without one, `auth.token_unavailable` when the host failed to say.
   */
  async token(): Promise<PortableToken> {
    let text: unknown;
    try {
      text = await this.#getToken();
    } catch {
      throw refusal(
        "auth.token_unavailable",
        "The host couldn't provide a sign-in token. Try again."
      );
    }
    const principal = typeof text === "string" ? subjectOf(text) : undefined;
    if (typeof text !== "string" || principal === undefined) {
      throw refusal("auth.unauthenticated", "Sign in to continue.");
    }
    return { text, principal };
  }

  /**
   * Sends `request` to `app`'s function route with `token`: core's
   * answer, or a coded refusal; a plain error for a lost response.
   */
  async send(request: string, app: string, token: string): Promise<unknown> {
    const response = await fetch(
      `${this.#origin}${portableFunctionPath}/${encodeURIComponent(app)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: request,
        credentials: "omit",
        redirect: "error",
      }
    );
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      throw new Error("The answer wasn't core's.");
    }
    if (response.ok) {
      return answer;
    }
    const code = isPlainObject(answer) ? answer.code : undefined;
    const message = isPlainObject(answer) ? answer.message : undefined;
    if (typeof code !== "string" || typeof message !== "string") {
      throw new TypeError("The refusal wasn't core's.");
    }
    // Of a refusal's details, only how long to wait before asking again.
    const details = isPlainObject(answer) ? answer.details : undefined;
    const retryAfterMs = isPlainObject(details)
      ? details.retryAfterMs
      : undefined;
    throw refusal(
      code,
      message,
      typeof retryAfterMs === "number" ? { retryAfterMs } : undefined
    );
  }
}
