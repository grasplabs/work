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

import type { Support } from "./drawing-support.ts";
import { plainPart } from "./plain-text.ts";
import type { TeamClaim } from "./team-claims.ts";
import { inUnitOf } from "./work-drawing.ts";

// What the onboarding learned of a team (GRA-367, GRA-1748): how its work
// runs, as its people told it in the lines they shared as how their team works
// (GRA-1987), put together as its claims (GRA-1084, team-claims.ts), and a
// drawing of each piece of its work. The onboarding keeps both itself and
// hands each to the new Brain as a source of its own; none is a record of
// the brain's (`brain_records`). Both show from the first person who told
// them, so both are held to saying only how the work runs, never who said
// it or how many did:
//
// - No source per person: one per team, served live by the Brain page
//   (brain-rpc.ts), never with who or how many it rests on.
// - A claim is the team's, never one person's fact, nor their words
//   (`text`) or quote; never resting on the lead, whose role alone says
//   who they are; a name on the staff list in it is taken out; and it
//   holds no judgment (`onlyHowItRuns`).
// - A drawing keeps no `from` and no `told`, and no count of people: its
//   numbers are medians over whoever gave one, never whose, and a count
//   someone gave as their own never shows; and only what one or more of
//   its people are checked to have told, each part apart, with no
//   judgment in it (`versionOf`, drawing-support.ts).
// - A team is taken in only while its work may be shown: someone in it
//   told it (the store's `#teamShowsResults`); the store holds it back
//   until then.
//
// Who each claim and drawing rests on is kept apart, in the onboarding's
// own store (`brain_sent`), so deleting an interview can find what it is
// in (GRA-368, the store's `#recountStanding`): the Brain never holds it.

/** An id the onboarding owns, from what it stands for: the same thing is the same id. */
export const ownId = async (
  kind: string,
  ...parts: string[]
): Promise<string> => {
  const hash = await sha256Hex(parts.join("\u0000"));
  return `${onboardingIdPrefix}${kind}-${hash.slice(0, 32)}`;
};

/** The Brain page's ids for what the onboarding shows on it. */
export const intakeIds = {
  /** A roster team, as the Brain page names it. */
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

/** What a team's intake is made from, from the store. */
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

/** A claim (`statement`) or drawing (`workflowVersion`) and a person it rests on: what deleting their interview takes down. */
export interface Rest {
  record: string;
  type: "statement" | "workflowVersion";
  person: string;
}

/**
 * A claim of the team, as the onboarding keeps it (`brain_claims`) and
 * every member reads it, on the Brain page and in the new Brain
 * (GRA-1748): never a record of the brain's own.
 */
export interface IntakeClaim {
  /** Its id, from its team, kind and words: whom it rests on is noted under it. */
  record: string;
  kind: StatementKind;
  text: string;
}

/**
 * A drawing of one of the team's pieces of work, as the onboarding keeps
 * it (`brain_drawings`) and every member reads it, on the Brain page and
 * in the new Brain (GRA-1748): only the parts its people are checked to
 * have told, never who told what or how many. Never a record of the
 * brain's own.
 */
export interface IntakeDrawing {
  /** Its id, from what it holds: whom it rests on is noted under it. */
  record: string;
  /** The piece of work's id on the Brain page, from its team and its work. */
  workflow: string;
  name: string;
  /** Its name in the language its people speak, where it differs. */
  local?: string;
  drawing: WorkflowVersionRecord;
}

/** A team's claims and drawings, and who each rests on. */
export interface Intake {
  claims: IntakeClaim[];
  drawings: IntakeDrawing[];
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

/**
 * A number as a drawing shows it (GRA-1987): from the first person checked
 * to have given it, the median of whoever was (the lower of the middle
 * two): with one, theirs; with two, the lower; with four, the second;
 * checking stops at five (`checkedEnough`). Never how many gave it.
 */
const shownMedian = (values: readonly number[]): number | null =>
  medianOf(values) ?? null;

/**
 * How often the whole team does it: a median of the quiet weeks (or
 * months) and of the busy ones, each over the people checked to have
 * given that one as the team's count (`numbers.volume`); one side alone
 * stands for both. None without one. A count someone gave as their own
 * ("I do 30 a week") is what one person does, never shown (GRA-1987).
 */
const volumesOf = (
  told: readonly (readonly [string, Told])[],
  counted: Support["numbers"]["volume"],
  per: DrawnWork["per"]
): WorkflowVersionRecord["volumes"] => {
  const given = (people: readonly string[], value: "quiet" | "busy") =>
    told.flatMap(([person, { gave }]) => {
      const own = gave?.[value] ?? null;
      return people.includes(person) && own !== null ? [own] : [];
    });
  const quiet = shownMedian(given(counted.quiet, "quiet"));
  const busy = shownMedian(given(counted.busy, "busy"));
  const low = quiet ?? busy;
  const high = busy ?? quiet;
  return low === null || high === null
    ? []
    : [
        {
          of: "team",
          per,
          low,
          high: Math.max(low, high),
          basis: "estimated",
        },
      ];
};

/**
 * How long one whole one takes, in the drawing's unit: a median of the
 * quickest and of the longest, each over the people checked to have given
 * that one themselves, taken of the minutes as they gave them and rounded
 * to the unit only then; one end alone stands for both, and a normal one
 * alone for both too. None with none of them.
 */
const takesOf = (
  toldOf: (people: readonly string[]) => Told[],
  numbers: Support["numbers"]["takes"],
  unit: DrawnWork["unit"]
): WorkflowVersionRecord["takes"] => {
  const given = (people: readonly string[], at: 0 | 1 | 2) =>
    toldOf(people).flatMap(({ gave }) => {
      const own = gave?.takes[at] ?? null;
      return own === null ? [] : [own];
    });
  const quickests = given(numbers.quickest, 0);
  const normals = given(numbers.normal, 1);
  const longests = given(numbers.longest, 2);
  // Medians of the minutes as each gave them, rounded to the unit only now.
  const inUnit = inUnitOf(unit);
  const shownIn = (values: readonly number[]) => {
    const median = shownMedian(values);
    return median === null ? null : inUnit(median);
  };
  const quickestShown = shownIn(quickests);
  const longestShown = shownIn(longests);
  const normalShown = shownIn(normals);
  const quickest = quickestShown ?? longestShown ?? normalShown;
  const longest = longestShown ?? quickestShown ?? normalShown;
  return quickest === null || longest === null
    ? null
    : {
        unit,
        quickest,
        longest: Math.max(quickest, longest),
        basis: "estimated",
      };
};

/**
 * A drawing as the brain keeps it (GRA-1084, GRA-1987): only the parts
 * one or more of the people it was drawn from are checked to have told,
 * holding nothing but how the work runs (drawing-support.ts), in their
 * bare words without a name, and what came with them (who and with what,
 * what is done in a case, what a term means, why a step differs) left
 * out. Each number is a median over whoever was checked to have given it
 * (`shownMedian`), the lead never among them: a step's minutes and a
 * case's share over the people the part rests on, how often (the team's
 * count only), how long and how many come in wrong over the people it was
 * drawn from. No count of people. What the next interviews should ask is
 * never the brain's.
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
  const toldOf = (people: readonly string[]): Told[] =>
    tellers.flatMap(([person, each]) =>
      people.includes(person) ? [each] : []
    );
  // A part's words as checked: the claim's allowlist, or nothing.
  const words = (text: string): string => plainPart(clean(text)) ?? "";
  const shown = (people: readonly string[], text: string): string =>
    people.length > 0 ? words(text) : "";
  const { numbers } = support;
  // The steps someone is checked to have told, and where each step
  // of the drawing lands among them: a case off the path after a step left
  // out follows the last step kept before it, and one with no step kept
  // before it has no place, so it is left out (never put after the first).
  const kept = drawn.steps.flatMap((step, index) =>
    (support.steps[index] ?? []).length > 0 ? [{ step, index }] : []
  );
  const placeOf = (index: number): number | null => {
    const before = kept.filter((each) => each.index <= index).length;
    return before === 0 ? null : before - 1;
  };
  // Each number only from the people checked to have given it, and only
  // as they gave it themselves: never a part filled in from another.
  const wrongs = toldOf(numbers.wrong).flatMap(({ wrong: own }) =>
    own === null ? [] : [own]
  );
  const wrong = shownMedian(wrongs);
  const takes = takesOf(toldOf, numbers.takes, drawn.unit);
  const { differs } = drawn;
  const differsKept =
    differs !== null &&
    kept.some(({ index }) => index === differs.step) &&
    support.other.length > 0;
  return {
    type: "workflowVersion",
    date: dayOf(drawn.at),
    state: work.state,
    starts: shown(support.starts, drawn.starts),
    steps: kept.map(({ step: { text, documented }, index }) => {
      const minutes = shownMedian(
        toldOf(numbers.stepMinutes[index] ?? []).flatMap(({ stepMinutes }) =>
          (stepMinutes ?? []).flatMap(({ step, normal }) =>
            step === index && normal !== undefined && normal !== null
              ? [normal]
              : []
          )
        )
      );
      return {
        text: words(text),
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
      (support.waits[index] ?? []).length > 0 ? [words(wait)] : []
    ),
    differently: drawn.differently.flatMap(({ when, after }, index) => {
      const place = placeOf(after);
      if ((support.differently[index] ?? []).length === 0 || place === null) {
        return [];
      }
      const outOfTen = shownMedian(
        toldOf(numbers.caseShares[index] ?? []).flatMap(({ caseShares }) =>
          (caseShares ?? []).flatMap((share) =>
            share.case === index ? [share.outOfTen] : []
          )
        )
      );
      return [{ when: words(when), does: "", outOfTen, after: place }];
    }),
    decides: shown(support.answers.decides ?? [], drawn.decides),
    own: shown(support.answers.own ?? [], drawn.own),
    ai: shown(support.answers.ai ?? [], drawn.ai),
    right: shown(support.answers.right ?? [], drawn.right),
    ask: shown(support.answers.ask ?? [], drawn.ask),
    next: shown(support.answers.next ?? [], drawn.next),
    term:
      drawn.term === null || support.term.length === 0
        ? null
        : { word: words(drawn.term.word), meaning: "" },
    differs:
      differs === null || !differsKept
        ? null
        : {
            // Its step is kept (`differsKept`): it has a place.
            step: placeOf(differs.step) ?? 0,
            other: words(differs.other),
            why: differs.why,
            because: "",
          },
    volumes: volumesOf(tellers, numbers.volume, drawn.per),
    takes,
    wrong:
      wrong === null ? null : { low: wrong, high: wrong, basis: "estimated" },
    open: [],
  };
};

/** A record as the brain keeps it, or none when it isn't one: logged, and left out. */
export const recordOf = (record: BrainRecordInput): BrainRecord[] => {
  const parsed = brainRecordSchema.safeParse(record);
  if (!parsed.success) {
    log.error("onboarding.brain_record_invalid", { type: record.type });
    return [];
  }
  return [parsed.data];
};

/**
 * What a team's intake notes: its claims (`claims`, each resting on the
 * people checked to say it) and the drawings of its pieces of work (`drawings`),
 * each naming the one source of its interviews, which the onboarding
 * keeps itself and the Brain page reads there (GRA-1748). The same claim
 * or drawing is the same id, so noting it again keeps nothing twice; a
 * drawing drawn anew is a new one.
 */
export const intakeOf = async (
  intake: TeamIntake,
  claims: readonly TeamClaim[],
  supports: ReadonlyMap<string, Support>
): Promise<Intake> => {
  const clean = withoutNames(intake.names);
  const teamId = intakeIds.team(intake.team.id);
  const sourceId = await intakeIds.interviews(intake.team.id);
  const rests: Rest[] = [];
  const kept: IntakeClaim[] = [];
  // Only what its people said, put together and checked
  // (team-claims.ts): never one person's fact as a statement of its own.
  for (const claim of claims) {
    const text = clean(claim.text).trim();
    if (text === "" || claim.people.length === 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const id = await intakeIds.statement(intake.team.id, claim.kind, text);
    // Held to what a statement may say, as the page shows it as one.
    const valid = recordOf({
      type: "statement",
      id,
      kind: claim.kind,
      text,
      sourceId,
      teamIds: [teamId],
      toolIds: [],
    });
    if (valid.length === 0 || kept.some(({ record }) => record === id)) {
      continue;
    }
    kept.push({ record: id, kind: claim.kind, text });
    rests.push(
      ...claim.people.map((person) => ({
        record: id,
        type: "statement" as const,
        person,
      }))
    );
  }
  const drawings: IntakeDrawing[] = [];
  for (const work of intake.works) {
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const workflowId = await intakeIds.workflow(intake.team.id, work.id);
    const name = clean(work.name);
    const local =
      work.local === "" || work.local === work.name
        ? undefined
        : clean(work.local);
    const support = supports.get(work.id);
    if (support === undefined) {
      continue;
    }
    const body = { ...versionOf(work, clean, support), workflowId, sourceId };
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const id = await ownId("wfv", canonicalJson(body));
    const [drawing] = recordOf({ ...body, id });
    if (drawing?.type !== "workflowVersion") {
      continue;
    }
    drawings.push({
      record: id,
      workflow: workflowId,
      name,
      ...(local === undefined ? {} : { local }),
      drawing,
    });
    // A drawing rests on whom it was drawn from, and the lead whose facts
    // were its context.
    rests.push(
      ...[...new Set([...work.drawn.from, ...work.context])].map((person) => ({
        record: id,
        type: "workflowVersion" as const,
        person,
      }))
    );
  }
  return { claims: kept, drawings, rests };
};
