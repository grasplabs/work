import { sha256Hex } from "@grasp-os/shared/encoding";

// By relative path: the set's checks and the grep baseline must cut a text
// exactly as the Brain does, and the package exports only its contract and
// store. A pure function, read by the evaluation alone, never by core.
// oxlint-disable-next-line no-restricted-imports -- the Brain's own chunker, see above
import { chunksOf } from "../../../../../packages/brain-next/src/chunks.ts";
import {
  brainEvalDefaultAsker,
  brainEvalSetVersion,
  brainEvalTeamNames,
  brainEvalTeams,
} from "./company.ts";
import type {
  BrainEvalPerson,
  BrainEvalQuestion,
  BrainEvalSource,
  BrainEvalTeam,
} from "./company.ts";
import { crossLongQuestions } from "./cross-long.ts";
import { crossQuestions } from "./cross.ts";
import { deLongQuestions, deLongSources } from "./de-long.ts";
import { deQuestions, deSources } from "./de.ts";
import { enLongQuestions, enLongSources } from "./en-long.ts";
import { enQuestions, enSources } from "./en.ts";
import { esLongQuestions, esLongSources } from "./es-long.ts";
import { esQuestions, esSources } from "./es.ts";
import { frLongQuestions, frLongSources } from "./fr-long.ts";
import { frQuestions, frSources } from "./fr.ts";
import {
  nlLongHandbookQuestions,
  nlLongHandbookSources,
} from "./nl-long-handbook.ts";
import { nlLongNotesQuestions, nlLongNotesSources } from "./nl-long-notes.ts";
import { nlQuestions, nlSources } from "./nl.ts";

// The whole set, and the rules a run checks it against before it asks
// anything: a question that could pass or fail for the wrong reason is a
// broken set, not a result. The Brain returns passages, not sources (a
// long document is cut into several), so the checks and the baseline cut
// every source into the same passages the Brain does (`passagesOf`) and
// count those.

/**
 * Everything that decides a run's results, apart from the Brain itself:
 * the sources and who may read them, the questions and who asks them, who
 * is in each team, and who asks when a question doesn't say.
 */
export interface BrainEvalSet {
  version: string;
  sources: readonly BrainEvalSource[];
  questions: readonly BrainEvalQuestion[];
  teams: Readonly<Record<BrainEvalTeam, readonly BrainEvalPerson[]>>;
  defaultAsker: BrainEvalPerson;
}

export const brainEvalSet: BrainEvalSet = {
  version: brainEvalSetVersion,
  sources: [
    ...nlSources,
    ...enSources,
    ...deSources,
    ...frSources,
    ...esSources,
    ...nlLongHandbookSources,
    ...nlLongNotesSources,
    ...enLongSources,
    ...deLongSources,
    ...frLongSources,
    ...esLongSources,
  ],
  questions: [
    ...nlQuestions,
    ...enQuestions,
    ...deQuestions,
    ...frQuestions,
    ...esQuestions,
    ...crossQuestions,
    ...nlLongHandbookQuestions,
    ...nlLongNotesQuestions,
    ...enLongQuestions,
    ...deLongQuestions,
    ...frLongQuestions,
    ...esLongQuestions,
    ...crossLongQuestions,
  ],
  teams: brainEvalTeams,
  defaultAsker: brainEvalDefaultAsker,
};

/**
 * A text's length in code points, as SQLite's `length()` counts it when
 * the Brain breaks a tie by a chunk's length; JS `.length` counts UTF-16
 * units, which differ for characters outside the BMP.
 */
// oxlint-disable-next-line typescript/no-misused-spread -- code points are what SQLite counts, see above
const lengthOf = (text: string): number => [...text].length;

/** A passage of a source: one chunk of it, as the Brain cuts it. */
export interface Passage {
  source: BrainEvalSource;
  /** The source's place in the set: later is newer. */
  order: number;
  /** The passage's place in its source, from 0. */
  position: number;
  text: string;
}

/**
 * Every passage of `sources`, in order: each source cut by the Brain's own
 * chunker, so a passage here is a chunk the Brain holds, text for text.
 */
export const passagesOf = (sources: readonly BrainEvalSource[]): Passage[] =>
  sources.flatMap((source, order) =>
    chunksOf(source.text).map((text, position) => ({
      source,
      order,
      position,
      text,
    }))
  );

/**
 * The set's digest: all of it, so a change to any source, reader, question,
 * asker or team is a different set, version bumped or not. A run compared
 * with one of another set gives no verdicts, since every rank depends on
 * every source and on who may read it.
 */
export const setDigestOf = async (set: BrainEvalSet): Promise<string> =>
  await sha256Hex(JSON.stringify(set));

/**
 * The digest of how the Brain's chunker cuts `sources`: each passage's
 * source, place and text. The set's digest covers only the raw texts, yet
 * what counts as found, which questions are over long documents and the
 * units grep ranks all depend on the cut, so a change to the chunker is a
 * different measurement too.
 */
export const passagesDigestOf = async (
  sources: readonly BrainEvalSource[]
): Promise<string> =>
  await sha256Hex(
    JSON.stringify(
      passagesOf(sources).map(({ source, position, text }) => [
        source.key,
        position,
        text,
      ])
    )
  );

/**
 * A question's digest: the question, who asks it and the teams they are
 * in, and the source it asks for with its readers and the passages the
 * Brain cuts it into. A comparison pairs a question with its earlier result
 * only when this is unchanged, so a source cut differently stops pairing.
 */
export const questionDigestOf = async (
  set: BrainEvalSet,
  question: BrainEvalQuestion
): Promise<string> => {
  const asker = question.asker ?? set.defaultAsker;
  const askerTeams = brainEvalTeamNames.filter((team) =>
    set.teams[team].includes(asker)
  );
  const { expects } = question;
  const source =
    expects.kind === "absent"
      ? null
      : (set.sources.find(({ key }) => key === expects.source) ?? null);
  const passages =
    source === null ? null : passagesOf([source]).map(({ text }) => text);
  const digest = await sha256Hex(
    JSON.stringify({ question, asker, askerTeams, source, passages })
  );
  return digest.slice(0, 16);
};

/** Who asks `question`. */
export const askerOf = (question: BrainEvalQuestion): BrainEvalPerson =>
  question.asker ?? brainEvalDefaultAsker;

/** Whether `person` may read `source`, as its readers say. */
export const mayRead = (
  person: BrainEvalPerson,
  source: BrainEvalSource
): boolean => {
  const { readers } = source;
  if (readers === "nobody") {
    return false;
  }
  if ("owner" in readers) {
    return readers.owner === person;
  }
  const members: readonly BrainEvalPerson[] = brainEvalTeams[readers.team];
  return members.includes(person);
};

/** Whether the Brain cuts `source` into more than one passage. */
export const isLongDocument = (source: BrainEvalSource): boolean =>
  passagesOf([source]).length > 1;

/**
 * What a recall returned, best first: each result's source, as the set's
 * key (`undefined` for a source the set doesn't hold), and its text.
 */
export interface Returned {
  keys: readonly (string | undefined)[];
  texts: readonly string[];
}

/**
 * 1-based rank of the passage that answers the question among `returned`:
 * a result of its source that holds its quote; `null` when it isn't there
 * or the question expects no source. Another passage of the same source
 * doesn't count (see {@link sourceRankOf}).
 */
export const rankOf = (
  question: BrainEvalQuestion,
  returned: Returned
): number | null => {
  const { expects } = question;
  if (expects.kind !== "answer") {
    return null;
  }
  const index = returned.keys.findIndex(
    (key, at) =>
      key === expects.source &&
      (returned.texts[at] ?? "").includes(expects.quote)
  );
  return index === -1 ? null : index + 1;
};

/**
 * 1-based rank of the first result of the question's source among
 * `returned`, whether or not it holds the quote; `null` when there is none
 * or the question expects no source. With {@link rankOf} it tells "the
 * right source, the wrong passage" apart from "not the source at all".
 */
export const sourceRankOf = (
  question: BrainEvalQuestion,
  returned: Returned
): number | null => {
  const { expects } = question;
  if (expects.kind !== "answer") {
    return null;
  }
  const index = returned.keys.indexOf(expects.source);
  return index === -1 ? null : index + 1;
};

/**
 * What `returned` holds that the asker may not see: a source they may not
 * read (`unreadable:<key>`), one the set doesn't hold (`unknown`), or a
 * hidden answer's secret in any text (`secret:<text>`). Any is a leak.
 */
export const leaksOf = (
  sources: readonly BrainEvalSource[],
  question: BrainEvalQuestion,
  returned: Returned
): string[] => {
  const asker = askerOf(question);
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const { expects } = question;
  const secrets = expects.kind === "hidden" ? expects.secrets : [];
  return [
    ...returned.keys.flatMap((key) => {
      const source = key === undefined ? undefined : byKey.get(key);
      if (source === undefined) {
        return ["unknown"];
      }
      return mayRead(asker, source) ? [] : [`unreadable:${source.key}`];
    }),
    ...secrets
      .filter((secret) => returned.texts.some((text) => text.includes(secret)))
      .map((secret) => `secret:${secret}`),
  ];
};

/** The words grep looks for: the question's, lowercased, nothing more. */
const wordPattern = /[\p{L}\p{N}]+/gu;

/**
 * Plain text search, the baseline, as `grep -i` per word, over the same
 * passages the Brain's chunker cuts (`passagesOf`) and with the same
 * access: each passage of a source the asker may read, scored by how many
 * of the question's words its raw text holds anywhere, as a case-blind
 * substring. Passages, not whole sources, so a rank counts the same unit in
 * both arms: a whole long document holds most of any question's words and
 * always holds the quote, and one result of it would stand for a dozen of
 * the Brain's. (A source of one passage is ranked as its whole text.)
 *
 * The substring finds a question's word inside a longer word of the text
 * for free, a singular in its plural or a word in a compound ("tankpas" in
 * "tankpassen", "zuschlag" in "samstagszuschlag"), though not the other
 * way round: on the `forms` way it already does part of what stemming
 * will. It doesn't ignore accents ("financiele" is not "financiële").
 * Ties as the Brain breaks them: the shorter passage first (in code
 * points). The later source in the set (newer), then the earlier place in
 * its source, follow only as fallbacks: no two passages are the same length
 * (`setProblems`), so they never decide. At most `limit` results, each its
 * source's key and the passage's text.
 */
export const grepRecall = (
  passages: readonly Passage[],
  asker: BrainEvalPerson,
  question: string,
  limit: number
): Returned => {
  const words = [...new Set(question.toLowerCase().match(wordPattern))];
  const ranked = passages
    .filter((passage) => mayRead(asker, passage.source))
    .map((passage) => {
      const text = passage.text.toLowerCase();
      const score = words.filter((word) => text.includes(word)).length;
      return { passage, score, length: lengthOf(passage.text) };
    })
    .filter(({ score }) => score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.length - b.length ||
        b.passage.order - a.passage.order ||
        a.passage.position - b.passage.position
    )
    .slice(0, limit);
  return {
    keys: ranked.map(({ passage }) => passage.source.key),
    texts: ranked.map(({ passage }) => passage.text),
  };
};

/** Those of `passages` that hold `words` whole. */
const holding = (
  passages: readonly Passage[],
  words: string
): readonly Passage[] => passages.filter(({ text }) => text.includes(words));

/**
 * The set's problems with its passages, cut as the Brain cuts them: no two
 * passages the same length, and each answer's quote (and look-alike) and
 * each hidden answer's secrets whole where the checks look for them.
 */
const passageProblems = (
  sources: readonly BrainEvalSource[],
  questions: readonly BrainEvalQuestion[]
): string[] => {
  const problems: string[] = [];
  const passages = passagesOf(sources);
  const bySource = Map.groupBy(passages, ({ source }) => source.key);
  const nameOf = ({ source, position }: Passage): string =>
    (bySource.get(source.key)?.length ?? 0) > 1
      ? `${source.key}#${position}`
      : source.key;
  // A source of one passage is that passage, and the Brain breaks a tie on
  // score by the chunk's length: with no two the same, a tie never reaches
  // its random IDs.
  const byLength = Map.groupBy(passages, ({ text }) => lengthOf(text));
  for (const [length, same] of byLength) {
    if (same.length > 1) {
      problems.push(
        `${same.map(nameOf).join(", ")}: all ${length} characters long`
      );
    }
  }
  for (const { expects, id } of questions) {
    if (expects.kind === "absent") {
      continue;
    }
    const source = sources.find(({ key }) => key === expects.source);
    if (source === undefined) {
      continue;
    }
    const own = bySource.get(source.key) ?? [];
    if (expects.kind === "hidden") {
      // A secret cut in two is in no chunk the Brain returns, so the leak
      // check could never see it.
      for (const secret of expects.secrets) {
        if (source.text.includes(secret) && holding(own, secret).length === 0) {
          problems.push(
            `${id}: "${secret}" is cut across passages of ${source.key}`
          );
        }
      }
      continue;
    }
    // Only the passage holding the quote counts as found: it must be one.
    const quoted = holding(own, expects.quote);
    if (quoted.length === 0 && source.text.includes(expects.quote)) {
      problems.push(`${id}: its quote is cut across passages of ${source.key}`);
    }
    if (quoted.length > 1) {
      problems.push(
        `${id}: its quote is in ${quoted.length} passages of ${source.key}`
      );
    }
    const { lookalike } = expects;
    if (lookalike === undefined) {
      continue;
    }
    // Whole in exactly one passage, and not the one that holds the quote.
    const alike = holding(own, lookalike);
    const withQuote = alike.find((passage) => quoted.includes(passage));
    if (withQuote !== undefined) {
      problems.push(
        `${id}: its look-alike is in the passage that holds its quote, ${nameOf(withQuote)}`
      );
    } else if (alike.length === 0) {
      problems.push(
        `${id}: its look-alike must be whole in one passage of ${source.key}`
      );
    } else if (alike.length > 1) {
      problems.push(
        `${id}: its look-alike is in ${alike.length} passages of ${source.key}`
      );
    }
  }
  return problems;
};

/**
 * What is wrong with the set, if anything: keys and IDs unique; every
 * question's source exists; an answer's quote is in its source and in no
 * other, and its asker may read it; a hidden answer's source is one its
 * asker may not read, and its secrets are in it and in nothing else the
 * asker may read. And on its passages, cut by the Brain's own chunker: no
 * two the same length, so a tie on score is broken by length, never by the
 * Brain's random IDs; an answer's quote whole in exactly one passage of its
 * source, so only that passage counts as found; its look-alike, when it
 * names one, whole in exactly one passage of that source, not the quote's
 * (in the quote's passage and another is a problem too); and each
 * hidden secret whole in a passage of its source, so the leak check can
 * see it in a returned chunk.
 */
export const setProblems = (
  sources: readonly BrainEvalSource[],
  questions: readonly BrainEvalQuestion[]
): string[] => {
  const problems: string[] = [];
  const byKey = new Map(sources.map((source) => [source.key, source]));
  if (byKey.size !== sources.length) {
    problems.push("Source keys are not unique");
  }
  if (new Set(questions.map(({ id }) => id)).size !== questions.length) {
    problems.push("Question IDs are not unique");
  }
  for (const question of questions) {
    const { expects, id } = question;
    if (expects.kind === "absent") {
      continue;
    }
    const source = byKey.get(expects.source);
    if (source === undefined) {
      problems.push(`${id}: no source ${expects.source}`);
      continue;
    }
    const asker = askerOf(question);
    if (expects.kind === "answer") {
      const holdingQuote = sources.filter(({ text }) =>
        text.includes(expects.quote)
      );
      if (holdingQuote.length !== 1 || holdingQuote[0] !== source) {
        problems.push(`${id}: its quote must be in ${source.key} alone`);
      }
      if (!mayRead(asker, source)) {
        problems.push(`${id}: ${asker} may not read ${source.key}`);
      }
      continue;
    }
    if (mayRead(asker, source)) {
      problems.push(`${id}: ${asker} may read ${source.key}`);
    }
    for (const secret of expects.secrets) {
      if (!source.text.includes(secret)) {
        problems.push(`${id}: "${secret}" is not in ${source.key}`);
      }
      const elsewhere = sources.find(
        (other) => mayRead(asker, other) && other.text.includes(secret)
      );
      if (elsewhere !== undefined) {
        problems.push(`${id}: "${secret}" is also in ${elsewhere.key}`);
      }
    }
  }
  return [...problems, ...passageProblems(sources, questions)];
};
