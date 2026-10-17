/**
 * What Stephen took from a document dropped in the onboarding. The prototype's
 * document-reading.ts also checks what the model gives back; only the shape of a reading came
 * along. Core keeps the same shape in its store (apps/core/src/onboarding/document-reading.ts).
 */

/** One question to the one who shared a document, with the answers to pick from. */
export interface DocumentQuestion {
  question: string;
  options: string[];
}

/** What Stephen took from a document. */
export interface DocumentReading {
  /** What it is and what work it covers, as he says it: one short sentence. */
  about: string;
  /** The software and systems it names, as written. */
  tools: string[];
  /** The teams it is about. */
  teams: string[];
  /** What it leaves unclear about the work, to check with the people who do it. */
  unclear: string[];
  /** What only the one who shared it can say, when he cannot use it without; none otherwise. */
  ask: DocumentQuestion | null;
}
