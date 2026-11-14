/**
 * Which answer the erasure lookup shows (brain-erasure-lookup.tsx): only
 * the answer to the lookup staff submitted last, and only while what they
 * typed is still that lookup. An answer that arrives after they changed
 * the kind or the key or id, or after they submitted another lookup, is
 * never shown as the answer to what is typed now.
 */

/** An answer, with the lookup it answers. */
export interface LookupAnswer {
  kind: "source" | "person";
  /** The key or id as submitted, trimmed. */
  name: string;
  /** Which submission it answers: each one counts up from 1. */
  asked: number;
  text: string;
  wrong: boolean;
}

/** The answer to show for `kind` and `typed` now, or none. */
export const answerShown = (
  answer: LookupAnswer | null,
  kind: LookupAnswer["kind"],
  typed: string,
  lastAsked: number
): LookupAnswer | null =>
  answer !== null &&
  answer.asked === lastAsked &&
  answer.kind === kind &&
  answer.name === typed.trim()
    ? answer
    : null;

/**
 * The answer to keep once `arrived` comes in: it, unless what is kept
 * already answers a later submission, so a slow answer never replaces a
 * newer one.
 */
export const answerKept = (
  kept: LookupAnswer | null,
  arrived: LookupAnswer
): LookupAnswer =>
  kept !== null && kept.asked > arrived.asked ? kept : arrived;
