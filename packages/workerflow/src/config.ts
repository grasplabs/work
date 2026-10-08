// How a `do` step is configured: `step.do(name, config, callback)`, as
// Cloudflare Workflows takes it. A config is read once, into the engine's
// own values; the caller's object is not looked at again. What it leaves
// out is Cloudflare's default:
//
//   retries   { limit: 5, delay: 10000, backoff: "exponential" }: five
//             retries after the first attempt, the first 10 seconds after
//             it failed, each one twice as long after the one before
//   timeout   "10 minutes", each attempt
//   sensitive none: observers see the step's result
//
// A step may register a rollback with it, as its fourth argument (third,
// with no config): `{ rollback, rollbackConfig? }`. The rollback config
// takes `retries` and `timeout`, with the same defaults; the rollback
// keeps the step's sensitivity, so its errors are redacted as the step's
// are. Whether a step has a rollback, and its config, are journaled with
// the step's own config: a replay must give them again.
//
// The 10-second delay is Cloudflare's documented default. The local
// engine Wrangler ships (miniflare's) waits 1 second instead; the
// documented value is the one this profile takes.
import type {
  WorkflowBackoff,
  WorkflowDelayFunction,
  WorkflowDuration,
  WorkflowRollbackContext,
  WorkflowStepContext,
} from "./contracts.ts";
import { maxWaitMs, parseDuration } from "./durations.ts";

/** How many retries a step gets after its first attempt, by default. */
export const defaultRetryLimit = 5;
/** How long after a failed attempt the first retry comes, by default. */
export const defaultRetryDelayMs = 10_000;
const defaultBackoff: WorkflowBackoff = "exponential";
const defaultTimeout = "10 minutes";

/**
 * How much of an alarm handler's wall time attempts may take. An attempt
 * runs inside the run object's alarm handler, and Cloudflare ends one
 * after 15 minutes of wall time; a minute is kept for the replay that
 * reaches the step, the attempt's commit and the alarm's write. An
 * activation claims an attempt only if its deadline falls inside this,
 * counted from the handler's start; one that doesn't fit is left for a
 * fresh activation (activation.ts). The default: a host may give less
 * (`WorkflowRun.handlerBudgetMs`).
 */
export const handlerBudgetMs = 14 * 60 * 1000;

/**
 * The longest a compensating activation's replay may take to get back the
 * rollbacks still to run (activation.ts). It comes out of the minute an
 * alarm handler keeps beyond `handlerBudgetMs`, half of it at most: the
 * first rollback attempt after it is claimed whatever its timeout, as an
 * activation's first attempt always is, so the replay before it must fit
 * in what the budget leaves. A replay that doesn't finish in it is tried
 * again by a later activation; a host may give it less, never more.
 */
export const maxRollbackReplayMs = 30_000;

/**
 * The longest a compensating replay may take in a host whose attempts get
 * `budgetMs` of a handler's wall time: as `maxRollbackReplayMs` is to
 * Cloudflare's budget, half the margin past it, so a host with shorter
 * handlers gets a shorter replay, never one its handler can't hold.
 */
export const rollbackReplayCapMs = (budgetMs: number): number =>
  Math.max(
    1,
    Math.min(
      maxRollbackReplayMs,
      Math.floor((budgetMs * maxRollbackReplayMs) / handlerBudgetMs)
    )
  );

/**
 * How many replays in a row may end without getting back the rollbacks
 * still to run (out of time, or settled before reaching every step)
 * before the rolling back ends as errored, with a RollbackReplayTimedOut:
 * a definition that never replays to its steps again shows so, rather
 * than roll back for ever. Counted in the journal, so a restart doesn't
 * reset it; a replay that gets them back does.
 */
export const defaultRollbackReplays = 10;

/**
 * The longest an attempt may be given: all of a fresh handler's budget. A
 * longer timeout would never fire, and the attempt would be cut off by
 * the host instead. A config asking for more is refused, not run with
 * less.
 */
export const maxStepTimeoutMs = handlerBudgetMs;

/** How long a dynamic delay function may take to say its delay. */
export const delayFunctionTimeoutMs = 5000;

export type StepWork = (context: WorkflowStepContext) => unknown;

/** A step's config as the engine runs it. */
export interface StepConfig {
  /** Retries after the first attempt. */
  readonly limit: number;
  /** The delay before backoff, in ms; a function says it per failure. */
  readonly delay: number | WorkflowDelayFunction;
  readonly backoff: WorkflowBackoff;
  readonly timeoutMs: number;
  /**
   * `sensitive: "output"`: observers (history.ts) see "[REDACTED]" for its
   * result, and its errors' messages are redacted wherever they are kept.
   */
  readonly sensitive: boolean;
  /**
   * What the journal keeps of it, and every replay must give again: the
   * values in milliseconds, so "10 seconds" and 10000 are the same, and
   * the sensitivity, so a replay can't show what the run kept hidden.
   */
  readonly journal: string;
  /** What the step's callback is told, as Cloudflare tells it. */
  readonly context: WorkflowStepContext["config"];
  /** Whether the step registered a rollback. */
  readonly rollback: boolean;
}

/** A rollback as a step registers it. */
export type RollbackWork = (context: WorkflowRollbackContext) => unknown;

export interface StepCall {
  readonly work: StepWork;
  readonly config: StepConfig;
  /** The step's rollback, and the config it runs with; absent if none. */
  readonly rollback?: {
    readonly work: RollbackWork;
    readonly config: StepConfig;
  };
}

const isWork = (value: unknown): value is StepWork =>
  typeof value === "function";

export const describe = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : `a ${typeof value}`;

export const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Each setting `keys` names, read once as JavaScript reads a property (a
 * getter, an inherited one, counts). A setting it doesn't name, enumerable
 * on the object or its prototypes, is refused, as is an object that throws
 * while it is read: an unknown shape is never read as a default.
 */
export const readSettings = <Key extends string>(
  what: string,
  value: object,
  keys: readonly Key[]
): Record<Key, unknown> => {
  const known = new Set<string>(keys);
  let unknownSetting: string | undefined;
  const read: Partial<Record<Key, unknown>> = {};
  try {
    for (const key in value) {
      if (!known.has(key)) {
        unknownSetting = key;
        break;
      }
    }
    for (const key of keys) {
      read[key] = Reflect.get(value, key);
    }
  } catch {
    throw new TypeError(`${what} can't be read`);
  }
  if (unknownSetting !== undefined) {
    throw new TypeError(`${what} has no setting ${describe(unknownSetting)}`);
  }
  // SAFETY: every key was read above, an absent one as undefined.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return read as Record<Key, unknown>;
};

const backoffs = new Set<unknown>(["constant", "linear", "exponential"]);

const isBackoff = (value: unknown): value is WorkflowBackoff =>
  backoffs.has(value);

interface Retries {
  limit: number;
  delay: number | WorkflowDelayFunction;
  backoff: WorkflowBackoff;
  /** The delay as given, for the context; absent for a function. */
  given: WorkflowDuration | undefined;
}

const defaultRetries: Retries = {
  limit: defaultRetryLimit,
  delay: defaultRetryDelayMs,
  backoff: defaultBackoff,
  given: defaultRetryDelayMs,
};

const readRetries = (retries: unknown): Retries => {
  if (retries === undefined) {
    return defaultRetries;
  }
  if (!isPlainObject(retries)) {
    throw new TypeError(
      `A step's retries are { limit, delay, backoff? }, not ${
        retries === null ? "null" : describe(retries)
      }`
    );
  }
  const { limit, delay, backoff } = readSettings("A step's retries", retries, [
    "limit",
    "delay",
    "backoff",
  ] as const);
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(
      `A step's retry limit is a whole number from 0: ${String(limit)}`
    );
  }
  if (backoff !== undefined && !isBackoff(backoff)) {
    throw new TypeError(
      `A step's backoff is "constant", "linear" or "exponential", not ${describe(backoff)}`
    );
  }
  if (typeof delay === "function") {
    return {
      limit,
      // SAFETY: a function, called with Cloudflare's { ctx, error }; what
      // it returns is checked when it returns.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      delay: delay as WorkflowDelayFunction,
      backoff: backoff ?? defaultBackoff,
      given: undefined,
    };
  }
  const ms = parseDuration(delay, "A step's retry delay");
  return {
    limit,
    delay: ms,
    backoff: backoff ?? defaultBackoff,
    // SAFETY: parseDuration took it, so it is a number or a duration.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    given: delay as WorkflowDuration,
  };
};

const readTimeout = (
  timeout?: unknown
): { ms: number; given: WorkflowDuration } => {
  if (timeout === undefined) {
    return {
      ms: parseDuration(defaultTimeout, "the default timeout"),
      given: defaultTimeout,
    };
  }
  const ms = parseDuration(timeout, "A step's timeout");
  if (ms === 0 || ms > maxStepTimeoutMs) {
    throw new TypeError(
      `A step's timeout is more than 0 and at most 14 minutes, the longest an attempt can run here: ${JSON.stringify(timeout)}`
    );
  }
  // SAFETY: parseDuration took it, so it is a number or a duration.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ms, given: timeout as WorkflowDuration };
};

const readSensitive = (sensitive: unknown): boolean => {
  if (sensitive !== undefined && sensitive !== "output") {
    throw new TypeError(
      `A step's sensitive setting is "output", not ${describe(sensitive)}`
    );
  }
  return sensitive === "output";
};

/** What the journal keeps of a config: its values, never a function. */
interface JournalFields {
  limit: number;
  delay: number | "dynamic";
  backoff: WorkflowBackoff;
  timeout: number;
  sensitive: boolean;
  /** The rollback's own, when the step registered one. */
  rollback?: JournalFields;
}

/** A config, and the fields its journal text is made of. */
interface Built {
  config: StepConfig;
  fields: JournalFields;
}

const build = (
  retries: Retries,
  timeout: unknown,
  sensitive: boolean,
  rollback?: JournalFields
): Built => {
  const { ms: timeoutMs, given: timeoutGiven } = readTimeout(timeout);
  const { limit, delay, backoff, given } = retries;
  const resolvedRetries =
    given === undefined ? { limit, backoff } : { limit, delay: given, backoff };
  const fields: JournalFields = {
    limit,
    delay: typeof delay === "function" ? "dynamic" : delay,
    backoff,
    timeout: timeoutMs,
    sensitive,
  };
  if (rollback !== undefined) {
    fields.rollback = rollback;
  }
  return {
    fields,
    config: {
      limit,
      delay,
      backoff,
      timeoutMs,
      sensitive,
      rollback: rollback !== undefined,
      journal: JSON.stringify(fields),
      context: sensitive
        ? {
            retries: resolvedRetries,
            timeout: timeoutGiven,
            sensitive: "output",
          }
        : { retries: resolvedRetries, timeout: timeoutGiven },
    },
  };
};

/** A step's settings, as read from its config: nothing built yet. */
interface Settings {
  retries: Retries;
  timeout: unknown;
  sensitive: boolean;
}

const defaultSettings: Settings = {
  retries: defaultRetries,
  timeout: undefined,
  sensitive: false,
};

const readConfig = (config: unknown): Settings => {
  if (!isPlainObject(config)) {
    throw new TypeError(
      `A step's config is an object, not ${config === null ? "null" : describe(config)}`
    );
  }
  const { retries, timeout, sensitive } = readSettings(
    "A step's config",
    config,
    ["retries", "timeout", "sensitive"] as const
  );
  return {
    retries: readRetries(retries),
    timeout,
    sensitive: readSensitive(sensitive),
  };
};

const isRollbackWork = (value: unknown): value is RollbackWork =>
  typeof value === "function";

/**
 * A step's rollback options, read once each: `{ rollback, rollbackConfig? }`,
 * Cloudflare's shape. `sensitive` is the step's own, which its rollback
 * keeps.
 */
const readRollback = (
  options: unknown,
  sensitive: boolean
): { work: RollbackWork; built: Built } | undefined => {
  if (options === undefined) {
    return undefined;
  }
  if (!isPlainObject(options)) {
    throw new TypeError(
      `A step's rollback options are { rollback, rollbackConfig? }, not ${options === null ? "null" : describe(options)}`
    );
  }
  const { rollback, rollbackConfig } = readSettings(
    "A step's rollback options",
    options,
    ["rollback", "rollbackConfig"] as const
  );
  if (!isRollbackWork(rollback)) {
    throw new TypeError(
      `A step's rollback is a function, not ${rollback === null ? "null" : describe(rollback)}`
    );
  }
  if (rollbackConfig === undefined) {
    return {
      work: rollback,
      built: build(defaultRetries, undefined, sensitive),
    };
  }
  if (!isPlainObject(rollbackConfig)) {
    throw new TypeError(
      `A rollback's config is { retries?, timeout? }, not ${rollbackConfig === null ? "null" : describe(rollbackConfig)}`
    );
  }
  const { retries, timeout } = readSettings(
    "A rollback's config",
    rollbackConfig,
    ["retries", "timeout"] as const
  );
  return {
    work: rollback,
    built: build(readRetries(retries), timeout, sensitive),
  };
};

const callOf = (
  work: StepWork,
  settings: Settings,
  rollbackOptions: unknown
): StepCall => {
  const rollback = readRollback(rollbackOptions, settings.sensitive);
  const { config } = build(
    settings.retries,
    settings.timeout,
    settings.sensitive,
    rollback?.built.fields
  );
  return rollback === undefined
    ? { work, config }
    : {
        work,
        config,
        rollback: { work: rollback.work, config: rollback.built.config },
      };
};

/**
 * `step.do(name, callback, rollback?)` or `step.do(name, config, callback,
 * rollback?)`. A config or rollback that isn't valid is a TypeError to the
 * definition, before anything is journaled.
 */
export const readCall = (rest: unknown[]): StepCall => {
  const [first, second, third] = rest;
  if (isWork(first) && rest.length <= 2) {
    return callOf(first, defaultSettings, second);
  }
  if (isWork(second) && rest.length >= 2 && rest.length <= 3) {
    return callOf(second, readConfig(first), third);
  }
  throw new TypeError(
    "step.do takes a name, an optional config, a callback and optional rollback options"
  );
};

/**
 * How long after attempt `attempt` failed the next one comes, from the
 * delay `base` (the config's, or what its function said): Cloudflare's
 * backoff. No retry waits longer than a sleep can: a schedule past that
 * (an exponential one, many attempts in) waits `maxWaitMs`. Never NaN or
 * Infinity, whatever the attempt: a delay of 0 stays 0, and a multiplier
 * that would carry the delay past the cap saturates before it multiplies.
 */
export const retryDelayMs = (
  backoff: WorkflowBackoff,
  base: number,
  attempt: number
): number => {
  if (base === 0) {
    return 0;
  }
  let multiplier = 1;
  if (backoff === "exponential") {
    multiplier = 2 ** (attempt - 1);
  } else if (backoff === "linear") {
    multiplier = attempt;
  }
  // `base` is a whole, finite number of ms above 0 (parseDuration), so
  // only the multiplier can run away; 2 ** 1024 is Infinity.
  if (!(multiplier < maxWaitMs / base)) {
    return maxWaitMs;
  }
  return Math.min(base * multiplier, maxWaitMs);
};
