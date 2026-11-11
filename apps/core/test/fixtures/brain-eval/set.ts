import {
  brainEvalDefaultAsker,
  brainEvalSetVersion,
  brainEvalTeams,
} from "./company.ts";
import type {
  BrainEvalPerson,
  BrainEvalQuestion,
  BrainEvalSource,
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

export const brainEvalSet = {
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
} as const satisfies {
  version: string;
  sources: readonly BrainEvalSource[];
  questions: readonly BrainEvalQuestion[];
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
 * What is wrong with the set, if anything: keys and IDs unique; every
 * question's source exists; an answer's quote is in its source and in no
 * other, and its asker may read it; a hidden answer's source is one its
 * asker may not read, and its secrets are in it and in nothing else the
 * asker may read.
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
