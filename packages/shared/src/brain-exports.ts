import { defineErrorFamily } from "./errors.ts";

/**
 * Why the Brain's exports and restores refused a call (core's
 * src/brain-next.ts and src/brain-next-exports.ts): refusals for the state
 * the Brain is in, which nothing about the request changes, answered as a
 * conflict.
 */
export const brainExportErrors = defineErrorFamily({
  "brain.export_refused":
    "The Brain can't start an export now: it is restoring one. Try again once the restore is done.",
  "brain.restoring":
    "The Brain is restoring an export and adds nothing until it is done: add it again shortly.",
  "brain.restore_refused":
    "The Brain can't restore that export now: it restores a whole export of this deployment's company only into a Brain that holds nothing, one at a time.",
});
