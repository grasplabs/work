// PacedText: words that are still arriving, as plain text. The fade is not drawn here: the box the
// words are written into fades whatever text is added to it (use-arriving.ts; a Chat message does
// it for its words), so nothing is ever wrapped round a word.
//
//   const paced = usePaced(answerSoFar, streaming);
//   <PacedText paced={paced} />
//
// An answer that holds marks between its words (a citation after a sentence) is drawn a part at a
// time, each part by where it starts and ends in the whole text, with the mark after it once the
// part is out:
//
//   <PacedText paced={paced} from={0} to={54} />
//   {paced.settled >= 54 && <Citation n={1} />}
//   <PacedText paced={paced} from={54} to={120} />
//
// Call usePaced in a part that stands inside the Chat message, so the message hears that words are
// still arriving, fades them in, and holds its actions until the last is out.
"use client";

import type { Paced } from "./use-paced";

/** Every prop a PacedText takes. */
export interface PacedTextProps {
  /** What `usePaced` gave back. */
  paced: Paced;
  /**
   * Where this part starts in the whole text, as an offset into it.
   * @default 0
   */
  from?: number;
  /**
   * Where this part ends in the whole text. Without it, the part runs to the end.
   */
  to?: number;
}

export const PacedText = ({ paced, from = 0, to }: PacedTextProps) => {
  const end = Math.min(to ?? paced.text.length, paced.text.length);
  return end <= from ? null : paced.text.slice(from, end);
};
