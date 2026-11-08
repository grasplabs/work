// What both sandboxed runners share: the migration runner (runner.ts) and
// a workflow's compute runner (compute-runner.ts, compute-lockdown.ts).
// Each loads this module before any App or workflow module, so the
// intrinsics below are the platform's, whatever module code replaces
// later.

const RefusalError = Error;
const { get: reflectGet } = Reflect;

/**
 * Makes the functions that refuse what sandboxed code can't use: each one
 * made for `what` throws `messageOf(what)`.
 */
export const refusals =
  (messageOf: (what: string) => string) => (what: string) => (): never => {
    throw new RefusalError(messageOf(what));
  };

/** Whether `value` looks like a promise: anything with a `then` function. */
export const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof reflectGet(value, "then") === "function";
