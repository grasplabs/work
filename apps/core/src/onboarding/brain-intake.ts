import type { WorkflowState } from "@grasp-os/shared/admin/interviews";
import { dayOf } from "@grasp-os/shared/admin/org-record";
import type { DrawnWork, Told } from "@grasp-os/shared/admin/org-record";
import type { StatementKind } from "@grasp-os/shared/brain";
import {
  brainRecordSchema,
  onboardingIdPrefix,
} from "@grasp-os/shared/brain-records";
import type {
  BrainRecord,
  BrainRecordInput,
  WorkflowVersionRecord,
} from "@grasp-os/shared/brain-records";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { minTeamShown } from "@grasp-os/shared/onboarding";

import type { Support } from "./drawing-support.ts";
import type { TeamClaim } from "./team-claims.ts";

// What the onboarding learned, as the brain's records (GRA-367): each
// team as a team record, one source for all its interviews, what five or
// more of its people said, put together, as statements (GRA-1084,
// team-claims.ts), and each piece of work as a workflow
// with every drawing a new version. Decided in GRA-359: nothing in them
// points at one person. So:
//
// - No source per person: one per team, served live by the brain
//   (brain-rpc.ts) with how many people it rests on, never who.
// - A statement is a claim of the team's that five or more of its people
//   made, never one person's fact, nor their words (`text`) or quote;
//   never resting on the lead, whose role alone says who they are; and a
//   name on the staff list in it is taken out.
// - A drawing keeps no `from` and no `told`: its numbers are ranges over
//   everyone who gave one, and how many did, never whose; and only what
//   five or more of its people told, each part apart (`versionOf`,
//   GRA-1084).
// - A team reaches the brain only once `minTeamShown` (five) of its people
//   agreed, as many as the company's numbers need and the interview's
//   notice promises (GRA-329); the store holds it back until then.
//
// Who each record rests on is kept apart, in the onboarding's own store
// (`brain_sent`), so deleting an interview can find what it is in
// (GRA-368, the store's `purgeBrain`): the brain itself never holds it.

/** The staff list, as the source the brain found each team in. */
export const rosterSource = "src-roster";

/** An id the onboarding owns, from what it stands for: the same thing is the same id. */
const ownId = async (kind: string, ...parts: string[]): Promise<string> => {
  const hash = await sha256Hex(parts.join("\u0000"));
  return `${onboardingIdPrefix}${kind}-${hash.slice(0, 32)}`;
};

/** The brain's ids for what the onboarding gives it. */
export const intakeIds = {
  /** A roster team, as the brain names it, and its team record. */
  team: (team: string): string => `team-${team}`,
  /** The source that stands for all of a team's interviews. */
  interviews: async (team: string): Promise<string> => await ownId("src", team),
  statement: async (
    team: string,
    kind: StatementKind,
    text: string
  ): Promise<string> => await ownId("st", team, kind, text),
  workflow: async (team: string, work: string): Promise<string> =>
    await ownId("wf", team, work),
};

/** The brain's statement kind for each fact tag that is one; the rest are the drawing's. */
export const statementKinds: Partial<Record<FactTag, StatementKind>> = {
  system: "tool",
  workaround: "tool",
  ai: "tool",
  handoff: "handover",
  next: "handover",
  wait: "blocker",
  rule: "rule",
  wish: "wish",
};

/** What a team gives the brain, from the store. */
export interface TeamIntake {
  team: { id: string; name: string };
  /** Everyone on the staff list, by name: no record says one. */
  names: string[];
  /** The facts each person who told their own work agreed to, never the lead's: what its claims are put together from. */
  tellers: { person: string; facts: { tag: FactTag; record: string }[] }[];
  /** Its pieces of work as drawn, each with who it rests on besides the people it was drawn from. */
  works: {
    id: string;
    name: string;
    local: string;
    one: string;
    drawn: DrawnWork;
    state: WorkflowState;
    /** Who named it: the lead, when the team has one. */
    namedBy: string[];
    /** Whose facts it was drawn with as context: the lead's. */
    context: string[];
  }[];
}

/** One record and the person it rests on: what deleting their interview takes out. */
export interface Rest {
  record: string;
  type: BrainRecord["type"];
  person: string;
  /** A drawing's workflow: it goes once none of its drawings is left. */
  parent?: string;
}

/** The records a team gives the brain, in the order they may be kept, and who each rests on. */
export interface Intake {
  records: BrainRecord[];
  rests: Rest[];
}

const escaped = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * Takes the names on the staff list out of a text: each first and last
 * name, as a whole word, becomes "someone". A word that is also a name
 * ("Mark") goes too: better a word lost than a name kept.
 */
export const withoutNames = (
  names: readonly string[]
): ((text: string) => string) => {
  const words = [
    ...new Set(
      names.flatMap((name) =>
        name.split(/\s+/u).filter((word) => word.length >= 2)
      )
    ),
  ];
  if (words.length === 0) {
    return (text) => text;
  }
  const named = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.map(escaped).join("|")})(?![\\p{L}\\p{N}])`,
    "gu"
  );
  return (text) => {
    const said = text.replaceAll(named, "someone");
    // A sentence that started with a name starts with a capital still.
    return said.startsWith("someone") && !text.startsWith("someone")
      ? `S${said.slice(1)}`
      : said;
  };
};

/** The median of some numbers, the lower of the middle two; none of none. */
const medianOf = (values: readonly number[]): number | undefined =>
  values.toSorted((x, y) => x - y)[Math.floor((values.length - 1) / 2)];

/** A median of some numbers, when five or more gave one: what one of them gave never shows. */
const shownMedian = (values: readonly number[]): number | null =>
  values.length >= minTeamShown ? (medianOf(values) ?? null) : null;

/** How often, by whose count it is: a median of quiet and of busy, each over five or more. */
const volumesOf = (
  told: readonly Told[],
  per: DrawnWork["per"]
): WorkflowVersionRecord["volumes"] =>
  (["me", "team", "unknown"] as const).flatMap((of) => {
    const said = told.flatMap(({ volume, volumeOf }) =>
      volume !== null && (volumeOf ?? "unknown") === of ? [volume] : []
    );
    const low = shownMedian(said.map(([quiet]) => quiet));
    const high = shownMedian(said.map(([, busy]) => busy));
    return low === null || high === null
      ? []
      : [
          {
            of,
            per,
            low,
            high: Math.max(low, high),
            people: said.length,
            basis: "estimated" as const,
          },
        ];
  });

/**
 * A drawing as the brain keeps it (GRA-1084): only the parts five or more
 * of the people it was drawn from are checked to have told
 * (drawing-support.ts), in their bare words without a name, and what came
 * with them (who and with what, what is done in a case, what a term
 * means, why a step differs) left out. Each number is a median over five
 * or more who gave it, the lead never among them: a step's minutes and a
 * case's share over the people the part rests on, how often, how long and
 * how many come in wrong over the people it was drawn from. What the next
 * interviews should ask is never the brain's: it is written from what few
 * said.
 */
const versionOf = (
  work: TeamIntake["works"][number],
  clean: (text: string) => string,
  support: Support
): Omit<WorkflowVersionRecord, "id" | "workflowId" | "sourceId"> => {
  const { drawn } = work;
  const lead = new Set(work.namedBy);
  const tellers = Object.entries(drawn.told).filter(
    ([person]) => !lead.has(person)
  );
  const told = tellers.map(([, each]) => each);
  const toldOf = (people: readonly string[]): Told[] =>
    tellers.flatMap(([person, each]) =>
      people.includes(person) ? [each] : []
    );
  const shown = (people: readonly string[], text: string): string =>
    people.length >= minTeamShown ? clean(text) : "";
  // The steps five or more are checked to have told, and where each step
  // of the drawing lands among them: a case off the path after a step left
  // out follows the last step kept before it.
  const kept = drawn.steps.flatMap((step, index) => {
    const people = support.steps[index] ?? [];
    return people.length >= minTeamShown ? [{ step, index, people }] : [];
  });
  const placeOf = (index: number): number =>
    Math.max(kept.filter((each) => each.index <= index).length - 1, 0);
  const takes = told.flatMap(({ takes: own }) => (own === null ? [] : [own]));
  const wrong = shownMedian(
    told.flatMap(({ wrong: own }) => (own === null ? [] : [own]))
  );
  const quickest = shownMedian(takes.map(([each]) => each));
  const longest = shownMedian(takes.map((each) => each[2]));
  const { differs } = drawn;
  const differsKept =
    differs !== null &&
    kept.some(({ index }) => index === differs.step) &&
    support.other.length >= minTeamShown;
  return {
    type: "workflowVersion",
    date: dayOf(drawn.at),
    state: work.state,
    people: drawn.from.length,
    starts: shown(support.starts, drawn.starts),
    steps: kept.map(({ step: { text, documented }, index, people }) => {
      const minutes = shownMedian(
        toldOf(people).flatMap(({ stepMinutes }) =>
          (stepMinutes ?? []).flatMap(({ step, minutes: own }) =>
            step === index ? [own[1]] : []
          )
        )
      );
      return {
        text: clean(text),
        who: "",
        tool: "",
        minutes:
          minutes === null
            ? null
            : {
                quickest: minutes,
                normal: minutes,
                longest: minutes,
                basis: "estimated" as const,
              },
        documented,
      };
    }),
    waits: drawn.waits.flatMap((wait, index) =>
      (support.waits[index] ?? []).length >= minTeamShown ? [clean(wait)] : []
    ),
    differently: drawn.differently.flatMap(({ when, after }, index) => {
      const people = support.differently[index] ?? [];
      if (people.length < minTeamShown) {
        return [];
      }
      const outOfTen = shownMedian(
        toldOf(people).flatMap(({ caseShares }) =>
          (caseShares ?? []).flatMap((share) =>
            share.case === index ? [share.outOfTen] : []
          )
        )
      );
      return [{ when: clean(when), does: "", outOfTen, after: placeOf(after) }];
    }),
    decides: shown(support.answers.decides ?? [], drawn.decides),
    own: shown(support.answers.own ?? [], drawn.own),
    ai: shown(support.answers.ai ?? [], drawn.ai),
    right: shown(support.answers.right ?? [], drawn.right),
    ask: shown(support.answers.ask ?? [], drawn.ask),
    next: shown(support.answers.next ?? [], drawn.next),
    term:
      drawn.term === null || support.term.length < minTeamShown
        ? null
        : { word: clean(drawn.term.word), meaning: "" },
    differs:
      differs === null || !differsKept
        ? null
        : {
            step: placeOf(differs.step),
            other: clean(differs.other),
            why: differs.why,
            because: "",
          },
    volumes: volumesOf(told, drawn.per),
    takes:
      quickest === null || longest === null
        ? null
        : {
            unit: drawn.unit,
            quickest,
            longest: Math.max(quickest, longest),
            people: takes.length,
            basis: "estimated",
          },
    wrong:
      wrong === null
        ? null
        : {
            low: wrong,
            high: wrong,
            people: told.filter((each) => each.wrong !== null).length,
            basis: "estimated",
          },
    open: [],
  };
};

/** A record as the brain keeps it, or none when it isn't one: logged, and left out. */
const recordOf = (record: BrainRecordInput): BrainRecord[] => {
  const parsed = brainRecordSchema.safeParse(record);
  if (!parsed.success) {
    log.error("onboarding.brain_record_invalid", { type: record.type });
    return [];
  }
  return [parsed.data];
};

/**
 * What a team gives the brain: its team record, its claims (`claims`, each
 * resting on five or more people) as statements, and its drawn workflows,
 * each drawing a version of its own, all naming the one source of its
 * interviews. The same team, claim or drawing is the same id, so giving
 * it again keeps nothing twice; a new drawing is a new version. The team was found in the staff list (`rosterSource`).
 */
export const intakeOf = async (
  intake: TeamIntake,
  claims: readonly TeamClaim[],
  supports: ReadonlyMap<string, Support>
): Promise<Intake> => {
  const clean = withoutNames(intake.names);
  const teamId = intakeIds.team(intake.team.id);
  const sourceId = await intakeIds.interviews(intake.team.id);
  const records: BrainRecord[] = recordOf({
    type: "team",
    id: teamId,
    name: intake.team.name,
    sourceId: rosterSource,
  });
  const rests: Rest[] = [];
  // Only what five or more of its people said, put together
  // (team-claims.ts): never one person's fact as a statement of its own.
  for (const claim of claims) {
    const text = clean(claim.text).trim();
    if (text === "" || claim.people.length < minTeamShown) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const id = await intakeIds.statement(intake.team.id, claim.kind, text);
    const statement = recordOf({
      type: "statement",
      id,
      kind: claim.kind,
      text,
      sourceId,
      teamIds: [teamId],
      toolIds: [],
    });
    if (statement.length === 0 || records.some((each) => each.id === id)) {
      continue;
    }
    records.push(...statement);
    rests.push(
      ...claim.people.map((person) => ({
        record: id,
        type: "statement" as const,
        person,
      }))
    );
  }
  for (const work of intake.works) {
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const workflowId = await intakeIds.workflow(intake.team.id, work.id);
    const [workflow] = recordOf({
      type: "workflow",
      id: workflowId,
      name: clean(work.name),
      ...(work.local === "" || work.local === work.name
        ? {}
        : { local: clean(work.local) }),
      ...(work.one === "" ? {} : { one: clean(work.one) }),
      teamId,
      sourceId,
      status: "drawn",
    });
    if (workflow === undefined) {
      continue;
    }
    const support = supports.get(work.id);
    if (support === undefined) {
      continue;
    }
    const body = { ...versionOf(work, clean, support), workflowId, sourceId };
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const id = await ownId("wfv", canonicalJson(body));
    const version = recordOf({ ...body, id });
    records.push(workflow, ...version);
    // A workflow rests on the lead who named it and on whom it was drawn
    // from, so it stays while any of them does; each drawing on whom it
    // was drawn from, and the lead whose facts were its context.
    rests.push(
      ...[...new Set([...work.namedBy, ...work.drawn.from])].map((person) => ({
        record: workflowId,
        type: "workflow" as const,
        person,
      })),
      ...(version.length === 0
        ? []
        : [...new Set([...work.drawn.from, ...work.context])].map((person) => ({
            record: id,
            type: "workflowVersion" as const,
            person,
            parent: workflowId,
          })))
    );
  }
  return { records, rests };
};
