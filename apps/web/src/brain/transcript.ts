import type {
  Source,
  Statement,
  Transcript,
  TranscriptTurn,
} from "@grasp-os/shared/brain";

/**
 * Statements as highlights in the conversation they came from. A statement is not stored against a
 * line: its text appears word for word in one turn of its source's transcript, and it is found
 * there, so a transcript and its statements cannot drift apart.
 */

/** A statement where it was said: the turn, and where in that turn's text. */
export interface Highlight {
  statement: Statement;
  /** The index of the turn in the transcript. */
  turn: number;
  start: number;
  end: number;
}

/** How a place in a transcript is written: a minute as it is, a passage as "§ 3". */
export const placeLabel = (
  transcript: Pick<Transcript, "unit">,
  at: string
): string => (transcript.unit === "passage" ? `§ ${at}` : at);

/**
 * Where each of a source's statements was said, in the order of the conversation. The match ignores
 * case, since a statement may start mid-sentence. A statement that cannot be found is left out.
 */
export const highlightsOf = (
  source: Pick<Source, "id" | "transcript">,
  statements: Statement[]
): Highlight[] => {
  const turns = source.transcript?.turns ?? [];
  return statements
    .filter((statement) => statement.sourceId === source.id)
    .flatMap((statement) => {
      const needle = statement.text.toLowerCase();
      const turn = turns.findIndex((candidate) =>
        candidate.text.toLowerCase().includes(needle)
      );
      const said = turns[turn];
      if (!said) {
        return [];
      }
      const start = said.text.toLowerCase().indexOf(needle);
      return [{ statement, turn, start, end: start + statement.text.length }];
    })
    .toSorted((a, b) => a.turn - b.turn || a.start - b.start);
};

/** Where a statement was said, for a link to it: its source and, in a transcript, the minute and the turns around it. */
export interface Place {
  source: Source;
  /** Where in the transcript, as it is written: "19:38", "#37" or "§ 3". */
  at?: string;
  /** The turn before, the turn itself and the turn after, where the transcript has them. */
  context: TranscriptTurn[];
  /** The index of the statement's own turn in `context`. */
  own: number;
}

export const placeOf = (
  statement: Statement,
  sources: Source[]
): Place | undefined => {
  const source = sources.find(
    (candidate) => candidate.id === statement.sourceId
  );
  if (!source) {
    return undefined;
  }
  const [highlight] = highlightsOf(source, [statement]);
  const turns = source.transcript?.turns ?? [];
  const said = highlight ? turns[highlight.turn] : undefined;
  if (!highlight || !said) {
    return { source, context: [], own: 0 };
  }
  const from = Math.max(0, highlight.turn - 1);
  return {
    source,
    at: placeLabel(source.transcript ?? {}, said.at),
    context: turns.slice(from, highlight.turn + 2),
    own: highlight.turn - from,
  };
};
