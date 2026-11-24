/**
 * The "joined" card: a piece of work as core drew it from several
 * interviews (onboarding/work-drawing.ts), against the answer key. Four
 * questions: is what is true in the drawing, is it in the right order, did
 * each person's own numbers survive, and does every part of the drawing
 * rest on what someone agreed to. Order is counted along the drawing, so a
 * true extra step between two steps of the key breaks nothing. The
 * judgments come from the judge (`judgeJoined`); the sums are pure. Ported
 * from the prototype (grasplabs/prototype, packages/grasp: lab/joined.ts).
 */
import { z } from "zod";

import { factText } from "./keys/types.ts";
import type { AnswerKey, KeyEmployee } from "./keys/types.ts";
import type { Asker } from "./person.ts";

/** A drawing as the lab reads it: the parts it judges, of core's DrawnWork. */
export const drawingSchema = z.object({
  /** Whose interviews it was drawn from, by roster ID. */
  from: z.array(z.string()),
  starts: z.string(),
  steps: z.array(
    z.object({ text: z.string(), who: z.string(), tool: z.string() })
  ),
  waits: z.array(z.string()),
  differently: z.array(
    z.object({
      when: z.string(),
      does: z.string(),
      outOfTen: z.number().nullable(),
      after: z.number(),
    })
  ),
  decides: z.string(),
  own: z.string(),
  ai: z.string(),
  right: z.string(),
  ask: z.string(),
  next: z.string(),
  term: z.object({ word: z.string(), meaning: z.string() }).nullable(),
  per: z.enum(["week", "month"]),
  unit: z.enum(["minutes", "hours"]),
  told: z.record(
    z.string(),
    z.object({
      volume: z.tuple([z.number(), z.number()]).nullable(),
      takes: z.tuple([z.number(), z.number(), z.number()]).nullable(),
      wrong: z.number().nullable(),
    })
  ),
  open: z.array(z.string()),
});
export type Drawing = z.output<typeof drawingSchema>;

/** One part of a drawing, with an id to point at and, when it has a place in the order, that place. */
export interface Element {
  id: string;
  text: string;
  /** Where it stands in the order of the work: the start is 0, step n is n, a case off the path stands just after its step. */
  place: number | null;
}

/** A single line of a drawing as a part, when it says anything. */
const single = (id: string, text: string): Element[] =>
  text === "" ? [] : [{ id, text, place: null }];

const stepText = (step: Drawing["steps"][number]): string => {
  if (step.who === "") {
    return step.text;
  }
  return `${step.text} [${step.who}${step.tool === "" ? "" : `, ${step.tool}`}]`;
};

/** A drawing as its parts: the start, the steps, the waits, the cases off the normal path, and the single lines. */
export const elementsOf = (drawn: Drawing): Element[] => [
  ...(drawn.starts === ""
    ? []
    : [{ id: "start", text: drawn.starts, place: 0 }]),
  ...drawn.steps.map((step, at) => ({
    id: `s${at + 1}`,
    text: stepText(step),
    place: at + 1,
  })),
  ...drawn.waits.map((wait, at) => ({
    id: `w${at + 1}`,
    text: wait,
    place: null,
  })),
  ...drawn.differently.map((each, at) => ({
    id: `d${at + 1}`,
    text: `When ${each.when}: ${each.does}${each.outOfTen === null ? "" : ` (${each.outOfTen} in 10)`}`,
    place: each.after + 1.5,
  })),
  ...single("decides", drawn.decides),
  ...single("own", drawn.own),
  ...single("ai", drawn.ai),
  ...single("right", drawn.right),
  ...single("ask", drawn.ask),
  ...single("next", drawn.next),
  ...(drawn.term === null
    ? []
    : [
        {
          id: "term",
          text: `"${drawn.term.word}" means: ${drawn.term.meaning}`,
          place: null,
        },
      ]),
];

const partVerdicts = ["said", "repeat", "not said"] as const;

export interface JoinedJudged {
  /** Each fact of the key that is not a number: the parts of the drawing that hold it. */
  key: { id: string; found: string[] }[];
  /** Each number someone knows: whether the drawing holds the amount that person gave. */
  numbers: { id: string; person: string; kept: boolean }[];
  /** Each step, wait and case of the drawing: someone agreed to it, it repeats an earlier part, or nobody said it. */
  elements: { id: string; verdict: (typeof partVerdicts)[number] }[];
}

export interface JoinedCard {
  /** Of the facts of the key that someone said in their interview: how many are in the drawing. What nobody said is not the drawing's to hold. */
  found: { count: number; of: number; missed: string[] };
  /** Of the links between two facts of the key that are both in the drawing: how many stand in that order. */
  order: { count: number; of: number };
  /** Of each person's own numbers: how many the drawing still holds, and which it lost, as "person: fact". */
  numbers: { count: number; of: number; lost: string[] };
  supported: { count: number; repeats: number; notSaid: string[]; of: number };
  steps: number;
  /** What the drawing itself says nobody could tell yet. */
  open: number;
}

/** The links of a key between facts that have a place in the order: what comes after what. */
const linksOf = (key: AnswerKey): [string, string][] =>
  key.facts.flatMap((fact): [string, string][] => [
    ...(fact.next ?? []).map((to): [string, string] => [fact.id, to]),
    ...Object.values(fact.branches ?? {}).map((to): [string, string] => [
      fact.id,
      to,
    ]),
    ...(fact.after === undefined
      ? []
      : [[fact.after, fact.id] satisfies [string, string]]),
  ]);

/** The steps, waits and cases of a drawing: the parts whose support is judged. */
const judgedPart = /^[swd]\d+$/u;

/**
 * A drawing's card against its key. `said` is the facts of the key that
 * someone said in their interview, by id; without it every fact counts.
 */
export const joinedCardOf = (
  key: AnswerKey,
  drawn: Drawing,
  judged: JoinedJudged,
  numbersAsked: number,
  said: readonly string[] | null = null
): JoinedCard => {
  const elements = elementsOf(drawn);
  const placeOf = new Map(
    elements.map((element) => [element.id, element.place])
  );
  const facts = key.facts.filter(
    (fact) =>
      fact.type !== "number" && (said === null || said.includes(fact.id))
  );
  const found = new Map(
    judged.key.map((each) => [
      each.id,
      each.found.filter((id) => placeOf.has(id)),
    ])
  );
  const isFound = (id: string) => (found.get(id)?.length ?? 0) > 0;
  // Where a fact of the key stands in the drawing: the first of its parts that has a place.
  const standsAt = (id: string): number | null =>
    (found.get(id) ?? [])
      .map((element) => placeOf.get(element) ?? null)
      .find((place) => place !== null) ?? null;
  const links = linksOf(key).flatMap(([from, to]) => {
    const [one, other] = [standsAt(from), standsAt(to)];
    return one === null || other === null ? [] : [one <= other];
  });
  const parts = elements.filter((element) => judgedPart.test(element.id));
  const verdictOf = (id: string) =>
    judged.elements.find((each) => each.id === id)?.verdict ?? "not said";
  return {
    found: {
      count: facts.filter((fact) => isFound(fact.id)).length,
      of: facts.length,
      missed: facts.filter((fact) => !isFound(fact.id)).map((fact) => fact.id),
    },
    order: { count: links.filter(Boolean).length, of: links.length },
    numbers: {
      count: judged.numbers.filter((each) => each.kept).length,
      of: numbersAsked,
      lost: judged.numbers
        .filter((each) => !each.kept)
        .map((each) => `${each.person}: ${each.id}`),
    },
    supported: {
      count: parts.filter((part) => verdictOf(part.id) === "said").length,
      repeats: parts.filter((part) => verdictOf(part.id) === "repeat").length,
      notSaid: parts
        .filter((part) => verdictOf(part.id) === "not said")
        .map((part) => part.text),
      of: parts.length,
    },
    steps: drawn.steps.length,
    open: drawn.open.length,
  };
};

const share = (count: number, of: number): number =>
  of === 0 ? 0 : count / of;

/** A joined card as the numbers a result keeps. */
export const joinedScores = (card: JoinedCard): Record<string, number> => ({
  found: share(card.found.count, card.found.of),
  order: share(card.order.count, card.order.of),
  numbers: share(card.numbers.count, card.numbers.of),
  supported: share(card.supported.count, card.supported.of),
  repeats: share(card.supported.repeats, card.supported.of),
  notSaid: share(card.supported.notSaid.length, card.supported.of),
  steps: card.steps,
});

const joinedSystem = `You are a strict judge. You compare how a piece of work really goes with how an interviewer drew it from several interviews. You get:
- "key": the true facts about the work, each with an id.
- "numbers": amounts that single people know, each with the fact's id, the person, and the amount as that person remembers it.
- "drawing": the parts of the drawing, each with an id. "told" holds each person's own numbers as the drawing keeps them.
- "agreed": what each person agreed to in their own interview, as short facts.

For each fact in "key": found is the ids of the parts of the drawing that hold it, in whole or in clear part. Other words are fine; a more general or more detailed version of the same thing counts. A different thing in the same area does not. None when the drawing does not hold it.

For each entry in "numbers": kept is true when the drawing holds the amount that this person gave for that thing, in "told" for that person or in the words of a part. A range that covers their amount counts. An amount of someone else does not.

For each part of the drawing whose id starts with s, w or d:
- "said": at least one person agreed to it in "agreed".
- "repeat": it says the same thing as an earlier part of the drawing. The first of the two is not a repeat.
- "not said": nothing in "agreed" carries it.

When you are not sure, it is not found, not kept, not said. Answer for every id, each once.`;

const joinedSchema = z.object({
  key: z.array(z.object({ id: z.string(), found: z.array(z.string()) })),
  numbers: z.array(
    z.object({ id: z.string(), person: z.string(), kept: z.boolean() })
  ),
  elements: z.array(
    z.object({ id: z.string(), verdict: z.enum(partVerdicts) })
  ),
});

/** Who told, with what they agreed to: the employees of the key whose interviews the drawing is from. */
export interface Teller {
  employee: KeyEmployee;
  /** Their id on the roster, as the drawing names them in `told`. */
  person: string;
  agreed: string[];
}

/** The numbers each teller knows, as they remember them: what the drawing should still hold. */
export const numbersOf = (
  key: AnswerKey,
  tellers: readonly Teller[]
): { id: string; person: string; what: string; remembered: string }[] =>
  tellers.flatMap((teller) =>
    key.facts.flatMap((fact) =>
      fact.type === "number" && teller.employee.knows.includes(fact.id)
        ? [
            {
              id: fact.id,
              person: teller.employee.name,
              what: `${factText(fact)}${fact.unit === undefined ? "" : ` (${fact.unit})`}`,
              remembered:
                teller.employee.remembers?.[fact.id] ??
                `about ${fact.value ?? "?"}`,
            },
          ]
        : []
    )
  );

/** A drawing judged against its key, part by part. Says how many numbers it was asked about. */
export const judgeJoined = async (
  asker: Asker,
  key: AnswerKey,
  drawn: Drawing,
  tellers: readonly Teller[]
): Promise<{ judged: JoinedJudged; numbers: number }> => {
  const numbers = numbersOf(key, tellers);
  const nameOf = new Map(
    tellers.map((teller) => [teller.person, teller.employee.name])
  );
  const answer = await asker({
    role: "careful",
    system: joinedSystem,
    input: JSON.stringify({
      key: key.facts
        .filter((fact) => fact.type !== "number")
        .map((fact) => ({
          id: fact.id,
          type: fact.type,
          fact: `${factText(fact)}${fact.condition === undefined ? "" : ` (when: ${fact.condition})`}`,
        })),
      numbers,
      drawing: {
        parts: elementsOf(drawn).map(({ id, text }) => ({ id, text })),
        per: drawn.per,
        unit: drawn.unit,
        told: Object.entries(drawn.told).map(([person, told]) => ({
          person: nameOf.get(person) ?? person,
          volume: told.volume,
          takes: told.takes,
          wrongOutOfTen: told.wrong,
        })),
      },
      agreed: tellers.map((teller) => ({
        person: teller.employee.name,
        facts: teller.agreed,
      })),
    }),
    schema: joinedSchema,
    effort: "medium",
    maxTokens: 8000,
  });
  return {
    judged: {
      key: answer.key,
      // One answer for each number asked about, whatever else came back.
      numbers: numbers.map((each) => ({
        id: each.id,
        person: each.person,
        kept: answer.numbers.some(
          (found) =>
            found.id === each.id && found.person === each.person && found.kept
        ),
      })),
      elements: answer.elements,
    },
    numbers: numbers.length,
  };
};
