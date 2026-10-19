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

/** Whether Grasp asked this turn: a consultant, the voice agent, the chat link or the agent all speak as "Grasp …". */
export const isGrasp = (speaker: string): boolean =>
  speaker === "Grasp" || speaker.startsWith("Grasp ");

/** The people in a transcript besides Grasp, in the order they first speak, so each keeps one colour. */
export const voices = (turns: Pick<TranscriptTurn, "speaker">[]): string[] => [
  ...new Set(
    turns.map((turn) => turn.speaker).filter((speaker) => !isGrasp(speaker))
  ),
];

/** How a place in a transcript is written: a minute as it is, a passage as "§ 3". */
export const placeLabel = (
  transcript: Pick<Transcript, "unit">,
  at: string
): string => (transcript.unit === "passage" ? `§ ${at}` : at);

/** A place in a transcript as a number to compare: "12:26" in seconds, an answer or passage number as it is. */
export const position = (at: string): number => {
  const [whole = 0, rest] = at.split(":").map(Number);
  return rest === undefined ? whole : whole * 60 + rest;
};

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

/** The chapter each turn falls in: a chapter holds the turns from its minute until the next one starts. */
export const chapterOfTurns = (transcript: Transcript): number[] => {
  const starts = transcript.chapters.map((chapter) => position(chapter.at));
  return transcript.turns.map((turn) => {
    const at = position(turn.at);
    let chapter = 0;
    for (const [index, start] of starts.entries()) {
      if (at >= start) {
        chapter = index;
      }
    }
    return chapter;
  });
};

/** Every place a search finds in the transcript, in order: the turn and where in its text. */
export const searchHits = (
  turns: TranscriptTurn[],
  query: string
): { turn: number; start: number }[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) {
    return [];
  }
  return turns.flatMap((turn, index) => {
    const text = turn.text.toLowerCase();
    const hits: { turn: number; start: number }[] = [];
    for (
      let start = text.indexOf(needle);
      start >= 0;
      start = text.indexOf(needle, start + needle.length)
    ) {
      hits.push({ turn: index, start });
    }
    return hits;
  });
};

/** A run of a turn's text: plain, part of a highlight, a place the search found, or both. */
export interface TurnPart {
  text: string;
  statement?: Statement;
  /** The index of the search hit this run belongs to, when the search found it. */
  hit?: number;
}

/**
 * A turn's text split at its highlights and at the search hits in it, so each run can be drawn
 * once. `hits` are the transcript's hits with their running index, of which only this turn's count.
 */
export const turnParts = (
  text: string,
  highlights: Highlight[],
  hits: { start: number; index: number }[],
  length: number
): TurnPart[] => {
  const cuts = new Set([0, text.length]);
  for (const highlight of highlights) {
    cuts.add(highlight.start);
    cuts.add(highlight.end);
  }
  for (const hit of hits) {
    cuts.add(hit.start);
    cuts.add(Math.min(text.length, hit.start + length));
  }
  const points = [...cuts].toSorted((a, b) => a - b);
  return points.slice(0, -1).map((from, index) => {
    const to = points[index + 1] ?? from;
    const statement = highlights.find(
      (highlight) => highlight.start <= from && to <= highlight.end
    )?.statement;
    const hit = hits.find(
      (each) => each.start <= from && to <= each.start + length
    )?.index;
    return {
      text: text.slice(from, to),
      ...(statement ? { statement } : {}),
      ...(hit === undefined ? {} : { hit }),
    };
  });
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
