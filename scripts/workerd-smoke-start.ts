/**
 * How the workerd smoke run (workerd-smoke.ts) decides that core started:
 * core's own health answer came before workerd exited. Apart from the
 * script so it can be tested without workerd.
 */
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

/** What the smoke run needs of workerd's process. */
export interface WorkerdProcess extends EventEmitter {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

/** How the smoke run polls core's health. */
export interface HealthPoll {
  url: string;
  headers: Record<string, string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  attempts: number;
  retryDelayMs: number;
}

/**
 * Whether it's core's own health answer: exactly `{"ok":true}`, with the
 * request ID core puts on every response.
 */
export const isCoreHealth = async (response: Response): Promise<boolean> =>
  response.ok &&
  response.headers.has("x-request-id") &&
  (await response.text()) === JSON.stringify({ ok: true });

/**
 * Polls until something answers, then says what's wrong with the answer:
 * nothing when it's core's. Attempts are sequential by design.
 */
export const waitForCore = async (
  poll: HealthPoll,
  attempt = 0
): Promise<string | undefined> => {
  if (attempt >= poll.attempts) {
    return "core did not answer on workerd";
  }
  let response: Response;
  try {
    response = await poll.fetch(poll.url, { headers: poll.headers });
  } catch {
    await sleep(poll.retryDelayMs);
    return await waitForCore(poll, attempt + 1);
  }
  return (await isCoreHealth(response))
    ? undefined
    : `something other than core answers at ${poll.url}`;
};

/** Once workerd exits, how it did, before `what`. */
const exited = async (
  workerd: WorkerdProcess,
  what = "core answered"
): Promise<string> => {
  await once(workerd, "exit");
  const how = workerd.signalCode ?? workerd.exitCode;
  return `workerd exited (${String(how)}) before ${what}`;
};

/**
 * Resolves once core answers its health check; rejects when it answers
 * otherwise, never does, or workerd exits first. workerd exits at once
 * when it can't start (its port taken, say): the smoke fails then, rather
 * than polling whatever else listens there.
 */
export const coreStarted = async (
  workerd: WorkerdProcess,
  poll: HealthPoll
): Promise<void> => {
  const failure = await Promise.race([waitForCore(poll), exited(workerd)]);
  if (failure !== undefined) {
    throw new Error(failure);
  }
};

/**
 * A failure the on-prem profile is known to have today, excused only for
 * its exact event and error, with why: the smoke names each one it sees.
 */
export interface KnownGap {
  event: string;
  errorMessage: string;
  why: string;
}

/** One line workerd wrote: its structured log level and message. */
interface LogLine {
  level: string;
  message: string;
}

const logLineSchema = z.object({ level: z.string(), message: z.string() });

/**
 * A line of workerd's output: a structured log line (`structuredLogging`),
 * or anything else workerd itself writes, taken as is.
 */
export const parseLogLine = (line: string): LogLine => {
  try {
    const parsed = logLineSchema.safeParse(JSON.parse(line));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Not JSON: workerd's own output.
  }
  return { level: "raw", message: line };
};

/**
 * A field of a logged object, as workerd prints it (`{ event: 'x', ... }`):
 * its string value, quoted with ', " or ` as the value needs.
 */
export const logField = (message: string, name: string): string | undefined =>
  new RegExp(`\\b${name}: (['"\`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`, "u").exec(
    message
  )?.[2];

const rawError = /\berror\b/iu;

/** What's wrong with a line, given the known gaps; nothing when it's fine. */
const failureOf = (
  { level, message }: LogLine,
  knownGaps: readonly KnownGap[]
): { failure?: string; gap?: KnownGap } => {
  const event = logField(message, "event");
  const failed =
    level === "error" ||
    (event !== undefined && event.endsWith("_failed")) ||
    (level === "raw" && rawError.test(message));
  if (!failed) {
    return {};
  }
  const errorMessage = logField(message, "errorMessage");
  const gap = knownGaps.find(
    (known) => known.event === event && known.errorMessage === errorMessage
  );
  return gap === undefined ? { failure: message } : { gap };
};

/**
 * Reads workerd's output until core's built-ins are installed: resolves with
 * the known gaps it excused, rejects on the first failure. Every error-level
 * line, `*_failed` event, or error workerd itself writes fails it, unless a
 * known gap names it exactly. A partial install passes only when a known
 * gap was excused, which is what made it partial; otherwise it must be
 * complete.
 */
export const builtinsInstalled = async (
  lines: AsyncIterable<string> | Iterable<string>,
  knownGaps: readonly KnownGap[]
): Promise<KnownGap[]> => {
  const excused = new Set<KnownGap>();
  for await (const line of lines) {
    const parsed = parseLogLine(line);
    const { failure, gap } = failureOf(parsed, knownGaps);
    if (failure !== undefined) {
      throw new Error(`core logged a failure on workerd: ${failure}`);
    }
    if (gap !== undefined) {
      excused.add(gap);
    }
    if (logField(parsed.message, "event") === "builtins.installed") {
      const outcome = logField(parsed.message, "outcome");
      if (
        outcome === "complete" ||
        (outcome === "partial" && excused.size > 0)
      ) {
        return [...excused];
      }
      throw new Error(`built-in content installed ${String(outcome)}`);
    }
  }
  throw new Error("workerd's output ended before the built-ins were installed");
};

/** Rejects with the failure `failure` settles to. */
const failWith = async (failure: Promise<string>): Promise<never> => {
  throw new Error(await failure);
};

/**
 * Resolves once core's built-ins are installed (`builtinsInstalled`);
 * rejects as it does, when workerd exits first, or after `timeoutMs`.
 */
export const installedOnWorkerd = async (
  workerd: WorkerdProcess,
  lines: AsyncIterable<string>,
  knownGaps: readonly KnownGap[],
  timeoutMs: number
): Promise<KnownGap[]> => {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      builtinsInstalled(lines, knownGaps),
      failWith(exited(workerd, "the built-ins were installed")),
      failWith(
        sleep(
          timeoutMs,
          `the built-ins weren't installed within ${timeoutMs} ms`,
          { signal: timeout.signal }
        )
      ),
    ]);
  } finally {
    timeout.abort();
  }
};
