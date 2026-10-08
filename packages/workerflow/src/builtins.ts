// The built-ins' own getters and methods, kept as this module loads, so
// what the engine reads of a value (its kind, its bytes) comes from the
// value's internal slots: an own `buffer`, `byteLength`, `locked` or
// iterator on a value can't change or hide it, and an object that only
// borrows a built-in's prototype isn't taken for one.

/**
 * A built-in getter or method, called with `Reflect.apply` and a `this` of
 * the caller's choosing.
 */
export type Intrinsic = (this: unknown, ...args: never[]) => unknown;

const isIntrinsic = (value: unknown): value is Intrinsic =>
  typeof value === "function";

const missing = (key: PropertyKey): Error =>
  new Error(`The runtime has no built-in ${String(key)}`);

/** The getter `key` of a built-in prototype. */
export const getterOf = (prototype: object, key: PropertyKey): Intrinsic => {
  const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
  const get: unknown =
    descriptor === undefined ? undefined : Reflect.get(descriptor, "get");
  if (!isIntrinsic(get)) {
    throw missing(key);
  }
  return get;
};

/** The method `key` of a built-in prototype. */
export const methodOf = (prototype: object, key: PropertyKey): Intrinsic => {
  const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
  const method: unknown =
    descriptor === undefined ? undefined : Reflect.get(descriptor, "value");
  if (!isIntrinsic(method)) {
    throw missing(key);
  }
  return method;
};

export const notOfKind = Symbol("not of this kind");

/** `intrinsic` called on `value` with `args`. */
export const invoke = (
  intrinsic: Intrinsic,
  value: unknown,
  ...args: unknown[]
): unknown => Reflect.apply(intrinsic, value, args);

/**
 * `intrinsic` called on `value` with `args`, or notOfKind when it throws:
 * the built-in's own check that `value` is its kind.
 */
export const brand = (
  intrinsic: Intrinsic,
  value: unknown,
  ...args: unknown[]
): unknown => {
  try {
    return invoke(intrinsic, value, ...args);
  } catch {
    return notOfKind;
  }
};

const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);
if (typedArrayPrototype === null) {
  throw missing("TypedArray");
}
/** A typed array's class name, from its internal slot; undefined if none. */
export const typedArrayKind = getterOf(typedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = getterOf(typedArrayPrototype, "buffer");
const typedArrayOffset = getterOf(typedArrayPrototype, "byteOffset");
const typedArrayLength = getterOf(typedArrayPrototype, "byteLength");
export const dataViewLength = getterOf(DataView.prototype, "byteLength");
const dataViewBuffer = getterOf(DataView.prototype, "buffer");
const dataViewOffset = getterOf(DataView.prototype, "byteOffset");
/** Throws for anything but an ArrayBuffer (a SharedArrayBuffer too). */
export const arrayBufferLength = getterOf(ArrayBuffer.prototype, "byteLength");

const isTypedArray = (value: object): boolean =>
  typeof brand(typedArrayKind, value) === "string";

const isDataView = (value: object): boolean =>
  brand(dataViewLength, value) !== notOfKind;

export const isArrayBuffer = (value: object): value is ArrayBuffer =>
  brand(arrayBufferLength, value) !== notOfKind;

/** What a view sees: its buffer, where in it, and how much. */
export interface ViewParts {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

const partsOf = (
  value: object,
  buffer: Intrinsic,
  offset: Intrinsic,
  length: Intrinsic
): ViewParts | undefined => {
  const source = invoke(buffer, value);
  const byteOffset = invoke(offset, value);
  const byteLength = invoke(length, value);
  if (
    typeof source !== "object" ||
    source === null ||
    !isArrayBuffer(source) ||
    typeof byteOffset !== "number" ||
    typeof byteLength !== "number"
  ) {
    // A view of a SharedArrayBuffer.
    return undefined;
  }
  return { buffer: source, byteOffset, byteLength };
};

/** A typed array's or DataView's parts, through its internal slots. */
export const viewOf = (value: object): ViewParts | undefined => {
  if (isTypedArray(value)) {
    return partsOf(value, typedArrayBuffer, typedArrayOffset, typedArrayLength);
  }
  if (isDataView(value)) {
    return partsOf(value, dataViewBuffer, dataViewOffset, dataViewLength);
  }
  return undefined;
};

/** Older runtimes have no `detached`: a detached buffer reads as empty. */
const arrayBufferDetached =
  Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached") ===
  undefined
    ? undefined
    : getterOf(ArrayBuffer.prototype, "detached");

/** Whether an ArrayBuffer was transferred away, and holds nothing now. */
export const isDetached = (buffer: ArrayBuffer): boolean =>
  arrayBufferDetached !== undefined &&
  invoke(arrayBufferDetached, buffer) === true;

/**
 * How many bytes `value` holds when it is a typed array, a DataView (with
 * `dataViews`) or an ArrayBuffer, read through the built-in getters before
 * anything is copied; otherwise undefined.
 */
export const byteLengthOf = (
  value: unknown,
  { dataViews }: { dataViews: boolean }
): number | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (isArrayBuffer(value)) {
    const length = invoke(arrayBufferLength, value);
    return typeof length === "number" ? length : undefined;
  }
  if (!dataViews && isDataView(value)) {
    return undefined;
  }
  return viewOf(value)?.byteLength;
};

/**
 * A copy of the bytes `value` holds when it is a typed array, a DataView
 * (with `dataViews`) or an ArrayBuffer; otherwise undefined.
 */
export const copyBytes = (
  value: unknown,
  { dataViews }: { dataViews: boolean }
): Uint8Array<ArrayBuffer> | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (isArrayBuffer(value)) {
    return new Uint8Array(new Uint8Array(value));
  }
  if (!dataViews && isDataView(value)) {
    return undefined;
  }
  const parts = viewOf(value);
  // The typed array constructor copies through internal slots too.
  return parts === undefined
    ? undefined
    : new Uint8Array(
        new Uint8Array(parts.buffer, parts.byteOffset, parts.byteLength)
      );
};
