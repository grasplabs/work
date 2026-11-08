import { isPlainObject } from "./value-descriptor.ts";

// What the SDK's constructors and manifest readers share as they check
// what they are given: refusing it with their own error, reading it,
// bounding it and freezing what they keep.

/**
 * The intrinsic `dataReader` calls, taken as this module loads, before any of
 * a workflow's modules (the action and compute modules import it).
 */
const { getOwnPropertyDescriptor } = Object;

/**
 * A function that throws `Refusal` made from its arguments: a module's
 * `refuse`, typed where it is declared so a call narrows what follows it.
 */
export const refuser =
  <Args extends unknown[]>(Refusal: new (...args: Args) => Error) =>
  (...args: Args): never => {
    throw new Refusal(...args);
  };

/** `value` with every object and array in it frozen; data only. */
export const deepFreeze = <Value>(value: Value): Value => {
  // Into frozen objects too: a frozen object can hold one that isn't.
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value;
};

/**
 * A reader of a declaration's keys as data properties, never getters:
 * `refuse` names what declared it as `what` (`A calculation`).
 */
export const dataReader =
  (what: string, refuse: (message: string) => never) =>
  (declaration: object, key: string): unknown => {
    const property = getOwnPropertyDescriptor(declaration, key);
    if (property !== undefined && !("value" in property)) {
      return refuse(`${what}'s \`${key}\` is a value, not a getter.`);
    }
    return property?.value;
  };

const encoder = new TextEncoder();

/**
 * Whether `text` is more than `max` bytes as UTF-8. A code unit is at most
 * three bytes, so only text that could be over is encoded; text longer
 * than `max` code units is over whatever it holds.
 */
export const isOverBytes = (text: string, max: number): boolean =>
  text.length > max ||
  (text.length * 3 > max && encoder.encode(text).byteLength > max);

/** Whether `value` is a plain object with exactly the keys `keys`. */
export const hasExactly = (
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** A name a declaration gives: a table's, or a resource's alias. */
export const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
