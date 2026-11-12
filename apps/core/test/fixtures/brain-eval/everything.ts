import { tokensOf } from "@grasp-os/brain-next/contract";

import type {
  BrainEvalPerson,
  BrainEvalQuestion,
  BrainEvalSource,
} from "./company.ts";
import { askerOf, mayRead, passagesOf } from "./set.ts";

// The evaluation's second baseline (GRA-1813): the model answers from
// everything the asker may read, against the model answering from the
// Brain's recall pack. Pure: what both arms send, and the most a question
// can cost, read alike by the run in workerd
// (test/brain-eval-model.test.ts) and by the script that plans it and
// says what it would cost before anything is spent
// (scripts/brain-eval-model.ts).
//
// "Everything" is every source the asker may read, newest first (the
// set's order: later is newer), each whole, until the next no longer
// fits the budget: that one is cut where the budget ends, and the rest
// left out. Tokens are counted as the Brain counts a pack's
// (`tokensOf`), which counts more than today's tokenizers do, so a
// context cut at the model's window fits it.

/** The tokens the recall pack may take: the arm the Brain is measured by. */
export const packTokens = 4000;

/** The most tokens an answer or a verdict may take, thinking included. */
export const outputTokensMax = 1024;

/** What the model is told to say when the sources don't hold the answer. */
export const notFound = "NOT FOUND";

/** How the model is asked to answer, alike in both arms. */
export const answerSystem = `You answer a question asked by someone at a company, using only the sources below. Answer in one or two sentences, in the language of the question. If the sources do not hold the answer, reply with exactly ${notFound}, in English, and nothing else.`;

/** How the judge is asked: the same model, given the passage that answers. */
export const judgeSystem =
  "You check an answer to a question against the passage that answers it. Reply with exactly one word: CORRECT if the answer gives what the passage says in reply to the question, in any language; WRONG if it doesn't, contradicts it, or says the answer isn't there.";

/** A source as the model reads it: its key, then its text. */
export const sourceBlock = (key: string, text: string): string =>
  `<source key="${key}">\n${text}\n</source>\n`;

/** What the model is given for one question, from its sources' blocks. */
export const answerInput = (question: string, sources: string): string =>
  `Sources:\n${sources}\nQuestion: ${question}`;

/** What the judge is given. */
export const judgeInput = (
  question: string,
  passage: string,
  answer: string
): string =>
  `Question: ${question}\n\nPassage that answers it:\n${passage}\n\nAnswer to check:\n${answer}`;

/** Whether the model said the sources don't hold the answer. */
export const saidNotFound = (answer: string): boolean =>
  answer.trim().toUpperCase().startsWith(notFound);

/** Whether the judge said the answer is correct. */
export const judgedCorrect = (verdict: string): boolean => {
  const word = verdict.trim().toUpperCase();
  return word.startsWith("CORRECT");
};

/** The context the "everything" arm gives the model, and what it holds. */
export interface Everything {
  /** The sources' blocks, newest first. */
  text: string;
  /** The keys of the sources in it, newest first; the last may be cut. */
  keys: string[];
  /** Whether a source was cut, or left out, at the budget. */
  cut: boolean;
  tokens: number;
}

/**
 * The longest start of `text` whose block, under `key`, takes at most
 * `tokens`: by halves, since `tokensOf` only grows with the text.
 */
const cutTo = (key: string, text: string, tokens: number): string => {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tokensOf(sourceBlock(key, text.slice(0, middle))) <= tokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low);
};

/**
 * Everything `asker` may read of `sources` (in the set's order, oldest
 * first), newest first, within `budget` tokens.
 */
export const everythingFor = (
  sources: readonly BrainEvalSource[],
  asker: BrainEvalPerson,
  budget: number
): Everything => {
  const readable = sources
    .filter((source) => mayRead(asker, source))
    .toReversed();
  const blocks: string[] = [];
  const keys: string[] = [];
  let left = budget;
  for (const source of readable) {
    const block = sourceBlock(source.key, source.text);
    const tokens = tokensOf(block);
    if (tokens <= left) {
      blocks.push(block);
      keys.push(source.key);
      left -= tokens;
      continue;
    }
    const start = cutTo(source.key, source.text, left);
    if (start !== "") {
      blocks.push(sourceBlock(source.key, start));
      keys.push(source.key);
      left -= tokensOf(blocks.at(-1) ?? "");
    }
    return { text: blocks.join(""), keys, cut: true, tokens: budget - left };
  }
  return { text: blocks.join(""), keys, cut: false, tokens: budget - left };
};

/**
 * What no source `asker` may read holds and the set keeps from them: each
 * secret of a question whose answer is hidden from them. A context or an
 * answer that holds one leaks.
 */
export const secretsHiddenFrom = (
  questions: readonly BrainEvalQuestion[],
  asker: BrainEvalPerson
): string[] =>
  questions.flatMap((question) =>
    question.expects.kind === "hidden" && askerOf(question) === asker
      ? question.expects.secrets
      : []
  );

/**
 * The passage of `question`'s source that holds its quote, as the Brain
 * cuts the source: what the judge reads the answer against. Empty for a
 * question without an answer in the set.
 */
export const answeringPassageOf = (
  sources: readonly BrainEvalSource[],
  question: BrainEvalQuestion
): string => {
  const { expects } = question;
  if (expects.kind !== "answer") {
    return "";
  }
  const source = sources.filter(({ key }) => key === expects.source);
  return (
    passagesOf(source).find(({ text }) => text.includes(expects.quote))?.text ??
    expects.quote
  );
};

/** Input and output tokens. */
export interface Tokens {
  input: number;
  output: number;
}

/**
 * The most one question can take, by `tokensOf`: each arm's answer, and
 * for a question with an answer each arm's verdict, with every output at
 * its limit, read back by the judge. The "everything" context is
 * `everything` tokens, the pack at most {@link packTokens}, and `passage`
 * what the judge reads the answer against (`answeringPassageOf`).
 */
export const questionTokensMax = (
  question: BrainEvalQuestion,
  everything: number,
  passage: string
): Tokens => {
  const asked =
    tokensOf(answerSystem) + tokensOf(answerInput(question.question, ""));
  const answers = 2;
  const verdicts = question.expects.kind === "answer" ? 2 : 0;
  const judged =
    tokensOf(judgeSystem) +
    tokensOf(judgeInput(question.question, passage, "")) +
    outputTokensMax;
  return {
    input: 2 * asked + everything + packTokens + verdicts * judged,
    output: (answers + verdicts) * outputTokensMax,
  };
};

/** A model's list price per million tokens, as the gateway's catalog has it. */
export interface Price {
  input: number;
  output: number;
}

/** What `tokens` cost at `price`, in US dollars. */
export const costOf = (tokens: Tokens, price: Price): number =>
  (tokens.input * price.input + tokens.output * price.output) / 1_000_000;

/** The tokens a model's window leaves for the "everything" context. */
export const everythingBudgetOf = (
  contextWindow: number,
  question: BrainEvalQuestion
): number =>
  contextWindow -
  outputTokensMax -
  tokensOf(answerSystem) -
  tokensOf(answerInput(question.question, ""));

/**
 * A seeded order of `items` (Park–Miller and Fisher–Yates), so a run
 * that stops at its budget has asked a sample of every group, and two
 * runs ask in the same order.
 */
export const seededOrder = <T>(items: readonly T[], seed = 1813): T[] => {
  const modulus = 2_147_483_647;
  let state = (seed % (modulus - 1)) + 1;
  const order = [...items];
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (state * 48_271) % modulus;
    const other = Math.floor(((state - 1) / (modulus - 1)) * (index + 1));
    const at = order[index];
    const swapped = order[other];
    if (at !== undefined && swapped !== undefined) {
      order[index] = swapped;
      order[other] = at;
    }
  }
  return order;
};
