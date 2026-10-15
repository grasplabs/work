// The headers core and the on-prem sandbox supervisor speak in
// (scripts/workerd-sandbox.ts imports them as they are): one name each,
// so neither side can drift from the other.

/** A call's or session's deadline, and how long it may wait, in milliseconds. */
export const sandboxDeadlineHeader = "x-grasp-sandbox-deadline-ms";
export const sandboxWaitHeader = "x-grasp-sandbox-wait-ms";

/** A session's CPU-time budget, which the supervisor echoes as it takes it. */
export const sandboxCpuHeader = "x-grasp-sandbox-cpu-ms";

/**
 * The resident memory a session may use, in MiB, where it needs more than
 * the supervisor gives App code: core's own platform code (the screen
 * compiler, the package builder), never an App's. The supervisor holds it
 * to its most.
 */
export const sandboxMemoryHeader = "x-grasp-sandbox-memory-mib";

/** A session's ID, which its verdict is asked by. */
export const sandboxCallIdHeader = "x-grasp-sandbox-call";

/** The session (its call ID) a session is the child of (`SessionCall.parent`). */
export const sandboxParentHeader = "x-grasp-sandbox-parent";

/** Whose session it is, for the per-owner cap. */
export const sandboxOwnerHeader = "x-grasp-sandbox-owner";

/** Marks a call's answer as the supervisor's verdict on the App's code. */
export const sandboxVerdictHeader = "x-grasp-sandbox-verdict";
