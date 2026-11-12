import { z } from "zod";

// What the Brain keeps of what a person says in their own chat (core's
// agent-remember.ts): the chat shows a notice of each memory saved, and
// the person can undo it there, which retires the memory: it stops being
// used, and stays as history.

/**
 * A memory the agent saved in a person's own chat, as the chat shows it:
 * its id, to undo it, and what it says, in the person's own words.
 */
export const chatSavedMemorySchema = z.strictObject({
  memory: z.uuid(),
  /**
   * What kind it is: a fact or a decision, or how Grasp should act for
   * them (a preference or an instruction), which the notice says.
   */
  type: z.enum(["fact", "decision", "preference", "instruction"]),
  statement: z.string().min(1),
  /** The value it holds of its attribute, when it has one. */
  value: z.string().min(1).optional(),
  /** Who or what it is about, by name, when it isn't the person themselves. */
  about: z.string().min(1).optional(),
});
export type ChatSavedMemory = z.infer<typeof chatSavedMemorySchema>;

/**
 * What undoing a saved memory did: `done`, also for one undone before;
 * `nothing` alike for none, another's, or one that ended otherwise.
 */
export type BrainMemoryOutcome = "done" | "nothing";

/** The person's own memories, over `/rpc` as `session.brainMemories`. */
export interface BrainMemoriesApi {
  /** Undoes a memory saved for them in their own word: it stops being current, and stays as history. */
  forget: (memory: string) => Promise<BrainMemoryOutcome>;
}
