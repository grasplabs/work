// Errors as the journal keeps them: a name and a message, which survive
// any process. Anything else an error carries does not cross.
import type { WorkflowError } from "./contracts.ts";

/** How much of a message is kept: well inside a SQLite value. */
export const maxErrorMessageBytes = 4096;
const maxErrorNameBytes = 256;

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

/**
 * The record of anything thrown. Total: whatever was thrown (a value with
 * no `toString`, getters that throw, a name that isn't a string, a message
 * of megabytes), this returns a name and a message the journal can keep
 * and read back.
 */
export const errorRecord = (thrown: unknown): WorkflowError => {
  let name: string | undefined;
  let message: string | undefined;
  try {
    if (thrown instanceof Error) {
      name = printable(thrown.name);
      message = printable(thrown.message);
    } else {
      name = "Error";
      message = printable(thrown);
    }
  } catch {
    // A getter that throws: as unprintable as it gets.
  }
  if (name === undefined || message === undefined) {
    return unprintable;
  }
  return {
    name: bounded(name, maxErrorNameBytes) || "Error",
    message: bounded(message, maxErrorMessageBytes),
  };
};

export const parseError = (text: string): WorkflowError => {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "name" in parsed &&
    "message" in parsed &&
    typeof parsed.name === "string" &&
    typeof parsed.message === "string"
  ) {
    return { name: parsed.name, message: parsed.message };
  }
  throw new Error(`The journal holds an error this engine can't read: ${text}`);
};

/** An error with a name of its own, without a class per name. */
export const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
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
  const { name, message } = parseError(text);
  return namedError(name, message);
};
