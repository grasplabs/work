// interviewSource: one moment of an interview as a source for Sources, so a Citation in a Chat
// message's answer cites the moment and not only the note: a source of kind "meeting" whose card
// shows the interview's people, the lines around the moment with the quoted one marked, and the
// time as its place. Its marker's words are the moment alone ("0:50", or "passage 4" with no
// times): the interview's title is the source's title, in its card and the list.
//
//   const sources = [interviewSource(monthEnd, { turn: 14 })];
//   <Sources items={sources}>… <Citation n={1} /> …</Sources>
//
// A pure function: it reads the interview and returns the source, nothing else.
import type { Source } from "../sources";
import { wordsOf } from "./labels";
import { lengthOf, peopleOf, timed } from "./read";
import type { InterviewRecord, InterviewWords } from "./types";

/** The moment cited: a turn, and the words of it quoted when not the whole turn. */
export interface InterviewSourceMoment {
  /** The turn, by its place in the interview's turns. */
  turn: number;
  /** The words quoted; the whole turn stands in without them. */
  quote?: string;
}

/** How a moment becomes a source. */
export interface InterviewSourceOptions {
  /**
   * How many turns before and after the moment its card shows.
   * @default 1
   */
  around?: number;
  /** The words it writes: times, lengths and where it lives. */
  words?: Partial<InterviewWords>;
}

/** One moment of an interview as a source of kind "meeting". */
export const interviewSource = (
  interview: InterviewRecord,
  moment: InterviewSourceMoment,
  options: InterviewSourceOptions = {}
): Source => {
  const words = wordsOf(options.words);
  const around = options.around ?? 1;
  const { turns } = interview;
  const people = peopleOf(interview.speakers, turns);
  const withTimes = timed(turns);
  const at = (index: number) =>
    withTimes
      ? words.clock(turns[index]?.startMs ?? 0)
      : words.passage(index + 1);
  const said = turns[moment.turn];
  // The moment as a marker and a card name it: its time, or its passage.
  const named = withTimes
    ? words.clock(said?.startMs ?? 0)
    : words.atPassage(moment.turn + 1);
  const first = Math.max(0, moment.turn - around);
  const last = Math.min(turns.length - 1, moment.turn + around);
  const ms =
    interview.durationMs ?? (turns.length > 0 ? lengthOf(turns) : undefined);
  const transcript = turns.slice(first, last + 1).map((turn, offset) => ({
    time: at(first + offset),
    who: people.get(turn.speaker)?.name ?? turn.speaker,
    line:
      first + offset === moment.turn && moment.quote !== undefined
        ? moment.quote
        : turn.text,
    quoted: first + offset === moment.turn,
  }));
  return {
    kind: "meeting",
    title: interview.title,
    origin:
      interview.origin ??
      words.origin(
        interview.how,
        ms === undefined || ms <= 0 ? undefined : words.length(ms)
      ),
    when: interview.when,
    href: interview.href,
    quote: moment.quote ?? said?.text,
    // Under the card's lines, where the moment is: the interview and the time, never the time alone.
    place: said === undefined ? undefined : words.cite(interview.title, named),
    people: [...people.values()].map((person) => ({
      name: person.name,
      src: person.src,
    })),
    transcript,
  };
};
