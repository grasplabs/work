import { passedBound } from "@grasp-os/shared/value-bounds";
import type { ValueBounds } from "@grasp-os/shared/value-bounds";

// What crosses into and out of App code as structured clone carries it:
// plain data only, within bounds, and never a big integer, which screens
// and workflows (whose values are JSON's) can't hold.

/**
 * What an App method answers: plain data, as structured clone carries it.
 * Never a stub, a function or an RpcTarget: an answer goes on to screens
 * and workflows, and must not hand them a way into the App.
 */
export type AppAnswer = Rpc.Serializable<unknown>;

/**
 * How deep and how big plain data may be by default: as deep as Cap'n
 * Web reads a message by default, the deepest any reader of ours takes
 * (a browser's connection, a screen's frame), and as big as the longest
 * message workerd's RPC or Cap'n Web carries. A bound on the walk and the
 * clone after it, not on what an App may answer, which its readers bound.
 */
export const plainDataBounds: ValueBounds = {
  depth: 256,
  size: 32 * 1024 * 1024,
};

/**
 * Whether a value is plain data, as structured clone carries it, within
 * `bounds`. They are checked first, without recursion, so the clone never
 * walks a value deeper or bigger than they are.
 */
export const isPlainData = (
  value: unknown,
  bounds: ValueBounds = plainDataBounds
): boolean => {
  if (passedBound([value], bounds) !== undefined) {
    return false;
  }
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

/** Whether `value` is a boxed big integer (`Object(7n)`), whatever its prototype. */
const isBoxedBigInt = (value: object): boolean => {
  try {
    // Reads the internal slot only a boxed big integer has.
    BigInt.prototype.valueOf.call(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * A getter of every typed array's, which reads its internal slots: what
 * kind it is, and how long. Its own properties can't stand in for them.
 */
const typedArrayGetter = (name: PropertyKey): ((value: object) => unknown) => {
  const typedArray = Reflect.getPrototypeOf(Int8Array.prototype);
  const getter =
    typedArray === null
      ? undefined
      : Reflect.getOwnPropertyDescriptor(typedArray, name)?.get;
  if (getter === undefined) {
    throw new Error(`Typed arrays have no getter ${String(name)}`);
  }
  return (value) => {
    const read: unknown = Reflect.apply(getter, value, []);
    return read;
  };
};

const typedArrayKind = typedArrayGetter(Symbol.toStringTag);
const typedArrayLength = typedArrayGetter("length");

/** Whether `value` is a typed array of big integers with any in it. */
const isBigIntArray = (value: object): boolean => {
  // The kind is `undefined` for anything but a typed array, so the length
  // is only read of one.
  const kind = typedArrayKind(value);
  return (
    (kind === "BigInt64Array" || kind === "BigUint64Array") &&
    typedArrayLength(value) !== 0
  );
};

/** Whether `value` is a typed array or a view of a buffer: numbers only. */
const isNumbers = (value: object): boolean => ArrayBuffer.isView(value);

/**
 * A map's keys and values, or a set's members, read through the internal
 * slot so a changed prototype can't hide them; `undefined` for neither.
 */
const collected = (value: object): unknown[] | undefined => {
  const held: unknown[] = [];
  try {
    Map.prototype.forEach.call(value, (inner: unknown, key: unknown) => {
      held.push(key, inner);
    });
    return held;
  } catch {
    // Not a map.
  }
  try {
    Set.prototype.forEach.call(value, (inner: unknown) => {
      held.push(inner);
    });
    return held;
  } catch {
    return undefined;
  }
};

/** What `heldBy` gives for a getter: what it yields isn't known unrun. */
const unknownYield = Symbol("unknown yield");

/**
 * The values an object holds: a map's keys and values, a set's members,
 * or every own property's, named by a string or a symbol, enumerable or
 * not, as `unknownYield` for a getter.
 */
const heldBy = (value: object): unknown[] => {
  const members = collected(value);
  if (members !== undefined) {
    return members;
  }
  const held: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property !== undefined) {
      held.push("value" in property ? property.value : unknownYield);
    }
  }
  return held;
};

/**
 * Whether `value` holds a big integer anywhere within it: a big integer, a
 * boxed one or a typed array of them, at any depth, in a map, a set or an
 * error's cause. No value of an App's calls or answers may: they reach
 * screens and workflows, whose values are JSON's.
 *
 * What's walked is what structured clone carries of `value`, as RPC does:
 * a getter read once into plain data, no proxy, and none of the keys it
 * drops. Only a value it can't carry (an argument holding a stub) is
 * walked as it is, where a getter counts as holding one. The walk runs no
 * code of the value's and has no recursion, so a value nested deep can't
 * exhaust the stack; it looks at each object once, and a function (a
 * stub) holds nothing.
 */
export const holdsBigInt = (value: unknown): boolean => {
  let carried: unknown = value;
  try {
    carried = structuredClone(value);
  } catch {
    // Walked as it is (see above).
  }
  const pending: unknown[] = [carried];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "bigint" || next === unknownYield) {
      return true;
    }
    if (typeof next !== "object" || next === null || seen.has(next)) {
      continue;
    }
    seen.add(next);
    if (isBoxedBigInt(next) || isBigIntArray(next)) {
      return true;
    }
    if (isNumbers(next)) {
      continue;
    }
    // One at a time, not spread: a long array would pass too many
    // arguments at once.
    for (const inner of heldBy(next)) {
      pending.push(inner);
    }
  }
  return false;
};
