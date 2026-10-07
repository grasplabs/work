import { member } from "./checker.ts";
import type { Checker, Site } from "./checker.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import { profileLimits } from "./limits.ts";
import { taskDefinition } from "./task-parts.ts";
import {
  allowKeys,
  at,
  durationAt,
  expressionOnly,
  literalText,
  objectAt,
  requireKey,
} from "./values.ts";

/**
 * Errors and their recovery: `raise`, reusable and inline errors, retry
 * policies and timeouts.
 */

/** Upstream error types are the host's categories: a raise can't claim one. */
const hostErrorPrefixes = [
  "https://open-workflow-specification.org/spec/",
  "https://serverlessworkflow.io/spec/",
];

const uriPattern = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;

const maxUriLength = 512;

/** Authentication and authorization are the host's to decide. */
const hostStatuses = new Set([401, 403]);

/** A timeout: `{ after: duration }`, literal, or a reusable timeout's name. */
export const checkTimeout = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  if (typeof value === "string") {
    if (!checker.reusableTimeouts.has(value)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointer),
        "Name a timeout declared in use.timeouts.",
        { reason: "unknown timeout" }
      );
    }
    return;
  }
  const object = objectAt(checker, value, pointer, site, "a timeout");
  if (object === undefined) {
    return;
  }
  allowKeys(checker, object, ["after"], pointer, site);
  if (requireKey(checker, object, "after", pointer, site)) {
    durationAt(checker, object.after, pointerJoin(pointer, "after"), site);
  }
};

/** A reusable or raised error: literal throughout, host types refused. */
export const checkErrorDefinition = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const error = objectAt(checker, value, pointer, site, "the error");
  if (error === undefined) {
    return;
  }
  allowKeys(
    checker,
    error,
    ["type", "status", "title", "detail"],
    pointer,
    site,
    {
      instance: "Leave instance out: the host sets it to the raising task.",
    }
  );
  if (requireKey(checker, error, "type", pointer, site)) {
    const typePointer = pointerJoin(pointer, "type");
    const type = literalText(
      checker,
      error.type,
      typePointer,
      site,
      maxUriLength
    );
    if (type !== undefined && !uriPattern.test(type)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, typePointer),
        "Give the error type as a URI.",
        {
          expected: "URI",
        }
      );
    } else if (
      type !== undefined &&
      hostErrorPrefixes.some((prefix) => type.startsWith(prefix))
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, typePointer),
        "Use a domain error type: the standard error types are the host's to raise.",
        { reason: "host error type" }
      );
    }
  }
  if (requireKey(checker, error, "status", pointer, site)) {
    const { status } = error;
    const statusPointer = pointerJoin(pointer, "status");
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, statusPointer),
        "Give the status as a literal whole number from 400 to 599.",
        { expected: "400-599" }
      );
    } else if (hostStatuses.has(status)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, statusPointer),
        "Authentication and authorization failures are the host's to raise.",
        { reason: "host status" }
      );
    }
  }
  for (const key of ["title", "detail"]) {
    const text = member(error, key);
    if (text === undefined) {
      continue;
    }
    // Literal, inline or reusable: an error is never built from data.
    literalText(checker, text, pointerJoin(pointer, key), site, 2000);
  }
};

const backoffStrategies = new Set(["constant", "linear", "exponential"]);

const checkBackoff = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const backoff = objectAt(checker, value, pointer, site, "the backoff");
  if (backoff === undefined) {
    return;
  }
  const strategies = Object.keys(backoff);
  const [strategy] = strategies;
  const settings = strategy === undefined ? undefined : backoff[strategy];
  const valid =
    strategies.length === 1 &&
    strategy !== undefined &&
    backoffStrategies.has(strategy) &&
    isObject(settings) &&
    Object.keys(settings).length === 0;
  if (!valid) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Choose one backoff: { constant: {} }, { linear: {} } or { exponential: {} }.",
      { expected: "constant, linear or exponential" }
    );
  }
};

/** `limit.attempt.count` (1 to 5, the first attempt included), durations. */
const checkRetryLimit = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const limit = objectAt(checker, value, pointer, site, "the retry limit");
  if (limit === undefined) {
    return;
  }
  allowKeys(checker, limit, ["attempt", "duration"], pointer, site);
  if (Object.hasOwn(limit, "duration")) {
    durationAt(checker, limit.duration, pointerJoin(pointer, "duration"), site);
  }
  if (!requireKey(checker, limit, "attempt", pointer, site)) {
    return;
  }
  const attemptPointer = pointerJoin(pointer, "attempt");
  const attempt = objectAt(
    checker,
    limit.attempt,
    attemptPointer,
    site,
    "the attempt limit"
  );
  if (attempt === undefined) {
    return;
  }
  allowKeys(checker, attempt, ["count", "duration"], attemptPointer, site);
  if (Object.hasOwn(attempt, "duration")) {
    durationAt(
      checker,
      attempt.duration,
      pointerJoin(attemptPointer, "duration"),
      site
    );
  }
  const { count } = attempt;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > profileLimits.maxRetryAttempts
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(attemptPointer, "count")),
      "Allow 1 to 5 attempts, the first included.",
      { expected: "1-5" }
    );
  }
};

const checkJitter = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const jitter = objectAt(checker, value, pointer, site, "the jitter");
  if (jitter === undefined) {
    return;
  }
  allowKeys(checker, jitter, ["from", "to"], pointer, site);
  const bound = (key: "from" | "to"): number | undefined =>
    requireKey(checker, jitter, key, pointer, site)
      ? durationAt(checker, jitter[key], pointerJoin(pointer, key), site)
      : undefined;
  const from = bound("from");
  const to = bound("to");
  if (
    from !== undefined &&
    to !== undefined &&
    (from > to || to > profileLimits.maxJitterMs)
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Keep jitter from at most to, and to at most a minute.",
      { expected: "from <= to <= 60s" }
    );
  }
};

/** A retry policy: 1 to 5 attempts, literal durations, checked backoff. */
export const checkRetryPolicy = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const policy = objectAt(checker, value, pointer, site, "the retry policy");
  if (policy === undefined) {
    return;
  }
  allowKeys(
    checker,
    policy,
    ["when", "exceptWhen", "delay", "backoff", "limit", "jitter"],
    pointer,
    site
  );
  for (const key of ["when", "exceptWhen"]) {
    if (Object.hasOwn(policy, key)) {
      expressionOnly(
        checker,
        policy[key],
        pointerJoin(pointer, key),
        taskDefinition,
        site,
        "boolean"
      );
    }
  }
  if (Object.hasOwn(policy, "delay")) {
    durationAt(checker, policy.delay, pointerJoin(pointer, "delay"), site);
  }
  if (Object.hasOwn(policy, "backoff")) {
    checkBackoff(
      checker,
      policy.backoff,
      pointerJoin(pointer, "backoff"),
      site
    );
  }
  if (requireKey(checker, policy, "limit", pointer, site)) {
    checkRetryLimit(checker, policy.limit, pointerJoin(pointer, "limit"), site);
  }
  if (Object.hasOwn(policy, "jitter")) {
    checkJitter(checker, policy.jitter, pointerJoin(pointer, "jitter"), site);
  }
};

export const checkRaise = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site
): void => {
  const raisePointer = pointerJoin(pointer, "raise");
  const raise = objectAt(checker, task.raise, raisePointer, site, "raise");
  if (raise === undefined) {
    return;
  }
  allowKeys(checker, raise, ["error"], raisePointer, site);
  if (!requireKey(checker, raise, "error", raisePointer, site)) {
    return;
  }
  const errorPointer = pointerJoin(raisePointer, "error");
  const { error } = raise;
  if (typeof error === "string") {
    if (!checker.reusableErrors.has(error)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, errorPointer),
        "Name an error declared in use.errors.",
        { reason: "unknown error" }
      );
    }
    return;
  }
  checkErrorDefinition(checker, error, errorPointer, site);
};
