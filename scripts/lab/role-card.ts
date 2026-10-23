/**
 * A role card: what a person who plays an employee reads before they talk
 * to Stephen. It holds their slice of an answer key in plain words, and
 * how to play it. Pure: the text of a card follows from the key alone.
 * Ported from the prototype (grasplabs/prototype, packages/grasp:
 * lab/role-card.ts).
 */
import { colleaguesOf, roleName, sliceOf } from "./keys/types.ts";
import type { AnswerKey, KeyEmployee, SliceFact } from "./keys/types.ts";

/** One part of a card: a heading and its lines. */
export interface CardPart {
  title: string;
  lines: string[];
}

export interface RoleCard {
  name: string;
  /** Who they are, in one sentence. */
  who: string;
  /** What Stephen will ask them about. */
  about: string;
  rules: string[];
  parts: CardPart[];
}

const rulesFor = (first: string): string[] => [
  `Read this card once. Then answer from memory, as ${first} would on a busy day. Look again only when you are stuck.`,
  "Say only what is on this card. When Stephen asks about something that is not here, say you do not know, and who might.",
  "Do not give it all at once. Tell your steps as a story, and let him ask for the rest.",
  "Say the numbers as they are written here: rounded and unsure.",
  "When he reads back what he wrote down, put right what is wrong and add what he missed.",
];

const withDetail = (text: string, details: (string | undefined)[]): string => {
  const said = details.filter(
    (detail): detail is string => detail !== undefined && detail !== ""
  );
  return said.length > 0 ? `${text} (${said.join("; ")})` : text;
};

/** Where it is done, unless the sentence says so already. */
const inSystem = (fact: SliceFact): string | undefined =>
  fact.system !== undefined &&
  !fact.text.toLowerCase().includes(fact.system.toLowerCase())
    ? `in ${fact.system}`
    : undefined;

const unstopped = (text: string): string =>
  text.endsWith(".") ? text.slice(0, -1) : text;

const stepLine = (fact: SliceFact): string => {
  if (fact.type === "decision") {
    return withDetail(fact.text, [
      fact.options
        .map(
          (option) =>
            `${option.answer}: ${option.leads ?? "you do not know what happens then"}`
        )
        .join(" / "),
    ]);
  }
  return withDetail(fact.text, [
    inSystem(fact),
    fact.howLong === undefined ? undefined : `takes ${fact.howLong}`,
  ]);
};

/** The card of one employee of a key. `lead` is the team lead the lab gave the team. */
export const roleCardOf = (
  key: AnswerKey,
  employee: KeyEmployee,
  lead: string
): RoleCard => {
  const slice = sliceOf(key, employee);
  const of = (...types: SliceFact["type"][]) =>
    slice.filter((fact) => types.includes(fact.type));
  const first = employee.name.split(" ")[0] ?? employee.name;
  const parts: CardPart[] = [
    {
      title: "What you do, in order",
      lines: of("trigger", "step", "decision").map(stepLine),
    },
    {
      title: "When it goes differently",
      lines: of("exception").map((fact) =>
        withDetail(fact.text, [
          fact.condition === undefined
            ? undefined
            : `when: ${unstopped(fact.condition)}`,
          fact.howOften === undefined ? undefined : `about ${fact.howOften}`,
          inSystem(fact),
        ])
      ),
    },
    {
      title: "How you decide",
      lines: of("judgment").map((fact) => fact.text),
    },
    {
      title: "When you stop and ask someone",
      lines: of("stop").map((fact) => fact.text),
    },
    {
      title: "Where it waits",
      lines: of("wait").map((fact) =>
        withDetail(fact.text, [
          fact.howLong === undefined ? undefined : `about ${fact.howLong}`,
        ])
      ),
    },
    {
      title: "Your numbers, as you remember them",
      lines: of("number").map(
        (fact) => `${fact.text}: ${fact.remembered ?? ""}`
      ),
    },
    {
      title: "Your own lists and tools",
      lines: of("workaround", "ai_use").map((fact) =>
        withDetail(fact.text, [inSystem(fact)])
      ),
    },
    {
      title: "Done another way somewhere",
      lines: of("variant").map((fact) =>
        withDetail(fact.text, [
          fact.where === undefined ? undefined : `at ${fact.where}`,
        ])
      ),
    },
    { title: "Words you use", lines: of("term").map((fact) => fact.text) },
    { title: "When it is done", lines: of("done").map((fact) => fact.text) },
    { title: "People you work with", lines: colleaguesOf(key, employee) },
  ];
  return {
    name: employee.name,
    who: `You are ${employee.name}, ${roleName(key, employee.role).toLowerCase()}${employee.office === undefined ? "" : ` at the ${employee.office} office`} of ${key.company.name} (${key.company.sector.toLowerCase()}, about ${key.company.size} people). Your team lead is ${lead.split(" ")[0] ?? lead}.`,
    about: `Stephen asks you about: ${key.name.toLowerCase()}.`,
    rules: rulesFor(first),
    parts: parts.filter((part) => part.lines.length > 0),
  };
};

/** A card as plain text, with its link: to paste into a message to whoever plays it. */
export const cardText = (card: RoleCard, link?: string): string =>
  [
    card.who,
    card.about,
    "",
    "How to play",
    ...card.rules.map((rule, at) => `${at + 1}. ${rule}`),
    ...card.parts.flatMap((part) => [
      "",
      part.title,
      ...part.lines.map((line) => `- ${line}`),
    ]),
    ...(link === undefined
      ? []
      : [
          "",
          `Your interview: ${link}`,
          "It takes 10 to 15 minutes, by voice or by typing. Nothing here is real: the company and the work are made up for practice.",
        ]),
  ].join("\n");
