// Errors as the journal keeps them: a name and a message, which survive
// any process. Anything else an error carries does not cross.
import type { WorkflowError } from "./contracts.ts";

export const errorRecord = (thrown: unknown): WorkflowError =>
  thrown instanceof Error
    ? { name: thrown.name, message: thrown.message }
    : { name: "Error", message: String(thrown) };

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

/** The error a journaled failure is thrown as, on first run and on replay. */
export const rebuild = (text: string): Error => {
  const { name, message } = parseError(text);
  return namedError(name, message);
};
