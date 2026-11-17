import { defineErrorFamily } from "./errors.ts";

// Instruction files: what people write for every chat to start with (the
// company's, their own, an App's, an agent's), kept in the Brain and
// loaded whole (core's instruction-files.ts).

/**
 * Most UTF-16 units (`.length`) of an instruction file's text: about 2000
 * tokens, so the few files a chat starts with leave it room for the
 * conversation.
 */
export const instructionsMaxLength = 8000;

/**
 * Whether `text` is over `instructionsMaxLength` UTF-16 units: the Brain
 * store's own rule for an instruction file's text (its contract's
 * `instructionsTextSchema`).
 */
export const isOverInstructionsLimit = (text: string): boolean =>
  text.length > instructionsMaxLength;

/** Characters an instruction file's text never holds in a prompt as written. */
const markup = /[&<>]/gu;

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/**
 * An instruction file's text as a chat's prompt holds it (core's
 * agent.ts): its markup escaped, so it can neither close the block it
 * stands in nor fake an escape. Never shorter than the text.
 */
export const promptTextOf = (text: string): string =>
  text.replaceAll(markup, (character) => entities[character] ?? character);

/**
 * Whether `text` is too long to save as an instruction file: counted as a
 * chat's prompt holds it (`promptTextOf`), which is how a save measures
 * it (core's `addInstructionFile`), so what reaches a model is bounded by
 * the limit whatever the text holds. The one measure for every place that
 * takes instructions before they are saved, so none is refused only once
 * something else was made for them.
 */
export const instructionsTooLong = (text: string): boolean =>
  isOverInstructionsLimit(promptTextOf(text));

/** Why an instruction file wasn't saved. */
export const instructionFileErrors = defineErrorFamily({
  "instructions.too_large":
    "This instruction file is over its size limit. Shorten it: every chat it applies to starts with it.",
  "instructions.changed":
    "Someone saved this instruction file since you opened it. Open it again to see their version, then make your change.",
});

/**
 * An instruction file, by its scope: one of the company's two (its
 * instructions, and its lasting facts), one person's, one App's or one
 * agent's. Core checks it whole (its brain-next.ts).
 */
export type InstructionFileRef =
  | { scope: "company"; name: "instructions" | "facts" }
  | { scope: "person"; personId: string }
  | { scope: "app"; appId: string }
  | { scope: "agent"; agentId: string };

/** An instruction file as it is now, to edit. */
export interface InstructionFileText {
  version: number;
  text: string;
}

/**
 * Instruction files for a signed-in person to edit (`session.instructions`):
 * only those they may write: their own, the company's and each agent's
 * for an admin, an App's for its builders.
 */
export interface InstructionsApi {
  /** The file as it is now; `null` while it was never written. */
  read: (file: InstructionFileRef) => Promise<InstructionFileText | null>;
  /**
   * Saves `text` as the file's next version, empty to empty it; the one
   * before stays as its history. `change` names this save, minted once before its first try,
   * so a retry saves it once.
   */
  save: (saved: {
    file: InstructionFileRef;
    change: string;
    text: string;
    /** The version it was edited from, 0 for none: refused once another saved since. */
    after: number;
  }) => Promise<{ version: number }>;
}
