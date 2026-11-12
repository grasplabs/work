import { z } from "zod";

// What the Brain keeps of what a person says in their own chat (core's
// agent-remember.ts): the chat shows a notice of each memory saved, and
// the person can undo it there, which retires the memory: it stops being
// used, and stays as history.

/** Most characters of a memory's statement (the Brain's `statementMaxLength`). */
export const savedStatementMaxLength = 1000;

/**
 * A memory the agent saved in a person's own chat, as the chat shows it:
 * its id, to undo it, and what it says, in the person's own words.
 */
export const chatSavedMemorySchema = z.strictObject({
  memory: z.uuid(),
  statement: z.string().min(1).max(savedStatementMaxLength),
});
export type ChatSavedMemory = z.infer<typeof chatSavedMemorySchema>;

/** What undoing a saved memory did: `nothing` alike for none, another's, or one undone before. */
export type BrainMemoryOutcome = "done" | "nothing";

/** The person's own memories, over `/rpc` as `session.brainMemories`. */
export interface BrainMemoriesApi {
  /** Undoes a memory saved for them in their own word: it stops being current, and stays as history. */
  forget: (memory: string) => Promise<BrainMemoryOutcome>;
}
