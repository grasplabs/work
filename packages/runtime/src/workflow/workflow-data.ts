import type { Json } from "@grasp-os/shared/json";

// The data a workflow reads: JSON, every object with no prototype and
// everything frozen, all the way down, so a workflow's code can't change
// what it was given or reach a prototype through it.

/**
 * The runtime's built-ins, kept as this module loads: a run's main module
 * loads the SDK before any of the workflow's code, which could otherwise
 * put its own in their place.
 */
const { freeze, defineProperty } = Object;
const { isArray } = Array;

/**
 * A value the code computed, as JSON, as `JSON.stringify` writes it:
 * `undefined`, which JSON has no value for, is `null` on its own and in a
 * list, and an object's member set to it is left out; a number JSON can't
 * write (`NaN`, `±Infinity`) is `null`, and `-0` is `0`. Anything else
 * that isn't JSON (a function, a symbol, a bigint) is a `TypeError`.
 */
export const jsonValue = (value: unknown): Json => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    // `+ 0` makes `-0` `0`, as JSON writes it.
    return Number.isFinite(value) ? value + 0 : null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (isArray(value)) {
    return value.map((item: unknown) => jsonValue(item));
  }
  if (typeof value !== "object") {
    throw new TypeError("A workflow's values are JSON.");
  }
  const members: [string, Json][] = [];
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) {
      members.push([key, jsonValue(member)]);
    }
  }
  // Own fields, `__proto__` among them, as `fromEntries` defines each.
  return Object.fromEntries(members);
};

/** `value`'s objects with no prototype, and every object and list frozen, in place. */
const frozenInPlace = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    if (!isArray(value)) {
      Object.setPrototypeOf(value, null);
    }
    for (const item of Object.values(value)) {
      frozenInPlace(item);
    }
    freeze(value);
  }
  return value;
};

/**
 * A copy of `value`, a run's args as their schema checked them, as data
 * a workflow reads (`frozenData`), of its own type.
 */
export const frozenCopy = <Value>(value: Value): Value =>
  frozenInPlace(structuredClone(value));

/**
 * `value` as data a workflow reads: JSON (`jsonValue`: `undefined` is
 * `null` in a list and left out of an object), every object copied into
 * one with no prototype and every object and list frozen, all the way
 * down. A field named `__proto__` or `constructor` is an own field holding
 * data like any other.
 */
export const frozenData = (value: unknown): Json => {
  const json = jsonValue(value);
  if (json === null || typeof json !== "object") {
    return json;
  }
  if (isArray(json)) {
    return freeze(json.map((item: Json) => frozenData(item)));
  }
  const copy: Record<string, Json> = {};
  Object.setPrototypeOf(copy, null);
  for (const [key, item] of Object.entries(json)) {
    defineProperty(copy, key, {
      value: frozenData(item),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return freeze(copy);
};

/**
 * `value` with no prototype, frozen: an object this module built, of its
 * own fields only, each data already.
 */
export const dataObject = <Value extends object>(value: Value): Value => {
  Object.setPrototypeOf(value, null);
  return freeze(value);
};
