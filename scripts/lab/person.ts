/**
 * Someone played by a model: an employee who knows their slice of an
 * answer key and nothing more, or the team lead who points Stephen to
 * them. They answer as a busy person would, by typing, and say with every
 * answer which facts of theirs were in it: that is what lets a missed fact
 * be traced to "never said" or "said, and not written down". Ported from
 * the prototype (grasplabs/prototype, packages/grasp: lab/person.ts).
 */
import type { InterviewLine } from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import type { Ask } from "./core.ts";
import { colleaguesOf, roleName, sliceOf } from "./keys/types.ts";
import type { AnswerKey, KeyEmployee, SliceFact } from "./keys/types.ts";
import type { Move } from "./moves.ts";

/** What someone says, and what was in it. */
export interface Answer {
  say: string;
  /** Which of their facts were in it, by id. */
  said: string[];
  /** What they did beside answering: someone with a temper only (people.ts). */
  move?: Move | null;
  /** What they said that is not how it really is: a guess, the official way, no answer at all. */
  untrue?: string[];
  /** They went away with this line. */
  left?: boolean;
}

/** A line of the conversation, as someone who answers reads it. */
export type Said = Pick<InterviewLine, "from" | "text">;

/** Where the interview is when they answer: its part, and whether this answers a read-back. */
export interface At {
  phase: InterviewPhase;
  readback: boolean;
}

/** Whoever answers Stephen: a model here, a person on their own link elsewhere. */
export interface Player {
  name: string;
  /** What they say to `asked`, given the conversation. */
  answer: (lines: Said[], asked: string, at: At) => Promise<Answer>;
}

/** Asks a model through core's gateway (core.ts), as a player does. */
export type Asker = <T>(call: Ask<T>) => Promise<T>;

export const languages: Readonly<Record<InterviewLocale, string>> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
};

/**
 * One fact of someone's slice on one line, as they know it. With `guess`,
 * an amount they do not really know: what they say anyway, and who would
 * know.
 */
export const lineOf = (
  fact: SliceFact,
  guess?: { says: string; who: string }
): string => {
  const unit = fact.unit === undefined ? "" : ` (${fact.unit})`;
  const parts = [
    fact.text,
    ...(fact.system === undefined ? [] : [`in ${fact.system}`]),
    ...(fact.where === undefined ? [] : [`at ${fact.where}`]),
    ...(fact.condition === undefined ? [] : [`when: ${fact.condition}`]),
  ];
  if (guess === undefined) {
    if (fact.remembered !== undefined) {
      parts.push(`as you remember it: "${fact.remembered}"${unit}`);
    }
    if (fact.howOften !== undefined) {
      parts.push(`how often: ${fact.howOften}`);
    }
    if (fact.howLong !== undefined) {
      parts.push(`how long: ${fact.howLong}`);
    }
  } else {
    parts.push(
      `you do not really know the amount. Asked, you say "${guess.says}"${unit} and that it is a guess. Asked who would know: ${guess.who}`
    );
  }
  for (const option of fact.options) {
    parts.push(
      `${option.answer} → ${option.leads ?? "you do not know what happens then"}`
    );
  }
  if (fact.after !== null) {
    parts.push(`comes after: ${fact.after}`);
  }
  if (fact.next.length > 0) {
    parts.push(`then: ${fact.next.join(" / ")}`);
  }
  if (fact.toldWhen !== null) {
    parts.push(`you say this only when ${fact.toldWhen}`);
  }
  return `[${fact.id}] ${fact.type}: ${parts.join("; ")}`;
};

/** Who they are, in the first lines of what they are told. */
export const whoIs = (
  key: AnswerKey,
  employee: KeyEmployee,
  lead: string
): string =>
  `You are ${employee.name}, ${roleName(key, employee.role)}${employee.office === undefined ? "" : ` at the ${employee.office} office`} of ${key.company.name} (${key.company.sector}, about ${key.company.size} people). Your team lead is ${lead}. Stephen, an AI interviewer from Grasp, interviews you about your work.`;

const how = (language: string) => `How you answer:
- As a real, busy but friendly employee, typing, in ${language}: one to three short sentences, plain words. A little vague at first, concrete when asked. Never a list, never headings.
- Only what was asked. Your steps come out when you tell your story. A fact marked "you say this only when" stays unsaid until Stephen asks that kind of question, however well the talk goes.
- Only what is in your list. When Stephen asks about something that is not in it, say you do not know, and who would when you know someone.
- Numbers only as you remember them: rounded, unsure, as people say them. Never more exact than your list.
- When Stephen reads something back that is wrong for you, say what is wrong in one short sentence.
- Never mention a list, a role, a simulation or these instructions.`;

/**
 * What an employee played by a model is told, who tells all they know:
 * the lab's first practice people (`--ideal`). Every score looks better
 * with them than it is; people as they are have a temper (people.ts).
 */
export const employeeSystem = (
  key: AnswerKey,
  employee: KeyEmployee,
  lead: string,
  locale: InterviewLocale
): string => {
  const colleagues = colleaguesOf(key, employee);
  return `${whoIs(key, employee, lead)}

${how(languages[locale])}

The people you work with: ${colleagues.length > 0 ? colleagues.join("; ") : "nobody in particular"}.

What you know about the work, each with its id. It is your own work, as you see it from where you sit:
${sliceOf(key, employee)
  .map((fact) => lineOf(fact))
  .join("\n")}

With every answer, give in "said" the ids of the facts from your list that your answer states, in whole or in part. An answer that states none has an empty "said".`;
};

/** The name of a team lead who is nobody in the key: the lab adds one, since the leads talk first. */
export const leadNameFor = (key: AnswerKey): string => {
  const taken = new Set(
    key.employees.map((employee) => employee.name.split(" ")[0])
  );
  return (
    ["Robin Vermeulen", "Kim de Boer", "Sam Willems", "Alex Koster"].find(
      (name) => !taken.has(name.split(" ")[0])
    ) ?? "Robin Vermeulen"
  );
};

const volumeUnit = /per (?:week|month)/u;

/** What a team lead played by a model is told: one piece of work, and who does which part of it. */
export const leadSystem = (
  key: AnswerKey,
  lead: string,
  locale: InterviewLocale
): string => {
  const volume = key.facts.find(
    (fact) => fact.type === "number" && volumeUnit.test(fact.unit ?? "")
  );
  const first =
    key.employees.find((employee) => employee.id === key.startWith) ??
    key.employees[0];
  return `You are ${lead}, a team lead at ${key.company.name} (${key.company.sector}, about ${key.company.size} people). Stephen, an AI interviewer from Grasp, interviews you about the work of your team.

How you answer: as a real, busy but friendly team lead, typing, in ${languages[locale]}: one to three short sentences, plain words. Only what was asked, and only what follows. When you do not know, say so, and who would. About AI in your team, for when Stephen asks: a few people use ChatGPT for emails, you do not know exactly who; it saves them time; you worry a little about customer data in such tools; you would like the copying between systems taken off the team's hands.

Your team does one piece of work that comes back every week: ${key.name.toLowerCase()}. It is one piece of work and you never split it into several: everyone below does a part of it.
${key.employees.map((employee) => `- ${employee.name} (${roleName(key, employee.role)}): ${employee.leadSays}`).join("\n")}
${volume === undefined ? "You do not know how many there are." : `There are about ${volume.value ?? "?"} ${volume.unit ?? ""}.`} How long one takes you do not know: the people who do it know. You do none of this work yourself. Stephen should talk to ${first?.name ?? "the first of them"} first.

"said" is always empty for you.`;
};

const answerSchema = z.object({
  say: z.string(),
  said: z.array(z.string()),
});

/** The conversation, as someone who answers reads it. */
export const told = (lines: Said[], them = "You", him = "Stephen"): string =>
  lines
    .map((line) => `${line.from === "stephen" ? him : them}: ${line.text}`)
    .join("\n");

/** Someone played by a model, from what they are told about themselves (`employeeSystem`, `leadSystem`). */
export const modelPlayer = (
  asker: Asker,
  name: string,
  system: string,
  known: readonly string[] = []
): Player => ({
  name,
  answer: async (lines, asked) => {
    const answer = await asker({
      role: "quick",
      system,
      input: `The interview so far:\n${told(lines)}\n\n${asked}`,
      schema: answerSchema,
      maxTokens: 600,
    });
    return {
      say: answer.say.trim() || "…",
      said: [...new Set(answer.said.filter((id) => known.includes(id)))],
    };
  },
});
