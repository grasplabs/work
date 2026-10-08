// Errors as the journal keeps them: a name, a message and, when it has a
// safe one, a code, which survive any process. Anything else an error
// carries (its stack, its cause, its other fields) does not cross: a host
// error code that isn't in the safe shape is dropped, never copied.
import type { WorkflowError } from "./contracts.ts";

/** How much of a message is kept: well inside a SQLite value. */
export const maxErrorMessageBytes = 4096;
const maxErrorNameBytes = 256;

/** The longest code kept. */
const maxErrorCodeLength = 128;

/**
 * The shape of a code an error may carry across: dotted lowercase words,
 * as Grasp's own codes are (`workflow.invalid_input`). It is data the host
 * branches on, so nothing of another shape (a host's internal code, a
 * message in disguise) is kept.
 */
const safeCodePattern = /^[a-z][a-z\d_]*(?:\.[a-z\d_]+)+$/u;

/** What is kept of a thrown value that can't even be turned into text. */
export const unprintable: WorkflowError = {
  name: "Error",
  message: "unprintable thrown value",
};

/** `value` as text, or undefined when it can't be (a null-prototype object). */
const printable = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return String(value);
  } catch {
    return undefined;
  }
};

/** Cuts `text` to `maxBytes` of UTF-8, whole characters only. */
const bounded = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  // `fatal: false` turns a character cut in half into U+FFFD; drop it.
  const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes));
  return cut.endsWith("�") ? cut.slice(0, -1) : cut;
};

/** `value` when it is a code in the safe shape; otherwise undefined. */
export const safeCode = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length <= maxErrorCodeLength &&
  safeCodePattern.test(value)
    ? value
    : undefined;

/**
 * The error's own `code`, when it is a plain data property in the safe
 * shape. A getter is never called and an inherited code never read: what
 * is kept is what the error itself holds.
 */
const ownCode = (error: object): string | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor
      ? safeCode(descriptor.value)
      : undefined;
  } catch {
    // A proxy whose trap throws: it has no code we can keep.
    return undefined;
  }
};

/** `{ name, message }` with `code` only when there is one. */
const withCode = (
  name: string,
  message: string,
  code: string | undefined
): WorkflowError =>
  code === undefined ? { name, message } : { name, message, code };

/**
 * An error's name, message and safe code, read once each, unbounded; or
 * undefined when they can't be read (a getter that throws, a name that
 * can't be printed). The codec keeps an error value with these; a thrown
 * error is kept bounded (errorRecord).
 */
export const errorParts = (error: object): WorkflowError | undefined => {
  let name: string | undefined;
  let message: string | undefined;
  try {
    name = printable(Reflect.get(error, "name"));
    message = printable(Reflect.get(error, "message"));
  } catch {
    return undefined;
  }
  if (name === undefined || message === undefined) {
    return undefined;
  }
  return withCode(name, message, ownCode(error));
};

/**
 * The record of anything thrown. Total: whatever was thrown (a value with
 * no `toString`, getters that throw, a name that isn't a string, a message
 * of megabytes), this returns a name and a message the journal can keep
 * and read back, and the error's code when it has a safe one.
 */
export const errorRecord = (thrown: unknown): WorkflowError => {
  let parts: WorkflowError | undefined;
  if (thrown instanceof Error) {
    parts = errorParts(thrown);
  } else {
    const message = printable(thrown);
    parts = message === undefined ? undefined : { name: "Error", message };
  }
  if (parts === undefined) {
    return unprintable;
  }
  return withCode(
    bounded(parts.name, maxErrorNameBytes) || "Error",
    bounded(parts.message, maxErrorMessageBytes),
    parts.code
  );
};

const unreadable = (text: string): Error =>
  new Error(`The journal holds an error this engine can't read: ${text}`);

export const parseError = (text: string): WorkflowError => {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    !("message" in parsed) ||
    typeof parsed.name !== "string" ||
    typeof parsed.message !== "string"
  ) {
    throw unreadable(text);
  }
  if (!("code" in parsed)) {
    return { name: parsed.name, message: parsed.message };
  }
  const code = safeCode(parsed.code);
  if (code === undefined) {
    throw unreadable(text);
  }
  return { name: parsed.name, message: parsed.message, code };
};

/**
 * An error with a name of its own, without a class per name, and the code
 * it came with as an own property, as Grasp's errors carry theirs.
 */
export const namedError = (
  name: string,
  message: string,
  code?: string
): Error => {
  const error = new Error(message);
  // Not enumerable, as a name an error inherits isn't either.
  Object.defineProperty(error, "name", {
    value: name,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  if (code !== undefined) {
    Object.defineProperty(error, "code", {
      value: code,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return error;
};

/**
 * Thrown from a step's callback, fails the step at once: no retry, however
 * many its config allows. As Cloudflare's own (`cloudflare:workflows`),
 * and recognised as Cloudflare recognises it, by its name or a message
 * that starts with it: an error crosses an RPC boundary as a name and a
 * message, never as its class.
 */
export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") {
    super(message);
    // oxlint-disable-next-line unicorn/custom-error-definition -- Cloudflare's constructor takes the name too
    this.name = name;
  }
}

/** Whether a step's error, as journaled, ends its retries. */
export const isNonRetryable = (record: WorkflowError): boolean =>
  record.name === "NonRetryableError" ||
  record.message.startsWith("NonRetryableError");

/** The error a journaled failure is thrown as, on first run and on replay. */
export const rebuild = (text: string): Error => {
  const { name, message, code } = parseError(text);
  return namedError(name, message, code);
};
