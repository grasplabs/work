/**
 * An answer key: how one piece of work really goes at a made-up company,
 * and who there knows which part of it. Stephen never sees a key. People
 * are played from it (by a person with a role card, or by a model), and
 * what Stephen wrote down is compared with it afterwards. Pure: no model
 * and no network here. Ported from the prototype (grasplabs/prototype,
 * packages/grasp: lab/keys/types.ts).
 */
import { z } from "zod";

export const factTypes = [
  "trigger",
  "step",
  "decision",
  "exception",
  "wait",
  "done",
  "number",
  "workaround",
  "ai_use",
  "variant",
  "term",
  "judgment",
  "stop",
] as const;
export type FactType = (typeof factTypes)[number];

const idSchema = z.string().min(1).max(40);

/** One true thing about the work. Which fields it has follows from its type. */
const keyFactSchema = z.strictObject({
  id: idSchema,
  type: z.enum(factTypes),
  /** The fact in one sentence; a step as an instruction. A term has `term` and `meaning` instead. */
  text: z.string().optional(),
  /** Who does it, by role id. */
  role: idSchema.optional(),
  system: z.string().optional(),
  /** What comes after it, by fact id. */
  next: z.array(idSchema).optional(),
  /** A decision's answers, and the fact each leads to. */
  branches: z.record(z.string(), idSchema).optional(),
  /** An exception that has no place in the order of its own: the step it comes after. */
  after: idSchema.optional(),
  /** An exception: when it happens, and how often. */
  condition: z.string().optional(),
  rate: z.string().optional(),
  /** A wait: how long. */
  duration: z.string().optional(),
  /** A number: its true value. What someone remembers of it is theirs (`remembers`). */
  value: z.number().optional(),
  unit: z.string().optional(),
  /** A variant: the step it is another way of, and where it is done that way. */
  of: idSchema.optional(),
  where: z.string().optional(),
  term: z.string().optional(),
  meaning: z.string().optional(),
  /** A step beside the work, with no place in its order: a monthly check, say. */
  side: z.boolean().optional(),
  /** What kind of question brings it out, when that is not what its type says (`toldWhen`). */
  toldWhen: z.string().optional(),
});
export type KeyFact = z.output<typeof keyFactSchema>;

/** Someone who does a part of the work. */
const keyEmployeeSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  /** Their role, by role id. */
  role: idSchema,
  office: z.string().optional(),
  /** What their team lead says about them. */
  leadSays: z.string(),
  /** The facts they know, by id, in the order of their own work. */
  knows: z.array(idSchema),
  /** How they remember a number, a rate or a duration, by fact id: said as people say it. */
  remembers: z.record(idSchema, z.string()).optional(),
  /** What they believe in place of a fact, by fact id: an older version they take for true. */
  beliefs: z.record(idSchema, z.string()).optional(),
  /** The colleagues they name, by employee id. */
  mentions: z.array(idSchema).optional(),
});
export type KeyEmployee = z.output<typeof keyEmployeeSchema>;

/** A key, as a hidden one is read from outside the repository. */
export const answerKeySchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  type: z.enum(["normal", "complex"]),
  company: z.strictObject({
    name: z.string().min(1),
    sector: z.string(),
    size: z.int().positive(),
    offices: z.array(z.string()),
  }),
  /** What Grasp knows of the company before anyone talks. */
  brief: z.string(),
  /** The written procedure: it may differ from how the work really goes. */
  procedure: z.string(),
  roles: z.record(
    idSchema,
    z.strictObject({
      name: z.string().min(1),
      team: z.string().min(1),
      aliases: z.array(z.string()).optional(),
    })
  ),
  facts: z.array(keyFactSchema),
  /** Who the team lead points to first. */
  startWith: idSchema,
  employees: z.array(keyEmployeeSchema).min(1),
});
export type AnswerKey = z.output<typeof answerKeySchema>;

/**
 * What brings a fact out, by its type: people tell their steps as a story,
 * and the rest only when someone asks about that kind of thing. A judgment
 * is a decision that takes experience, with what they look at; a stop is
 * when they stop and ask someone. None: it comes with the story.
 */
export const toldWhenOf: Partial<Record<FactType, string>> = {
  exception:
    "asked what goes differently, or about a case that did not go the usual way",
  wait: "asked how long something takes, or what the work waits for",
  number: "asked for this number",
  workaround: "asked about own lists, notes or tools",
  ai_use: "asked about AI tools",
  variant: "asked whether everyone does it the same way",
  term: "asked what the word means; the word itself you use freely",
  judgment: "asked how you decide, or what you look at",
  stop: "asked when you would stop and ask someone",
};

/** A fact as one person knows it: in their own version, with what they remember of its numbers. */
export interface SliceFact {
  id: string;
  type: FactType;
  /** As they would say it: their belief when they hold an older version. */
  text: string;
  /** They hold an older version of this fact, and take it for true. */
  outdated: boolean;
  who?: string;
  system?: string;
  condition?: string;
  where?: string;
  unit?: string;
  /** A number as they remember it. */
  remembered?: string;
  howOften?: string;
  howLong?: string;
  /** What they know comes after it, in words. */
  next: string[];
  /** A decision's answers, with where each leads when they know that. */
  options: { answer: string; leads: string | null }[];
  /** The step an exception comes after, when they know that step. */
  after: string | null;
  /** The kind of question that brings it out; none when it comes with their story. */
  toldWhen: string | null;
}

/** A fact in one sentence, whatever its type. */
export const factText = (fact: KeyFact): string =>
  fact.type === "term"
    ? `"${fact.term ?? ""}" means: ${fact.meaning ?? ""}`
    : (fact.text ?? "");

export const roleName = (key: AnswerKey, role: string): string =>
  key.roles[role]?.name ?? role;

/** What someone holds of a number, a rate or a duration: what they remember, or what is true. */
const amountsOf = (
  fact: KeyFact,
  remembered: string | undefined
): Pick<SliceFact, "remembered" | "howOften" | "howLong"> => {
  if (fact.type === "number") {
    return { remembered: remembered ?? `about ${fact.value ?? "?"}` };
  }
  return {
    ...(fact.rate === undefined ? {} : { howOften: remembered ?? fact.rate }),
    ...(fact.duration === undefined
      ? {}
      : { howLong: remembered ?? fact.duration }),
  };
};

/**
 * The part of the truth one person knows, as they know it. The true value
 * of a number and the true text of something they believe otherwise never
 * get in: they cannot say what they do not know. Where the work goes after
 * a decision or an exception is theirs only when they know the step it
 * goes to.
 */
export const sliceOf = (key: AnswerKey, employee: KeyEmployee): SliceFact[] => {
  const byId = new Map(key.facts.map((fact) => [fact.id, fact]));
  const known = new Set(employee.knows);
  const textOf = (id: string): string | null => {
    const fact = byId.get(id);
    return fact !== undefined && known.has(id)
      ? (employee.beliefs?.[id] ?? factText(fact))
      : null;
  };
  return employee.knows.flatMap((id): SliceFact[] => {
    const fact = byId.get(id);
    if (fact === undefined) {
      return [];
    }
    const belief = employee.beliefs?.[id];
    return [
      {
        id,
        type: fact.type,
        text: belief ?? factText(fact),
        outdated: belief !== undefined,
        ...(fact.role === undefined ? {} : { who: roleName(key, fact.role) }),
        ...(fact.system === undefined ? {} : { system: fact.system }),
        ...(fact.condition === undefined ? {} : { condition: fact.condition }),
        ...(fact.where === undefined ? {} : { where: fact.where }),
        ...(fact.unit === undefined ? {} : { unit: fact.unit }),
        ...amountsOf(fact, employee.remembers?.[id]),
        next: (fact.next ?? []).flatMap((to) => textOf(to) ?? []),
        options: Object.entries(fact.branches ?? {}).map(([answer, to]) => ({
          answer,
          leads: textOf(to),
        })),
        after: fact.after === undefined ? null : textOf(fact.after),
        toldWhen: fact.toldWhen ?? toldWhenOf[fact.type] ?? null,
      },
    ];
  });
};

/** The colleagues someone names, as "Name (role)". */
export const colleaguesOf = (key: AnswerKey, employee: KeyEmployee): string[] =>
  (employee.mentions ?? []).flatMap((id) => {
    const other = key.employees.find((each) => each.id === id);
    return other === undefined
      ? []
      : [`${other.name} (${roleName(key, other.role)})`];
  });

/** What is wrong with the facts of a key, in plain sentences. */
const factProblems = (key: AnswerKey, ids: ReadonlySet<string>): string[] =>
  key.facts.flatMap((fact) => {
    const problems: string[] = [];
    const says =
      fact.type === "term"
        ? fact.term !== undefined && fact.meaning !== undefined
        : fact.text !== undefined && fact.text !== "";
    if (!says) {
      problems.push(`Fact ${fact.id} says nothing.`);
    }
    if (fact.type === "number" && fact.value === undefined) {
      problems.push(`Number ${fact.id} has no value.`);
    }
    if (fact.role !== undefined && key.roles[fact.role] === undefined) {
      problems.push(`Fact ${fact.id} names the unknown role ${fact.role}.`);
    }
    const leads = [
      ...(fact.next ?? []),
      ...Object.values(fact.branches ?? {}),
      ...(fact.after === undefined ? [] : [fact.after]),
      ...(fact.of === undefined ? [] : [fact.of]),
    ];
    for (const to of leads) {
      if (!ids.has(to)) {
        problems.push(`Fact ${fact.id} leads to ${to}, which is not there.`);
      }
    }
    return problems;
  });

/** What is wrong with the people of a key, in plain sentences. */
const peopleProblems = (key: AnswerKey, ids: ReadonlySet<string>): string[] => {
  const people = new Set(key.employees.map((employee) => employee.id));
  const problems: string[] = [];
  if (!people.has(key.startWith)) {
    problems.push(`The first person, ${key.startWith}, is not in the list.`);
  }
  for (const employee of key.employees) {
    if (key.roles[employee.role] === undefined) {
      problems.push(`${employee.name} has the unknown role ${employee.role}.`);
    }
    for (const id of employee.knows) {
      if (!ids.has(id)) {
        problems.push(`${employee.name} knows ${id}, which is not there.`);
      }
    }
    const held = [
      ...Object.keys(employee.remembers ?? {}),
      ...Object.keys(employee.beliefs ?? {}),
    ];
    for (const id of held) {
      if (!employee.knows.includes(id)) {
        problems.push(
          `${employee.name} remembers or believes ${id} without knowing it.`
        );
      }
    }
    for (const id of employee.mentions ?? []) {
      if (!people.has(id)) {
        problems.push(`${employee.name} names ${id}, who is not in the list.`);
      }
    }
  }
  return problems;
};

/** What is wrong with a key, in plain sentences: nothing when it can be used. */
export const problemsIn = (key: AnswerKey): string[] => {
  const ids = new Set<string>();
  const twice: string[] = [];
  for (const fact of key.facts) {
    if (ids.has(fact.id)) {
      twice.push(`Fact ${fact.id} is there twice.`);
    }
    ids.add(fact.id);
  }
  const known = new Set(key.employees.flatMap((employee) => employee.knows));
  return [
    ...twice,
    ...factProblems(key, ids),
    ...peopleProblems(key, ids),
    ...key.facts
      .filter((fact) => !known.has(fact.id))
      .map((fact) => `Nobody knows fact ${fact.id}.`),
  ];
};
