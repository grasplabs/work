import type { SpokenWord } from "@grasp-os/shared/voice";

// When each character of a line is said (prototype `lib/speech.ts`), so
// its words can light up as Stephen says them: from the voice's own word
// timings when it said the line, else at the pace of speech. Pure.

/** When each character of a line is said, in seconds from its start: one entry per character. */
export interface Timing {
  starts: number[];
  ends: number[];
}

/** Seconds a character takes at the pace of speech: a breath after a comma, a longer one after a full stop. */
const fullStop = /[.?!…]/u;
const pause = /[,;:]/u;
const paceOf = (char: string): number => {
  if (fullStop.test(char)) {
    return 0.34;
  }
  return pause.test(char) ? 0.18 : 0.058;
};

/** A line's timing without a voice, so its words still light up at the pace of speech. */
export const readingTiming = (line: string): Timing => {
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  // By UTF-16 unit, as the text is indexed where its words are drawn.
  for (let index = 0; index < line.length; index += 1) {
    starts.push(at);
    at += paceOf(line.charAt(index));
    ends.push(at);
  }
  return { starts, ends };
};

/** How long a line takes to say, in seconds. */
export const lengthOf = (timing: Timing): number => timing.ends.at(-1) ?? 0;

/** How many characters of the line have begun to be said `seconds` into it. */
export const saidBy = (timing: Timing, seconds: number): number => {
  let low = 0;
  let high = timing.starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((timing.starts[middle] ?? Infinity) <= seconds) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

/** One word of a text, and where it starts and ends in it, without the space after it. */
export interface WordAt {
  word: string;
  start: number;
  end: number;
}

const wordPattern = /\S+\s*/gu;

/** The words of a text, each with the space after it, as they are drawn. */
export const wordsOf = (text: string): WordAt[] =>
  [...text.matchAll(wordPattern)].map((match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].trimEnd().length,
  }));

const endsSentence = /[.?!:…]$/u;

/**
 * A step's title and sentence as one line, the way Stephen says them: a
 * full stop after a title that has none. `from` is where the sentence
 * starts in it.
 */
export const narrationOf = (
  title: string,
  sentence: string
): { line: string; from: number } => {
  const text = sentence.trim();
  const head = title.trim();
  if (text === "") {
    return { line: head, from: head.length };
  }
  const joined = endsSentence.test(head) ? `${head} ` : `${head}. `;
  return { line: `${joined}${text}`, from: joined.length };
};

/**
 * The voice's word timings laid over the line as written: each word's
 * characters spread over the time it is said, and the space after it
 * passed as the next one starts. Where the voice counted the words
 * otherwise, the pace of speech is stretched over how long it spoke.
 */
export const timingOf = (
  line: string,
  words: readonly SpokenWord[]
): Timing => {
  const written = wordsOf(line);
  if (written.length !== words.length) {
    const reading = readingTiming(line);
    const scale =
      (words.at(-1)?.endMs ?? 0) / 1000 / Math.max(lengthOf(reading), 0.001);
    return {
      starts: reading.starts.map((at) => at * scale),
      ends: reading.ends.map((at) => at * scale),
    };
  }
  // Any space before the first word is passed at once.
  const lead = written[0]?.start ?? line.length;
  const starts: number[] = Array.from({ length: lead }, () => 0);
  const ends: number[] = Array.from({ length: lead }, () => 0);
  for (const [index, { start, end }] of written.entries()) {
    const said = words[index];
    const from = (said?.startMs ?? 0) / 1000;
    const to = Math.max((said?.endMs ?? 0) / 1000, from);
    const next = written[index + 1]?.start ?? line.length;
    const step = (to - from) / Math.max(end - start, 1);
    for (let char = start; char < end; char += 1) {
      starts.push(from + (char - start) * step);
      ends.push(from + (char - start + 1) * step);
    }
    // The space after a word is passed as soon as the word ends.
    for (let char = end; char < next; char += 1) {
      starts.push(to);
      ends.push(to);
    }
  }
  return { starts, ends };
};
