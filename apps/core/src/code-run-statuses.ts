/**
 * Every way a code run can end, as the host records it
 * ({@link CodeRunStatus}). Apart from code-mode.ts, with nothing to
 * import, so the Workspace object's schema can constrain its records to
 * them.
 */
export const codeRunStatuses = [
  "completed",
  "threw",
  "refused",
  "load_failed",
  "cpu_exceeded",
  "crashed",
  "wall_expired",
  "cancelled",
  "revoked",
  "interrupted",
] as const;

/**
 * How a run ended, as the host saw it, never as the code says: it
 * returned (`completed`), threw (`threw`, or sent back what the harness
 * never returns), was refused before it loaded (`refused`: its source is
 * over the limit), its module didn't load or export a function
 * (`load_failed`, including anything the runtime ended while it loaded,
 * short of its CPU time), the runtime stopped it for CPU time
 * (`cpu_exceeded`) or anything else once it ran (`crashed`: memory, say),
 * it ran past its wall-clock time (`wall_expired`, a wait that can never
 * settle too), the turn was cancelled (`cancelled`), a permission of the
 * agent was revoked while it ran (`revoked`: its lease closed then,
 * whatever its code went on to do), or a restart ended it first
 * (`interrupted`, which only its record says). Only the host sets one:
 * the harness returns every outcome of the code, so the code can't make
 * a call reject, nor pick the message a status is read from.
 */
export type CodeRunStatus = (typeof codeRunStatuses)[number];
