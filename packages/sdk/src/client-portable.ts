import { fromBase64Url } from "@grasp-os/shared/encoding";
import { appTokenMs, portableFunctionPath } from "@grasp-os/shared/portable";

import { readAnswer, readRefusal } from "./client-error.ts";
import type { Settled } from "./client-error.ts";
import { isPlainObject } from "./value-descriptor.ts";

// How a portable host's client (spec 10.7.1: `new GraspClient({ url,
// getToken })`, outside Grasp's own shell) reaches core: a plain `fetch`
// of `POST <url>/api/portable/app-functions/<app>` per call, with the
// person's App token from `getToken()` as `Authorization: Bearer`. The
// token is kept until shortly before its `exp` (read, not trusted), or
// until core refuses it, so a host that mints per request spends neither
// its budget nor the audit log on every call. Answers and refusals read as the frame's transport reads
// them: core's `{ result }`, or a coded refusal; anything else (no
// answer, an answer that isn't core's) is a lost response.
//
// - A token sent where it shouldn't go: only to the configured origin,
//   over HTTPS (plain HTTP only on this machine), never along a redirect,
//   and never with the browser's cookies for it. The live connection
//   (client-live.ts) goes to the same origin, over WSS (plain WS only on
//   this machine), the token in its first message.
// - Data of one person shown to another: the client reads whose a token
//   is (its `sub`) before it is sent, and when that changes clears what
//   it holds before anything of the new person's arrives (client-core.ts).
//   The claim is only read, never trusted: core checks the token. A
//   token is kept until shortly before its `exp`, so a person swapped in
//   without the last one signing out is seen when the client next asks.
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
   * The person's current App token, from the host's own sign-in; `null`
   * while nobody is signed in. Asked for when the client holds none, the
   * one it holds is within 30 seconds of its `exp`, or core refused it.
   * A host whose person changes without the old token being refused is
   * noticed when the client next asks.
   */
  readonly getToken: () => Promise<string | null>;
}

/** Core's status for a token it refused. */
const unauthorized = 401;

/** The refusals of calls that gave up waiting for the host's token. */
const gaveUp = new WeakSet<object>();

/** How long the host may take to give a token before the call gives up. */
const tokenWaitMs = 30_000;

/**
 * How long a call waits for core's answer before taking it as lost: core
 * gives an App's function 30 seconds, and the rest is the network's.
 */
const sendWaitMs = 60_000;

/** A refusal before anything was sent, coded as core codes its own. */
const refusal = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

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

/** What the client reads of a token, without checking it. */
interface TokenClaims {
  readonly sub: string;
  /** Its `exp`, in milliseconds, when it says one. */
  readonly expiresAt: number | undefined;
}

/** `token`'s `sub` and `exp`, read without checking them; or `undefined`. */
const claimsOf = (token: string): TokenClaims | undefined => {
  const [, payload, signature, ...more] = token.split(".");
  if (payload === undefined || signature === undefined || more.length > 0) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload))
    );
    const sub = isPlainObject(claims) ? claims.sub : undefined;
    const exp = isPlainObject(claims) ? claims.exp : undefined;
    return typeof sub === "string" && sub.length > 0
      ? {
          sub,
          expiresAt:
            typeof exp === "number" && Number.isFinite(exp)
              ? exp * 1000
              : undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

/** How long before a token's `exp` the client asks the host for the next. */
const renewBeforeMs = 30_000;

/**
 * Until when a token read at `now` is used without asking again: shortly
 * before its `exp`, and never longer than an App token lives. `exp` is a
 * hint, not trusted: core checks it. A token without one is asked for
 * again on the next call.
 */
const keepUntil = (claims: TokenClaims, now: number): number =>
  claims.expiresAt === undefined
    ? now
    : Math.min(claims.expiresAt - renewBeforeMs, now + appTokenMs);

/** A token as the client read it: what it sends, and whose it is. */
export interface PortableToken {
  readonly text: string;
  readonly principal: string;
  /** Its `exp`, in milliseconds, as it says (not trusted: core checks). */
  readonly expiresAt: number | undefined;
}

/** A request to the host for a token, numbered in the order asked. */
interface Asking {
  readonly number: number;
  readonly done: Promise<PortableToken>;
}

/** A portable host's way to core (see the header). */
export class PortableTransport {
  readonly #origin: string;
  readonly #getToken: () => Promise<string | null>;
  /** The token in use, and until when it is used without asking. */
  #held: { readonly token: PortableToken; readonly until: number } | undefined;
  /** The request to the host under way: calls meanwhile wait for it. */
  #asking: Asking | undefined;
  /** How many requests were made of the host. */
  #asked = 0;
  /** The first request whose answer may still be used. */
  #current = 1;

  constructor(options: PortableClientOptions) {
    if (typeof options.getToken !== "function") {
      throw new TypeError("getToken is a function answering a token.");
    }
    this.#origin = originOf(options.url);
    this.#getToken = options.getToken;
  }

  /** The deployment's origin, as configured. */
  get origin(): string {
    return this.#origin;
  }

  /**
   * The person's current token, or a coded refusal: `auth.unauthenticated`
   * without one, `auth.token_unavailable` when the host failed to say.
   * The host is asked only when no token is held or the one held is near
   * its `exp`, or was refused (`forget`); calls meanwhile share one
   * request, and an answer to a request made before a refusal is never
   * used.
   */
  async token(): Promise<PortableToken> {
    for (;;) {
      const held = this.#held;
      if (held !== undefined && Date.now() < held.until) {
        return held.token;
      }
      const asking = this.#asking ?? this.#ask();
      let token: PortableToken;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one request after another
        token = await this.#within(asking);
      } catch (error) {
        if (
          asking.number >= this.#current ||
          (error instanceof Error && gaveUp.has(error))
        ) {
          throw error;
        }
        continue;
      } finally {
        if (this.#asking === asking) {
          this.#asking = undefined;
        }
      }
      if (asking.number >= this.#current) {
        return token;
      }
    }
  }

  /**
   * `asking`'s token, or `auth.token_unavailable` once the host has taken
   * `tokenWaitMs` to say: that request is then given up, its answer never
   * used if it comes, and the next call asks again.
   */
  async #within(asking: Asking): Promise<PortableToken> {
    const { promise: late, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      if (this.#asking === asking) {
        this.#asking = undefined;
      }
      this.#current = Math.max(this.#current, asking.number + 1);
      const tooLong = refusal(
        "auth.token_unavailable",
        "The host took too long to provide a sign-in token. Try again."
      );
      gaveUp.add(tooLong);
      reject(tooLong);
    }, tokenWaitMs);
    try {
      return await Promise.race([asking.done, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Core refused the token sent: it isn't used again, and nor is any
   * answer to a request the host was asked before now.
   */
  forget(): void {
    this.#held = undefined;
    this.#asking = undefined;
    this.#current = this.#asked + 1;
  }

  /** Asks the host for a token, and holds it while it may be used. */
  #ask(): Asking {
    this.#asked += 1;
    const number = this.#asked;
    const read = async (): Promise<PortableToken> => {
      let text: unknown;
      try {
        text = await this.#getToken();
      } catch {
        throw refusal(
          "auth.token_unavailable",
          "The host couldn't provide a sign-in token. Try again."
        );
      }
      const claims = typeof text === "string" ? claimsOf(text) : undefined;
      if (typeof text !== "string" || claims === undefined) {
        throw refusal("auth.unauthenticated", "Sign in to continue.");
      }
      const token = {
        text,
        principal: claims.sub,
        expiresAt: claims.expiresAt,
      };
      if (number >= this.#current) {
        this.#held = { token, until: keepUntil(claims, Date.now()) };
      }
      return token;
    };
    const asking = { number, done: read() };
    this.#asking = asking;
    return asking;
  }

  /**
   * Sends `request` to `app`'s function route with `token`: what core
   * answered, or refused, settled; lost when no answer of core's came.
   */
  async send(request: string, app: string, token: string): Promise<Settled> {
    // An answer that never comes is a lost one: the caller's own retries
    // and uncertainty then apply, rather than waiting forever.
    const stop = new AbortController();
    const timer = setTimeout(() => {
      stop.abort();
    }, sendWaitMs);
    let response: Response;
    let answer: unknown;
    try {
      response = await fetch(
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
          signal: stop.signal,
        }
      );
      // Refused, whatever its body says (a proxy's page, nothing at all):
      // the next call asks the host again.
      if (response.status === unauthorized) {
        this.forget();
      }
      try {
        answer = await response.json();
      } catch {
        answer = undefined;
      }
    } catch {
      // No answer: the network failed, or core took too long.
      return { kind: "lost" };
    } finally {
      clearTimeout(timer);
    }
    if (response.ok && answer !== undefined) {
      return readAnswer(answer);
    }
    const code = isPlainObject(answer) ? answer.code : undefined;
    const message = isPlainObject(answer) ? answer.message : undefined;
    if (typeof code !== "string" || typeof message !== "string") {
      // The token refused, though not in core's words: refused all the
      // same, never a lost answer that a save would be sent again after.
      return response.status === unauthorized
        ? readRefusal("auth.unauthenticated", "Sign in to continue.")
        : { kind: "lost" };
    }
    return readRefusal(
      code,
      message,
      isPlainObject(answer) ? answer.details : undefined
    );
  }
}
