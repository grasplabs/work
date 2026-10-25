import type { StatementKind } from "@grasp-os/shared/brain";
import { brainStatementMaxLength } from "@grasp-os/shared/brain-records";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { minTeamShown } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { gatewaySettings, modelForRole, models } from "../models.ts";
import { statementKinds, withoutNames } from "./brain-intake.ts";
import type { Took } from "./store.ts";
import { NoDrawingModelError } from "./team-map.ts";

// What a team says, put together (GRA-1084): the brain's statements of a
// team are claims five or more of its people made, never one person's
// fact, even without their name. Members and admins read only these;
// staff read none (brain-rpc.ts).
//
// The careful model puts the facts together, because nobody waits for it.
// It sees each fact under a neutral label (`F3`) grouped by a neutral
// person (`Person 2`), never an id, a title or a name: the names on the
// staff list are taken out of every fact first. It says which facts each
// claim puts together, and the host, not the model, decides what reaches
// the brain (`claimsOf`): it counts the distinct people behind the facts
// cited that exist and are of the claim's kind, and keeps a claim only
// when that is at least `minTeamShown`. The model is never told the
// threshold, so it has nothing to stretch towards.
//
// Ways it can fail, each held by apps/core/test/brain-intake.test.ts:
// - a claim resting on fewer than five people, or on one person cited
//   five times;
// - a claim citing facts that don't exist, or facts of another kind;
// - a name or a person's id or title reaching the model or the brain;
// - no model, or one that fails: nothing is written, never a fact as its
//   own statement.
//
// What can't be checked mechanically: that a claim's words say no more
// than every fact it cites. The prompt forbids it.

/** What a team's claims are put together from. */
export interface ClaimBrief {
  /** Everyone on the staff list, by name: none reaches the model or the brain. */
  names: readonly string[];
  /** The facts each person who told their own work agreed to: never the lead. */
  tellers: readonly {
    person: string;
    facts: readonly { tag: FactTag; record: string }[];
  }[];
}

/** A claim of the team's, and the people it rests on: five or more. */
export interface TeamClaim {
  kind: StatementKind;
  text: string;
  /** Who said it: kept in the onboarding's own store, never in the brain. */
  people: string[];
}

/** A fact as the model is shown it, and whose it is. */
interface Labelled {
  label: string;
  person: string;
  kind: StatementKind;
  text: string;
}

const claimsSchema = z.object({
  claims: z
    .array(
      z.object({
        kind: z.string(),
        text: z.string(),
        facts: z.array(z.string()),
      })
    )
    .optional(),
});

export type RawClaims = z.output<typeof claimsSchema>;

const kinds = new Set<string>(Object.values(statementKinds));

const isKind = (kind: string): kind is StatementKind => kinds.has(kind);

const claimsSystem = `You are Grasp's analyst. People of one team each agreed to facts about their own work. Put together what they said: the claims the team makes. Write everything in English, plainly.

Answer in JSON with one field:
- claims: each claim the facts make, one each. kind: the kind of the facts it puts together, one of "tool", "handover", "blocker", "rule" or "wish". text: the claim, in one plain sentence. facts: the ids of every fact that says it ("F3").

Rules:
- A claim says only what every fact it cites says. Never a detail, a number, a tool or a reason that only some of them give.
- Cite a fact only when it says the claim. Never cite a fact to make a claim look shared.
- Put facts that say the same thing in other words into one claim.
- A fact may say something nobody else said: it is a claim of its own, citing that fact alone.
- Never a person's name, a role that points at one person, or a quote. Say "someone" for a person.
- Only the kind of the facts: a claim never puts facts of different kinds together.`;

/** The facts shown to the model, each by a neutral label, of the kinds enough people spoke to. */
const labelledOf = (brief: ClaimBrief): Labelled[] => {
  const clean = withoutNames(brief.names);
  const all = brief.tellers.flatMap(({ person, facts }) =>
    facts.flatMap(({ tag, record }) => {
      const kind = statementKinds[tag];
      const text = clean(record).replaceAll(/\s+/gu, " ").trim();
      return kind === undefined || text === "" ? [] : [{ person, kind, text }];
    })
  );
  // A kind fewer than five people spoke to can make no claim the brain
  // takes: the model isn't shown it at all.
  const peopleOf = new Map<StatementKind, Set<string>>();
  for (const { kind, person } of all) {
    peopleOf.set(kind, (peopleOf.get(kind) ?? new Set()).add(person));
  }
  return all
    .filter(({ kind }) => (peopleOf.get(kind)?.size ?? 0) >= minTeamShown)
    .map((fact, index) => ({ ...fact, label: `F${index + 1}` }));
};

/** What the model is asked: the facts by neutral labels, grouped by neutral people. */
const promptOf = (facts: readonly Labelled[]): string => {
  const people = [...new Set(facts.map(({ person }) => person))];
  return [
    "What each person agreed to:",
    ...people.flatMap((person, index) => [
      `## Person ${index + 1}`,
      ...facts
        .filter((fact) => fact.person === person)
        .map(({ label, kind, text }) => `- ${label} (${kind}) ${text}`),
      "",
    ]),
  ].join("\n");
};

/** A claim's words on one line, cut at a whole word to what a statement may hold. */
const lineOf = (value: string): string => {
  const line = value.replaceAll(/\s+/gu, " ").trim();
  if (line.length <= brainStatementMaxLength) {
    return line;
  }
  const cut = line.slice(0, brainStatementMaxLength - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
};

/**
 * The model's claims held to the rules: a claim's people are the distinct
 * people behind the facts it cites that exist and are of its kind; one
 * with fewer than `minTeamShown` is left out, as is one of no statement
 * kind or with no words left once names are taken out. The same claim
 * twice is one, resting on everyone behind either.
 */
const claimsOf = (
  raw: RawClaims,
  facts: readonly Labelled[],
  names: readonly string[]
): TeamClaim[] => {
  const clean = withoutNames(names);
  const byLabel = new Map(facts.map((fact) => [fact.label, fact]));
  const claims = new Map<string, TeamClaim>();
  for (const { kind, text, facts: cited } of raw.claims ?? []) {
    if (!isKind(kind)) {
      continue;
    }
    const said = lineOf(clean(text));
    if (said === "") {
      continue;
    }
    const people = cited.flatMap((label) => {
      const fact = byLabel.get(label.trim());
      return fact === undefined || fact.kind !== kind ? [] : [fact.person];
    });
    const key = `${kind}\u0000${said}`;
    const held = claims.get(key);
    claims.set(key, {
      kind,
      text: said,
      people: [...new Set([...(held?.people ?? []), ...people])],
    });
  }
  return [...claims.values()].filter(
    ({ people }) => people.length >= minTeamShown
  );
};

/**
 * A team's claims, put together by the careful model through the gateway
 * from what its people agreed to: only those five or more of them made.
 * None, and no call, when no kind of fact was spoken to by five. Throws
 * when no model may do it, so the intake is tried again and never falls
 * back to the facts themselves.
 */
export const teamClaims = async (
  env: Env,
  brief: ClaimBrief,
  count: (took: Took) => void
): Promise<TeamClaim[]> => {
  const facts = labelledOf(brief);
  if (facts.length === 0) {
    return [];
  }
  const model = modelForRole(gatewaySettings(env), "careful", {
    sensitive: true,
  });
  if (model === undefined) {
    throw new NoDrawingModelError(
      "No model may put the team's claims together."
    );
  }
  const { output, usage } = await models(env).call({
    model,
    purpose: "onboarding.claims",
    trigger: { type: "system" },
    work: { onboarding: true },
    effort: "medium",
    system: claimsSystem,
    input: promptOf(facts),
    schema: claimsSchema,
    maxTokens: 8000,
  });
  count({
    purpose: "drawing",
    model,
    tokensIn: usage.inputTokens,
    tokensCached: usage.cacheRead,
    tokensOut: usage.outputTokens,
  });
  return claimsOf(output, facts, brief.names);
};
