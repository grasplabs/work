import { workErrors } from "./contract.ts";
import type { WorkErrorCode } from "./contract.ts";

/**
 * Why an attempt of the work queue failed, as one of its codes
 * (contract.ts `workErrors`): what a handler throws to say why, since the
 * queue keeps no text of its own.
 */
export class WorkError extends Error {
  readonly code: WorkErrorCode;

  constructor(code: WorkErrorCode) {
    super(workErrors[code]);
    this.name = "WorkError";
    this.code = code;
  }
}
