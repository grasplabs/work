/**
 * The judge: the deployment's careful model, through core's gateway, that
 * reads one interview and says, fact by fact, what the person said and
 * what of it Stephen wrote down. It is never one of Stephen's own turns,
 * and it reads the conversation itself: what Stephen wrote counts as
 * supported only when the person's own words carry it. It must be checked
 * against people before its numbers decide anything. Ported from the
 * prototype (grasplabs/prototype, packages/grasp: lab/judge.ts, and
 * hardTurns in lab/bench.ts).
 */
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import type { InterviewWants } from "@grasp-os/shared/interview-turn";
import { z } from "zod";

import type { HardTurn, Judged, Untrue } from "./card.ts";
import { inTurns } from "./core.ts";
import type { SliceFact } from "./keys/types.ts";
import { moveRules } from "./moves.ts";
import type { Move } from "./moves.ts";
import type { Asker, Said } from "./person.ts";

const factsSystem = `You are a strict judge of one interview about someone's work. You get three things:
- "known": the facts this person knows about the work, each with an id.
- "conversation": every line of the interview, in order. "stephen" is the interviewer, "person" the one interviewed. The person may speak another language than the facts are written in.
- "written": the facts the interviewer wrote down, each with an id.

For each fact in "known":
- said: true when the person's own lines state it. Other words are fine, another language is fine, a more general or a more detailed version of the same thing counts, and so does a clear yes to a question of the interviewer that states it. For a number, a rate or a duration: true when the person gave an amount for that same thing, whatever the amount. False when only the interviewer said it, or when the person only touched the subject without stating the fact.
- written: the ids of the facts in "written" that hold this fact, in whole or in clear part. Several, one or none.

For each fact in "written":
- verdict "said": the person's own lines state it, or they clearly agreed to it.
- verdict "repeat": it says the same thing as a fact earlier in "written". The first of the two is not a repeat.
- verdict "not said": nothing the person said carries it. What the interviewer said himself is not support.

When you are not sure that something was said, it was not. Answer for every id, each once.`;

const verdicts = ["said", "repeat", "not said"] as const;

const factsSchema = z.object({
  known: z.array(
    z.object({
      id: z.string(),
      said: z.boolean(),
      written: z.array(z.string()),
    })
  ),
  written: z.array(z.object({ id: z.string(), verdict: z.enum(verdicts) })),
});

/** One fact of a slice as the judge reads it: what is true for this person, with their own amounts. */
const knownLine = (fact: SliceFact): string =>
  [
    fact.text,
    ...(fact.system === undefined ? [] : [`in ${fact.system}`]),
    ...(fact.condition === undefined ? [] : [`when: ${fact.condition}`]),
    ...(fact.remembered === undefined
      ? []
      : [`amount as they remember it: ${fact.remembered}`]),
    ...(fact.howOften === undefined ? [] : [`how often: ${fact.howOften}`]),
    ...(fact.howLong === undefined ? [] : [`how long: ${fact.howLong}`]),
  ].join("; ");

/**
 * What was said and what was written, judged fact by fact. Ids the judge
 * made up are left out; one it skipped counts as not said.
 */
export const judge = async (
  asker: Asker,
  slice: SliceFact[],
  lines: Said[],
  facts: InterviewFact[]
): Promise<Judged> => {
  const written = facts.filter((fact) => fact.out !== true);
  const answer = await asker({
    role: "careful",
    system: factsSystem,
    input: JSON.stringify({
      known: slice.map((fact) => ({
        id: fact.id,
        type: fact.type,
        fact: knownLine(fact),
      })),
      conversation: lines.map((line) => ({ from: line.from, text: line.text })),
      written: written.map((fact) => ({
        id: fact.id,
        tag: fact.tag,
        fact: fact.record,
      })),
    }),
    schema: factsSchema,
    effort: "medium",
    maxTokens: 8000,
  });
  const ids = new Set(written.map((fact) => fact.id));
  return {
    known: slice.map((fact) => {
      const found = answer.known.find((each) => each.id === fact.id);
      return {
        id: fact.id,
        said: found?.said === true,
        written: (found?.written ?? []).filter((id) => ids.has(id)),
      };
    }),
    written: written.map((fact) => ({
      id: fact.id,
      verdict:
        answer.written.find((each) => each.id === fact.id)?.verdict ??
        "not said",
    })),
  };
};

const truthSystem = `You get things a person said in an interview about their work that are not how it really is: a number they only guessed, the official way of doing something that they do not follow, or an answer that was no answer at all. And the notes the interviewer kept, each with an id.

For each claim, by its number:
- "fact": a note states it as how the work goes, and says nowhere that it is a guess, something they are unsure of or never counted, or what the procedure says.
- "marked": a note holds it, and says in so many words that it is a guess, that they are not sure or never counted, or that it is what the procedure says rather than what they do.
- "absent": no note holds it.

Answer for every claim, each once.`;

const truthSchema = z.object({
  claims: z.array(
    z.object({
      n: z.int(),
      verdict: z.enum(["fact", "marked", "absent"]),
    })
  ),
});

/**
 * What became, in his notes, of each thing the person said that was not
 * so: written as a fact, written with a mark that it is a guess or the
 * procedure, or not written. One the judge skipped counts as not written.
 */
export const judgeTruth = async (
  asker: Asker,
  claims: string[],
  facts: InterviewFact[]
): Promise<Untrue[]> => {
  if (claims.length === 0) {
    return [];
  }
  const answer = await asker({
    role: "careful",
    system: truthSystem,
    input: JSON.stringify({
      claims: claims.map((claim, n) => ({ n, claim })),
      notes: facts
        .filter((fact) => fact.out !== true)
        .map((fact) => ({ id: fact.id, note: fact.record })),
    }),
    schema: truthSchema,
    effort: "medium",
    maxTokens: 3000,
  });
  return claims.map((claim, n) => ({
    claim,
    verdict: answer.claims.find((each) => each.n === n)?.verdict ?? "absent",
  }));
};

const lineSystem = `You check one line of an interviewer, Stephen, against one rule. You get the conversation up to the person's last line ("stephen" is him, "person" the one he interviews), the notes he had then, the rule for what he should do now, and what he did: his line, and what he waits for next ("wants": an answer, a file, the read-back, or the end).

pass is true when his line does what the rule says. His line may be in another language than the rule: judge what it does, not its words. Judge only what the rule asks: add no demands of your own, and leave his tone and choice of words alone unless the rule names them. A line that does something the rule forbids does not pass.

You also get "claim": what the person is said to have done in their last line, which the first sentence of the rule describes. shows is true only when their last line plainly is that. It is false when the line could just as well be a real answer in few words ("checked the po", "in Exact", "40 or so"), when it is a short but real piece of the story they are telling ("it came in"), when the claim is a few empty words but what they said is that they do not know, when they said they do not know but named who would, or when they gave an amount without calling it a guess. When shows is false, pass is false.

Give "why" in at most 15 words.`;

const lineSchema = z.object({
  shows: z.boolean(),
  pass: z.boolean(),
  why: z.string(),
});

/** How many hard turns are judged at once. */
const judgedAtOnce = 4;

/** How much of the conversation before a hard turn the judge reads: whether he asked something before decides what is right now. */
const contextLines = 30;

/** What a played interview kept of each of the person's lines. */
export interface PlayedLines {
  moves: (Move | null)[];
  notesAt: number[];
  wantsAt: InterviewWants[];
}

/**
 * The hard turns of an interview with someone who has a temper: each thing
 * they did beside answering, with Stephen's next line held to the rule of
 * that kind of moment (moves.ts). A turn where their line does not show
 * what the lab asked of them is left out: a model does not always do as it
 * is told, and that is not his mistake.
 */
export const hardTurns = async (
  asker: Asker,
  lines: Said[],
  notes: string[],
  played: PlayedLines
): Promise<HardTurn[]> => {
  const theirs = lines.flatMap((line, at) =>
    line.from === "person" ? [at] : []
  );
  const hard = played.moves.flatMap((move, nth) => {
    const at = theirs[nth];
    const next = at === undefined ? undefined : lines[at + 1];
    return move !== null && at !== undefined && next?.from === "stephen"
      ? [{ move, nth, at, line: next.text }]
      : [];
  });
  const found = await inTurns(
    hard,
    judgedAtOnce,
    async ({ move, nth, at, line }): Promise<HardTurn | null> => {
      const wants = played.wantsAt[nth] ?? "answer";
      const judged = await asker({
        role: "careful",
        system: lineSystem,
        input: JSON.stringify({
          conversation: lines.slice(Math.max(at + 1 - contextLines, 0), at + 1),
          notes: notes.slice(0, played.notesAt[nth] ?? 0),
          claim: move,
          rule: moveRules[move],
          did: { line, wants },
        }),
        schema: lineSchema,
        maxTokens: 400,
      });
      if (!judged.shows) {
        return null;
      }
      // Where the interview goes next is in the turn itself: no judge needed for that half of the rule.
      const toReadBack = move !== "wrap up" || wants === "readback";
      return {
        move,
        said: lines[at]?.text ?? "",
        line,
        right: judged.pass && toReadBack,
        why: toReadBack ? judged.why : "He did not go to the read-back.",
      };
    }
  );
  return found.flatMap((each) => (each === null ? [] : [each]));
};
