import { defineErrorFamily } from "./errors.ts";

// Instruction files: what people write for every chat to start with (the
// company's, their own, an App's, an agent's), kept in the Brain and
// loaded whole (core's instruction-files.ts).

/** Why an instruction file wasn't saved. */
export const instructionFileErrors = defineErrorFamily({
  "instructions.too_large":
    "This instruction file is over its size limit. Shorten it: every chat it applies to starts with it.",
});
