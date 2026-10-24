import { answerWaitMaxMs } from "@grasp-os/shared/interview-turn";

// How fast Stephen answers (prototype `lib/interview-telemetry.ts`): from
// the end of what someone said to the first sound of his answer, and what
// happens in between. Pure: loop.ts tells it what happens, with when on
// the page's clock, and sends each answer's wait with the next turn
// (`waited`), which core keeps by day for staff (GRA-378's numbers).

/** One answer of his, measured, in ms from the end of what they said; none where it wasn't known. */
export interface Measured {
  by: "talk" | "type";
  /** Until their words were there as text. */
  words: number | null;
  /** Until his line was known. */
  line: number | null;
  /** Until his voice was heard. Without sound, never. */
  voice: number | null;
  /** How often something was asked for again on the way. */
  again: number;
}

interface Open extends Measured {
  from: number;
}

const blank = (by: Measured["by"], from: number): Open => ({
  by,
  from,
  words: null,
  line: null,
  voice: null,
  again: 0,
});

const since = (open: Open, at: number): number =>
  Math.max(0, Math.round(at - open.from));

const closed = ({ by, words, line, voice, again }: Open): Measured => ({
  by,
  words,
  line,
  voice,
  again,
});

/**
 * Measures answers as an interview goes; `done` gets each once it is
 * measured: at his first sound, or as far as it went when it ends without
 * one (they talked on after his line was known, or the sound is off).
 */
export const answerMeter = (done: (answer: Measured) => void) => {
  let open: Open | null = null;
  const finish = (): void => {
    if (open === null || open.line === null) {
      return;
    }
    const answer = closed(open);
    open = null;
    done(answer);
  };
  return {
    /** By voice, they fell quiet at `at`. When they talk on, it counts from where they stop again. */
    quiet(at: number): void {
      const again = open?.again ?? 0;
      finish();
      open = { ...blank("talk", at), again };
    },
    /** They sent what they typed. */
    sent(at: number): void {
      finish();
      open = blank("type", at);
    },
    /** Their words are there as text. */
    words(at: number): void {
      if (open !== null) {
        open.words = since(open, at);
      }
    },
    /** Something was asked for again. */
    again(): void {
      if (open !== null) {
        open.again += 1;
      }
    },
    /** His line is known. */
    line(at: number): void {
      if (open !== null && open.line === null) {
        open.line = since(open, at);
      }
    },
    /** His voice is heard: the answer is measured. */
    voice(at: number): void {
      if (open === null || open.voice !== null) {
        return;
      }
      open.voice = since(open, at);
      open.line ??= open.voice;
      finish();
    },
    /** The interview stops: an answer whose line was known counts as far as it went. */
    stop(): void {
      finish();
      open = null;
    },
  };
};

/** What a list of numbers comes to a share of the way through it, smallest first: 0.5 is the middle one. */
export const atShare = (values: number[], share: number): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(share * sorted.length) - 1)
  );
  return sorted[at] ?? null;
};

/** What core is told of an answer: its wait for his voice, the longest as the longest core takes; none without a sound. */
export const waitedOf = (answer: Measured): number | undefined =>
  answer.voice === null
    ? undefined
    : Math.min(answerWaitMaxMs, Math.max(0, answer.voice));
