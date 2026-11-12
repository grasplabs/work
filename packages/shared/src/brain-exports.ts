import { defineErrorFamily } from "./errors.ts";

/**
 * Why the Brain's exports refused a call (core's src/brain-next-exports.ts):
 * a restore the Brain won't start, which nothing about the request can
 * change but the state of the Brain.
 */
export const brainExportErrors = defineErrorFamily({
  "brain.restore_refused":
    "The Brain can't restore that export now: it restores a whole export of this deployment's company only into a Brain that holds nothing, one at a time.",
});
