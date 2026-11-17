import { tokensOf } from "@grasp-os/brain-next/contract";

// By relative path: what a run sends is extraction's own prompts, which
// the package doesn't export.
// oxlint-disable-next-line no-restricted-imports -- extraction's own prompts, see above
import {
  checkInstructions,
  proposeInstructions,
} from "../../../../../packages/brain-next/src/extraction.ts";
import { isDay, valuesOf } from "./set.ts";
import type {
  EvalEntity,
  EvalFact,
  EvalPlant,
  ExtractionEvalSet,
} from "./set.ts";

// What a run of the evaluation of extraction sends, before it sends it:
// how many units and calls, and about how many tokens, from the set. The
// Brain's own token estimate (`tokensOf`, above a real tokenizer's count).
// A read's answer is taken as long as the careful proposal of its labels
// and plants (`proposalOf`), a check's as a short list of indexes; a
// model that thinks before it answers spends more output than that.

/** The read call's answer a careful model gives for `facts`: the labels as it would propose them. */
export const proposalOf = (facts: readonly EvalFact[]) => {
  const keys = new Map<string, EvalEntity>();
  const keyOf = (entity: EvalEntity): string => {
    const key = `${entity.kind}:${entity.name}`;
    keys.set(key, entity);
    return key;
  };
  const memories = facts.map((fact) => {
    const [value = null] = valuesOf(fact);
    const day = value !== null && isDay(value);
    return {
      about: keyOf(fact.about),
      attribute: fact.attribute,
      object: fact.object === undefined ? null : keyOf(fact.object),
      value: day ? null : value,
      date: day ? { kind: "date", date: value } : null,
      until: null,
      type: "fact",
      statement: `${fact.about.name}: ${fact.attribute} ${fact.object?.name ?? value ?? ""}.`,
      quote: fact.quote,
    };
  });
  return {
    entities: [...keys].map(([key, { kind, name }]) => ({
      key,
      kind,
      names: [name],
      emails: [],
    })),
    memories,
  };
};

/** Tokens a check's answer takes: `{"supported":[…]}`. */
const checkAnswerTokens = 20;

/** About what one unit sends: its read call and its check call. */
const unitTokens = (
  text: string,
  facts: readonly EvalFact[],
  plants: readonly EvalPlant[]
) => {
  const proposed = tokensOf(JSON.stringify(proposalOf([...facts, ...plants])));
  return {
    calls: 2,
    input:
      tokensOf(proposeInstructions) +
      tokensOf(text) +
      tokensOf(checkInstructions) +
      tokensOf(text) +
      proposed,
    output: proposed + checkAnswerTokens,
  };
};

export interface ExtractionPlan {
  units: number;
  calls: number;
  input: number;
  output: number;
}

/** What a whole run of `set` sends, about: two draws of each document, then each probe's second text. */
export const planOf = ({
  documents,
  probes,
}: ExtractionEvalSet): ExtractionPlan => {
  const units = [
    ...documents.flatMap((document) => [
      unitTokens(document.text, document.facts, []),
      unitTokens(document.text, document.facts, document.plants),
    ]),
    ...probes.map(({ second }) => unitTokens(second.text, second.facts, [])),
  ];
  return {
    units: units.length,
    calls: units.reduce((sum, { calls }) => sum + calls, 0),
    input: units.reduce((sum, { input }) => sum + input, 0),
    output: units.reduce((sum, { output }) => sum + output, 0),
  };
};

/** `tokens` at `price`, in US dollars per million tokens. */
export const costOf = (
  { input, output }: { input: number; output: number },
  price: { input: number; output: number }
): number => (input * price.input + output * price.output) / 1_000_000;
