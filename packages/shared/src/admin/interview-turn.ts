import type { Tag, VoiceTag } from "./interviews.ts";

/**
 * What an interview with Stephen holds, as the admin reads it: what was said, and what he wrote
 * down. The prototype's interview-turn.ts also checks each turn the model gives back; only the
 * shapes of what a turn leaves behind came along.
 */

/** What Stephen marked in something the person said: the exact words, and what they are. */
export interface Mark {
  quote: string;
  tag: Tag;
}

/** One thing said in an interview. */
export interface InterviewLine {
  from: "stephen" | "person";
  text: string;
  /** A person's line that was typed, not heard: spelled as they mean it. */
  typed?: boolean;
  /** In a person's line: what Stephen marked in it. */
  marks?: Mark[];
  /** A file they shared with this line, by its name. */
  file?: string;
  /** How Stephen said his line. */
  tone?: VoiceTag;
}

/** One thing Stephen wrote down. */
export interface InterviewFact {
  id: string;
  tag: Tag;
  /** As he reads it back to them, in their language: one thing a sentence. */
  text: string;
  /** The same as the record keeps it, in English: an instruction for a step, a plain statement otherwise. */
  record: string;
  /** Taken out by the person in the read-back. */
  out?: boolean;
  /** Said by the person in the read-back, where it was missing: kept in the part it was added to. */
  pin?: number;
  /** Read back and agreed to before: when the person comes back to add something, it is not read back again. */
  agreed?: boolean;
}
