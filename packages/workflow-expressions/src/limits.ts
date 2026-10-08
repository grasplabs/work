/**
 * The limits of workflow expressions, in one place: the profile check,
 * the evaluator, the error messages and the workflow validator all read
 * them from here.
 */

/** Limits of one expression's source. */
export const sourceLimits = {
  maxBytes: 4096,
  /** Brackets, braces, parentheses and `if … end` together. */
  maxNesting: 32,
  /** Of a strptime/strftime format, which must be a literal. */
  maxDateFormatBytes: 64,
} as const;

/** The limits on one evaluation. */
export const evaluatorLimits = {
  /**
   * CPU and wall time of one evaluation. Fuel (jq.ts) enforces both
   * deterministically, everywhere; an isolate running the evaluator gives
   * `cpuMs` to the platform as a backstop.
   */
  cpuMs: 100,
  wallMs: 1000,
  /** The input and every variable together, as JSON. */
  maxContextBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  /** Of JSON values, in and out. */
  maxJsonDepth: 32,
  /** Of the task an expression belongs to, counting from the workflow. */
  maxTaskScopes: 16,
} as const;

const bytesPerMebibyte = 1024 * 1024;

/** A byte limit as text: `1 MiB`, or `4096 bytes` below a mebibyte. */
export const sizeText = (bytes: number): string =>
  bytes >= bytesPerMebibyte && bytes % bytesPerMebibyte === 0
    ? `${bytes / bytesPerMebibyte} MiB`
    : `${bytes} bytes`;
