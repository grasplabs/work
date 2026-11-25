/**
 * What the Voice Lab makes of a session's events (src/admin/
 * voice-lab-call.ts): the conversation as it is written down, and how
 * long each of the interviewer's answers took to begin. Pure, so it is
 * tested without a session.
 */

/** A stretch of the conversation as Mistral writes it down: its words so far, all of them. */
export interface Segment {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Its words are settled: no more of it comes. */
  final: boolean;
}

/**
 * The conversation with `segment` in it: in place of the one it has the
 * ID of, as a stretch's later words take the place of its earlier ones,
 * or after the last.
 */
export const withSegment = (
  said: readonly Segment[],
  segment: Segment
): Segment[] =>
  said.some(({ id }) => id === segment.id)
    ? said.map((each) => (each.id === segment.id ? segment : each))
    : [...said, segment];

/** What is timed: their words settled, or the interviewer beginning to speak. */
export interface Moment {
  /** On the page's clock, in ms. */
  at: number;
  what: "said" | "speaks";
}

/**
 * How long each answer took to begin, in whole ms, oldest first: from
 * their last words settling to his voice starting. That is the wait
 * someone hears after Mistral decided they were done; the silence it
 * waited before deciding comes on top, and the page can't see it. A line
 * of his with no words of theirs before it (his first, or one after he
 * was cut off before they said anything) is no answer and isn't timed.
 */
export const replyTimes = (moments: readonly Moment[]): number[] => {
  const times: number[] = [];
  let said: number | null = null;
  for (const { at, what } of moments) {
    if (what === "said") {
      said = at;
    } else if (said !== null) {
      times.push(Math.max(0, Math.round(at - said)));
      said = null;
    }
  }
  return times;
};

/** The middle of `times`, in ms; null when there are none. */
export const medianOf = (times: readonly number[]): number | null => {
  if (times.length === 0) {
    return null;
  }
  const sorted = times.toSorted((one, other) => one - other);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1
    ? upper
    : Math.round(((sorted[middle - 1] ?? upper) + upper) / 2);
};
