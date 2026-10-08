/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { isoDurationMs } from "@grasp-os/workflow-expressions/duration";
import type { Stage } from "@grasp-os/workflow-expressions/evaluate";
import { parseSlot } from "@grasp-os/workflow-expressions/source";

import { taskIdOf } from "./checker.ts";
import type { Checker, Expectation, Site, Where } from "./checker.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import { profileLimits } from "./limits.ts";

/** Where a site is, at `pointer`. */
export const at = (site: Site, pointer: string): Where => ({
  pointer,
  taskId: taskIdOf(site),
});

/** A site outside every task: the workflow's own input and output. */
export const workflowSite: Site = {
  scope: [],
  loopVariables: [],
  errorVariables: [],
  inFunction: undefined,
};

/** Records one expression to compile once the walk is done. */
export const addSlot = (
  checker: Checker,
  source: string,
  pointer: string,
  stage: Stage,
  site: Site,
  expects?: Expectation
): void => {
  if (checker.slots.length >= profileLimits.maxExpressions) {
    if (!checker.slotsFull) {
      checker.slotsFull = true;
      checker.report.error(
        "expression.too_many",
        at(site, pointer),
        `Keep the definition to ${profileLimits.maxExpressions} expressions, or split it.`
      );
    }
    return;
  }
  checker.slots.push({
    source,
    stage,
    scope: site.scope,
    pointer,
    loopVariables: site.loopVariables,
    errorVariables: site.errorVariables,
    ...(expects === undefined ? {} : { expects }),
  });
};

/**
 * Refuses `${ … }` with whitespace around it: upstream's pattern reads it
 * as an expression, strict mode as a literal, so it is taken as neither.
 */
const refusePadded = (checker: Checker, pointer: string, site: Site): void => {
  checker.report.error(
    "expression.expected",
    at(site, pointer),
    "Write the expression as ${ … } with nothing around it."
  );
};

/**
 * A place that only takes an expression (a condition, a loop's collection):
 * a literal there is refused rather than taken as a constant.
 */
export const expressionOnly = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  stage: Stage,
  site: Site,
  expects?: Expectation
): void => {
  const slot = typeof value === "string" ? parseSlot(value) : undefined;
  if (slot?.kind === "padded") {
    refusePadded(checker, pointer, site);
    return;
  }
  if (slot?.kind !== "expression") {
    checker.report.error(
      "expression.expected",
      at(site, pointer),
      "Write it as ${ … }: a jq expression.",
      expects === undefined ? {} : { expected: expects }
    );
    return;
  }
  addSlot(checker, slot.source, pointer, stage, site, expects);
};

/**
 * A configuration value (arguments, `set`, event data): any JSON, in which
 * each string that is exactly `${ … }` is an expression, evaluated once,
 * and everything else a literal. Literal data nests at most as deep as any
 * value may. Whether any expression was found.
 */
export const dataValue = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  stage: Stage,
  site: Site,
  depth = 0
): boolean => {
  if (typeof value === "string") {
    const slot = parseSlot(value);
    if (slot.kind === "padded") {
      refusePadded(checker, pointer, site);
      return false;
    }
    if (slot.kind === "expression") {
      addSlot(checker, slot.source, pointer, stage, site);
      return true;
    }
    return false;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (depth >= profileLimits.maxDataDepth) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      `Nest literal data at most ${profileLimits.maxDataDepth} levels deep.`,
      { reason: "literal data too deep" }
    );
    return false;
  }
  let found = false;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      found =
        dataValue(
          checker,
          item,
          pointerJoin(pointer, index),
          stage,
          site,
          depth + 1
        ) || found;
    }
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    found =
      dataValue(
        checker,
        item,
        pointerJoin(pointer, key),
        stage,
        site,
        depth + 1
      ) || found;
  }
  return found;
};

/**
 * Checks an object's keys against those the profile allows there. Keys the
 * upstream specification has but the profile leaves out get their own
 * code, so the remedy can say so.
 */
export const allowKeys = (
  checker: Checker,
  object: JsonObject,
  allowed: readonly string[],
  pointer: string,
  site: Site,
  unsupported: Readonly<Record<string, string>> = {}
): void => {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) {
      continue;
    }
    const remedy = Object.hasOwn(unsupported, key)
      ? unsupported[key]
      : undefined;
    if (remedy === undefined) {
      checker.report.error(
        "profile.unknown_property",
        at(site, pointerJoin(pointer, key)),
        `Remove it; allowed here: ${allowed.join(", ")}.`
      );
    } else {
      checker.report.error(
        "profile.unsupported_feature",
        at(site, pointerJoin(pointer, key)),
        remedy
      );
    }
  }
};

/** Requires `key` in `object`; whether it is there. */
export const requireKey = (
  checker: Checker,
  object: JsonObject,
  key: string,
  pointer: string,
  site: Site
): boolean => {
  if (Object.hasOwn(object, key)) {
    return true;
  }
  checker.report.error(
    "profile.missing_property",
    at(site, pointerJoin(pointer, key)),
    `Add ${key}.`
  );
  return false;
};

/** An object where the profile needs one; reports and returns undefined. */
export const objectAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  what: string
): JsonObject | undefined => {
  if (isObject(value)) {
    return value;
  }
  checker.report.error(
    "profile.invalid_value",
    at(site, pointer),
    `Write ${what} as an object.`,
    {
      expected: "object",
    }
  );
  return undefined;
};

/** Text within `limit` characters, at least one. */
export const textAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  limit: number
): string | undefined => {
  if (typeof value === "string" && value.length > 0 && value.length <= limit) {
    return value;
  }
  checker.report.error(
    "profile.invalid_value",
    at(site, pointer),
    `Write text of 1 to ${limit} characters.`,
    { expected: "text" }
  );
  return undefined;
};

/** A literal string: not an expression, which can't widen what it names. */
export const literalText = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  limit: number
): string | undefined => {
  const text = textAt(checker, value, pointer, site, limit);
  if (text !== undefined && parseSlot(text).kind !== "literal") {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Write it as a literal: an expression can't choose it.",
      { expected: "literal text" }
    );
    return undefined;
  }
  return text;
};

// RFC 3986, without IP-literal hosts: an absolute URI, so a valid
// uri-reference, matching upstream's uriTemplate pattern too. Upstream
// types source, dataschema and error types as such a URI (or a runtime
// expression); the profile accepts only what that holds for.
const pchar = String.raw`(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})`;
const regName = String.raw`(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*`;
const userInfo = String.raw`(?:(?:[A-Za-z0-9\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?`;
const absoluteUri = new RegExp(
  String.raw`^[A-Za-z][A-Za-z0-9+.\-]*:` +
    String.raw`(?://${userInfo}${regName}(?::[0-9]*)?(?:/${pchar}*)*|${pchar}+(?:/${pchar}*)*|/(?:${pchar}+(?:/${pchar}*)*)?)` +
    String.raw`(?:\?(?:${pchar}|[/?])*)?(?:#(?:${pchar}|[/?])*)?$`,
  "u"
);
export const maxUriLength = 512;

/** Whether `text` is an absolute URI upstream's URI fields accept. */
export const isUri = (text: string): boolean =>
  text.length <= maxUriLength && absoluteUri.test(text);

const lineBreak = /[\n\r\u2028\u2029]/u;

/**
 * Where upstream types a field as a runtime expression, its pattern
 * (`^\s*\$\{.+\}\s*$`) holds the source to one line: so does the profile.
 */
export const isOneLine = (text: string): boolean => !lineBreak.test(text);

const durationMembers: ReadonlyMap<string, number> = new Map([
  ["days", 86_400_000],
  ["hours", 3_600_000],
  ["minutes", 60_000],
  ["seconds", 1000],
  ["milliseconds", 1],
]);

/**
 * A duration: upstream's `{ days, hours, minutes, seconds, milliseconds }`
 * of literal whole numbers, or a fixed ISO 8601 duration; with
 * `expression`, also a `${ … }` that returns, at run time, whole
 * milliseconds or a fixed ISO 8601 duration (the evaluator's `duration`
 * contract). Its
 * milliseconds when literal; refuses zero, calendar units and fractions of
 * a millisecond.
 */
export const durationAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  expression?: { stage: Stage }
): number | undefined => {
  const refuse = (remedy: string): void => {
    checker.report.error("profile.invalid_value", at(site, pointer), remedy, {
      expected: "a positive duration of fixed units",
    });
  };
  if (typeof value === "string") {
    const slot = parseSlot(value);
    if (slot.kind === "padded") {
      refusePadded(checker, pointer, site);
      return undefined;
    }
    if (slot.kind === "literal") {
      const ms = isoDurationMs(value);
      if (ms === undefined) {
        refuse(
          "Use a positive ISO 8601 duration of weeks, days, hours, minutes and seconds, in whole milliseconds."
        );
      }
      return ms;
    }
    if (expression === undefined) {
      refuse("Write this duration as a literal.");
    } else if (isOneLine(value)) {
      addSlot(
        checker,
        slot.source,
        pointer,
        expression.stage,
        site,
        "duration"
      );
    } else {
      refuse("Write the duration's expression on one line.");
    }
    return undefined;
  }
  if (!isObject(value)) {
    refuse("Write a duration as an object of whole units or an ISO 8601 text.");
    return undefined;
  }
  let total = 0;
  for (const [key, amount] of Object.entries(value)) {
    const unit = durationMembers.get(key);
    if (unit === undefined) {
      checker.report.error(
        "profile.unknown_property",
        at(site, pointerJoin(pointer, key)),
        "Use days, hours, minutes, seconds and milliseconds."
      );
      return undefined;
    }
    if (
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    ) {
      refuse("Give each unit as a literal whole number of at least 0.");
      return undefined;
    }
    total += amount * unit;
  }
  if (total <= 0 || !Number.isSafeInteger(total)) {
    refuse("Make the duration longer than zero and finite.");
    return undefined;
  }
  return total;
};
