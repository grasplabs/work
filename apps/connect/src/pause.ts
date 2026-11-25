import { retryAfterOf } from "@grasp-os/runtime/connector";
import { log } from "@grasp-os/shared/log";

import { pauseFor } from "./tokens.ts";

// How long a provider asks a connection to pause, read from its answer:
// a native connector's at the egress, a connector's MCP server's where
// connect sends to it (mcp-connectors.ts). The pause is kept by
// `pauseFor`, on the row every call reads its credential from.

/** How long a 429 that names no wait pauses its connection, in seconds. */
const defaultPauseSeconds = 60;

/** A reset above this (in 2001) is a Unix time, not a number of seconds. */
const unixTimeAbove = 1_000_000_000;

/**
 * A reset above this (in 5138) is neither a Unix time in seconds nor a
 * number of seconds, such as one in milliseconds: it isn't read.
 */
const resetReadUpTo = 100_000_000_000;

const rateLimitName = /rate-?limit/u;
const resetName = /reset/u;
const secondsValue = /^\d+(?:\.\d+)?$/u;

/**
 * The seconds until the provider's rate limit resets, by the headers whose
 * name says rate limit and reset (`x-ratelimit-reset`,
 * `x-<vendor>-ratelimit-reset`): one above `unixTimeAbove` is a Unix
 * time, a smaller one a number of seconds, and one that is neither,
 * already past, or of a limit its `remaining` header (the same name with
 * `remaining` for `reset`) says isn't used up, isn't read: the 429 is
 * some other limit's. The earliest of several (a vendor with limits
 * per second and per day may send both): a pause that ends too soon costs
 * one more 429, which pauses the connection again, while one that ends
 * too late keeps every caller waiting for nothing (`pauseFor` keeps it
 * to an hour). Undefined when none says.
 */
const resetSecondsOf = (headers: Headers, now: number): number | undefined => {
  const waits = [...headers]
    .filter(
      ([name, value]) =>
        rateLimitName.test(name) &&
        resetName.test(name) &&
        secondsValue.test(value.trim()) &&
        !(Number(headers.get(name.replace(resetName, "remaining"))) > 0)
    )
    .map(([, value]) => Number(value))
    .filter((reset) => reset <= resetReadUpTo)
    .map((reset) => (reset > unixTimeAbove ? reset - now / 1000 : reset))
    .filter((wait) => wait > 0);
  if (waits.length === 0) {
    return undefined;
  }
  return Math.ceil(Math.min(...waits));
};

/**
 * How long the provider's answer asks its connection to pause, in
 * seconds, if it does: a 429 for as long as its `retry-after` says, or
 * else until its rate limit resets, or else a minute; a 403 or 503 only
 * when it carries `retry-after`, which sets a rate limit apart from a
 * refusal or an outage. A rate limit a provider signals some other way
 * (a 403 whose body names it) is its connector's to say, by
 * `isThrottled`, and connect pauses for it on the tool's answer (call.ts).
 */
const pauseSecondsOf = (
  response: Response,
  now: number
): number | undefined => {
  const retryAfter = retryAfterOf(response);
  if (response.status === 429) {
    return (
      retryAfter ?? resetSecondsOf(response.headers, now) ?? defaultPauseSeconds
    );
  }
  return response.status === 403 || response.status === 503
    ? retryAfter
    : undefined;
};

/**
 * Pauses connection `connectionId` as its provider's answer asks, if it
 * does: the seconds the pause in force has left.
 */
export const pauseAsked = async (
  db: D1Database,
  connectionId: string,
  response: Response,
  logged: { connector: string; callId?: string }
): Promise<number | undefined> => {
  const seconds = pauseSecondsOf(response, Date.now());
  if (seconds === undefined || seconds === 0) {
    return undefined;
  }
  log.info("connection.paused", {
    ...logged,
    status: response.status,
    seconds,
  });
  return await pauseFor(db, connectionId, seconds);
};
