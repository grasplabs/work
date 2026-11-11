import { sha256Hex } from "@grasp-os/shared/encoding";

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
import { crossQuestions } from "./cross.ts";
import { deQuestions, deSources } from "./de.ts";
import { enQuestions, enSources } from "./en.ts";
import { esQuestions, esSources } from "./es.ts";
import { frQuestions, frSources } from "./fr.ts";
import { nlQuestions, nlSources } from "./nl.ts";

// The whole set, and the rules a run checks it against before it asks
// anything: a question that could pass or fail for the wrong reason is a
// broken set, not a result.

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
  ],
  questions: [
    ...nlQuestions,
    ...enQuestions,
    ...deQuestions,
    ...frQuestions,
    ...esQuestions,
    ...crossQuestions,
  ],
  teams: brainEvalTeams,
  defaultAsker: brainEvalDefaultAsker,
};

/**
 * The set's digest: all of it, so a change to any source, reader, question,
 * asker or team is a different set, version bumped or not. A run compared
 * with one of another set gives no verdicts, since every rank depends on
 * every source and on who may read it.
 */
export const setDigestOf = async (set: BrainEvalSet): Promise<string> =>
  await sha256Hex(JSON.stringify(set));

/**
 * A question's digest: the question, who asks it and the teams they are
 * in, and the source it asks for with its readers. A comparison pairs a
 * question with its earlier result only when this is unchanged.
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
  const digest = await sha256Hex(
    JSON.stringify({ question, asker, askerTeams, source })
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

/**
 * What a recall returned, best first: each result's source, as the set's
 * key (`undefined` for a source the set doesn't hold), and its text.
 */
export interface Returned {
  keys: readonly (string | undefined)[];
  texts: readonly string[];
}

/**
 * 1-based rank of the question's source among `returned`, a result that
 * holds its quote; `null` when it isn't there or the question expects no
 * source.
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
 * Plain text search, the baseline, as `grep -i` per word: each source the
 * asker may read, scored by how many of the question's words its raw
 * text holds anywhere, as a case-blind substring. So it finds a
 * question's word inside a longer word of the text for free, a singular
 * in its plural or a word in a compound ("tankpas" in "tankpassen",
 * "zuschlag" in "samstagszuschlag"), though not the other way round: on
 * the `forms` way it already does part of what stemming will. It doesn't
 * ignore accents ("financiele" is not "financiële"). Ties: shorter first,
 * then the later in the set, as the Brain breaks them (shorter, then
 * newer). At most `limit` results.
 */
export const grepRecall = (
  sources: readonly BrainEvalSource[],
  asker: BrainEvalPerson,
  question: string,
  limit: number
): Returned => {
  const words = [...new Set(question.toLowerCase().match(wordPattern))];
  const ranked = sources
    .map((source, order) => {
      const text = source.text.toLowerCase();
      const score = words.filter((word) => text.includes(word)).length;
      return { source, order, score };
    })
    .filter(({ source, score }) => score > 0 && mayRead(asker, source))
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.source.text.length - b.source.text.length ||
        b.order - a.order
    )
    .slice(0, limit);
  return {
    keys: ranked.map(({ source }) => source.key),
    texts: ranked.map(({ source }) => source.text),
  };
};

/**
 * What is wrong with the set, if anything: keys and IDs unique; no two
 * sources the same length, so a tie on score is broken by length, never
 * by the Brain's random IDs; every question's source exists; an answer's
 * quote is in its source and in no other, and its asker may read it; a
 * hidden answer's source is one its asker may not read, and its secrets
 * are in it and in nothing else the asker may read.
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
  const byLength = Map.groupBy(sources, ({ text }) => text.length);
  for (const [length, same] of byLength) {
    if (same.length > 1) {
      problems.push(
        `${same.map(({ key }) => key).join(", ")}: all ${length} characters long`
      );
    }
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
      const holding = sources.filter(({ text }) =>
        text.includes(expects.quote)
      );
      if (holding.length !== 1 || holding[0] !== source) {
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
  return problems;
};
