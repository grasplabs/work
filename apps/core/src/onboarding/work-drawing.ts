import { needsSplit, workflowState } from "@grasp-os/shared/admin/interviews";
import type {
  WorkflowEvidence,
  WorkflowState,
} from "@grasp-os/shared/admin/interviews";
import {
  factsSaid,
  rulesFor,
  STARTING_ORG_RULES,
} from "@grasp-os/shared/admin/onboarding-admin";
import type { OrgRules } from "@grasp-os/shared/admin/onboarding-admin";
import { toldPartsOf } from "@grasp-os/shared/admin/org-record";
import type {
  DrawnWork,
  StaffDrawing,
  Told,
} from "@grasp-os/shared/admin/org-record";
import type { SettleChoice } from "@grasp-os/shared/onboarding";
import { orgRulesSchema } from "@grasp-os/shared/onboarding-staff";
import type { StaffWorks } from "@grasp-os/shared/onboarding-staff";
import { z } from "zod";

import { gatewaySettings, modelForRole, models } from "../models.ts";
import type { Took } from "./store.ts";
import { NoDrawingModelError } from "./team-map.ts";

// A piece of work, drawn from the facts everyone who told it agreed to
// (GRA-366): how it runs today, each person's own numbers, and what the
// next interviews still need to ask. The careful model draws it, because
// nobody waits for it, and only sorts what was said: every line rests on
// named people, and what nobody said stays open. Numbers are never
// averaged: each person's are kept, so the record can show the range and
// how many it rests on. Ported from the prototype (grasplabs/prototype,
// packages/grasp: drawWork and drawnOf in worker/org-drawing.ts, drawOne
// in worker/org-store.ts, evidenceAt in src/lib/onboarding-admin.ts).

/** What a piece of work is drawn from. */
export interface WorkBrief {
  company: string;
  team: string;
  /** The company's other teams, by name: where the work goes next is said by a team's own name. */
  teams: string[];
  work: { name: string; local: string; one: string };
  /** What the team's lead agreed to, for context, when they don't tell it themselves. */
  lead: string[];
  /** Everyone who agreed to an interview about it, with what they agreed to. */
  tellers: {
    person: string;
    title: string;
    facts: { tag: string; record: string }[];
    /** A file they shared as an example, by name. */
    example: string | null;
    /** The piece of work their interview was about, when it was another. */
    about?: string;
  }[];
  /** What Stephen knows from the documents the company shared, for this team. */
  documents: string;
}

const by = z.array(z.string());

/**
 * The shape the model answers in, kept small: what each field means is in
 * `drawSystem`, and `drawnOf` holds it to the rules. Fields it leaves out
 * are left out of the drawing, never made up. The gateway asks for JSON in
 * words, so a shape too large for a provider's structured answers can't
 * be refused.
 */
const drawSchema = z.object({
  starts: z.string().optional(),
  starts_by: by.optional(),
  steps: z
    .array(
      z.object({
        text: z.string(),
        who: z.string().optional(),
        tool: z.string().optional(),
        by: by.optional(),
        other: z.string().optional(),
        other_by: by.optional(),
        why: z.string().optional(),
        because: z.string().optional(),
        minutes: z.array(z.number()).optional(),
        documented: z.boolean().optional(),
      })
    )
    .optional(),
  notes: z
    .array(
      z.object({
        kind: z.string(),
        text: z.string(),
        detail: z.string().optional(),
        out_of_ten: z.number().optional(),
        after: z.number().optional(),
        by: by.optional(),
      })
    )
    .optional(),
  numbers: z
    .array(
      z.object({
        person: z.string(),
        quiet: z.number().optional(),
        busy: z.number().optional(),
        of: z.string().optional(),
        per: z.string().optional(),
        minutes: z.array(z.number()).optional(),
        wrong: z.number().optional(),
      })
    )
    .optional(),
  open: z.array(z.string()).optional(),
});

export type RawDrawing = z.output<typeof drawSchema>;

const drawSystem = `You are Grasp's analyst. Stephen, Grasp's AI interviewer, interviewed the people who do one piece of work. From the facts each of them agreed to, draw the work as it runs today, for the record. Write everything in English, plainly.

Answer in JSON with these fields:
- starts: what starts one, in one sentence; empty when nobody said. starts_by: the ids of who said it.
- steps: the steps in order, from start to done. Each: text, one action as an instruction ("Open the ticket in Zendesk."); who, the role that does it, never a name ("Customer service agent"); tool, the system, screen, file or sheet, or empty; by, the ids of who told this step; other, when some told this step another way, that way as an instruction, else empty; other_by, who told it that way; why, empty when it goes one way, else "condition" (it depends on the case), "place" (it depends on the office or person) or "conflict" (nobody could say why); because, for condition or place what it depends on, else empty; minutes, how long this step takes, as three numbers in this order: the quickest, a normal one and the longest anyone said, -1 for one nobody said, or an empty list when nobody said any; documented, true when a shared document describes this step too.
- notes: everything else that was said, one each. kind is one of: "wait" (where it sits still, and for what), "differently" (a case off the normal path: text is when it happens, in a few words starting lower case and without a full stop, "the client number is missing"; detail is what is done then, as an instruction; out_of_ten how many out of ten, or -1 when nobody said; after the position of the step after which it happens, from 0), "decides" (what they look at to decide), "own" (a list, sheet or tool of their own), "ai" (an AI tool some use for it), "right" (what done right looks like), "ask" (when they stop and ask someone), "next" (who gets it after them: when that is one of the company's other teams, that team's name exactly as it is given, then what it does with it; otherwise a role), "term" (a word of their own: text is the word, detail its meaning). Fields a kind does not use are empty, or -1 for numbers. by: the ids of who said it.
- numbers: each person's own numbers, one entry per person who gave any, never averaged or combined. quiet: how many they do in a quiet week or month, or in a normal one when they gave no quiet one; busy: how many in a busy one; each -1 when not said. of: whose count quiet and busy are, "me" when they said it is their own, "team" when they said it is the whole team's, "unknown" when they did not say. per: "week" or "month". minutes: how long one whole one takes them in minutes of work, as three numbers in this order: the quickest, a normal one and the longest, -1 for one they did not say ("a normal one takes 12 minutes" is [-1, 12, -1]), or an empty list when they said none. wrong: how many out of ten come in wrong or incomplete, -1 when not said.
- open: what the next interview should ask because nobody could say it yet, one short question each, at most five.

Rules:
- Only what was said. Never a step, a tool, a number or a reason nobody gave. No improvements, no opinions.
- Only what is about this piece of work. Someone asked about it may tell about other work of theirs as well: leave that out.
- A note only for what someone said is there. When nobody said anything about a kind, there is no note of that kind: never "no AI tool is used" because nobody mentioned one.
- One note per case, never one per person: when people gave different numbers for the same case, out_of_ten is the lowest, and the text ends with the range they gave ("(2 to 3 in 10)").
- A step told by one person counts; a step told by several is one step.
- People who tell a step differently are never merged: keep the way most told it as the step, and the other way in "other".
- Convert hours to minutes; days count as work only when they said it is work, not waiting.`;

/** What the model is asked, from the brief. */
const promptOf = (brief: WorkBrief): string =>
  [
    `The company: ${brief.company || "(unnamed)"}. The team: ${brief.team}.`,
    ...(brief.teams.length > 0
      ? [`The company's other teams: ${brief.teams.join("; ")}.`]
      : []),
    `The piece of work: ${brief.work.name}${brief.work.local === brief.work.name ? "" : ` (in their language: ${brief.work.local})`} (one is called a ${brief.work.one}).`,
    ...(brief.lead.length > 0
      ? [
          "",
          "What the team lead said about the team, for context only:",
          ...brief.lead.slice(0, 30).map((fact) => `- ${fact}`),
        ]
      : []),
    ...(brief.documents === ""
      ? []
      : ["", "Documents the company shared, as read:", brief.documents]),
    "",
    "What each person who does it agreed to:",
    ...brief.tellers.flatMap((teller) => [
      `## ${teller.person}${teller.title === "" ? "" : ` (${teller.title})`}${teller.about === undefined ? "" : `, asked about ${teller.about}`}${teller.example === null ? "" : `, shared an example: ${teller.example}`}`,
      ...teller.facts.map(({ tag, record }) => `- (${tag}) ${record}`),
      "",
    ]),
  ].join("\n");

/**
 * A string on one line; one longer than `most` is cut at its last whole
 * word, with an ellipsis.
 */
const lineOf = (value: string | undefined, most = 300): string => {
  const line = (value ?? "").replaceAll(/\s+/gu, " ").trim();
  if (line.length <= most) {
    return line;
  }
  const cut = line.slice(0, most - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > most / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, "")}…`;
};

/** A count as given, when it is one: a number from nothing up, at most `most`. -1 is none. */
const countOf = (value: number | undefined, most = 100_000): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, most)
    : null;

/**
 * The quickest, a normal and the longest time, from the three the model
 * gives in that order with -1 for one nobody said; a single one is the
 * normal one. None when no time was said at all.
 */
const timesOf = (
  value: readonly number[] | undefined
): [number, number, number] | null => {
  const given = (value ?? []).slice(0, 3).map((each) => countOf(each));
  const [quickest = null, normal = null, longest = null] =
    given.length === 1 ? [null, given[0] ?? null, null] : given;
  const middle = normal ?? quickest ?? longest;
  if (middle === null) {
    return null;
  }
  return [
    Math.min(quickest ?? middle, middle),
    middle,
    Math.max(longest ?? middle, middle),
  ];
};

/** The median of some numbers; none of none. */
const medianOf = (values: readonly number[]): number | undefined =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

type Note = NonNullable<RawDrawing["notes"]>[number];
type Step = NonNullable<RawDrawing["steps"]>[number];
type Numbers = NonNullable<RawDrawing["numbers"]>[number];

/** Hours of work for a normal one, from two on: whole and half hours. */
const unitOf = (numbers: readonly Numbers[]): DrawnWork["unit"] => {
  const normals = numbers.flatMap((each) => timesOf(each.minutes)?.[1] ?? []);
  return (medianOf(normals) ?? 0) >= 120 ? "hours" : "minutes";
};

const whyOf = (why: string | undefined): "condition" | "place" | "conflict" => {
  const said = lineOf(why, 12);
  return said === "condition" || said === "place" ? said : "conflict";
};

const whoseOf = (of: string | undefined): "me" | "team" | "unknown" =>
  of === "me" || of === "team" ? of : "unknown";

/** One person's own numbers, never another's: how many, how long and how many wrong. */
const numbersOf = (
  own: Numbers | undefined,
  inUnit: (minutes: number) => number
): Pick<Told, "volume" | "volumeOf" | "takes" | "wrong"> => {
  const quiet = countOf(own?.quiet);
  const busy = countOf(own?.busy);
  const took = timesOf(own?.minutes);
  const counted = quiet !== null || busy !== null;
  return {
    // A normal week, when no quiet one was given, is the low end.
    volume: counted
      ? [quiet ?? busy ?? 0, Math.max(busy ?? quiet ?? 0, quiet ?? 0)]
      : null,
    ...(counted ? { volumeOf: whoseOf(own?.of) } : {}),
    takes:
      took === null
        ? null
        : [inUnit(took[0]), inUnit(took[1]), inUnit(took[2])],
    wrong: countOf(own?.wrong, 10),
  };
};

/**
 * What the model drew, held to the rules, with what each person told
 * worked out from who said what: only the people it was drawn from; at
 * most 30 steps, 10 waits and 10 cases off the normal path; how often a
 * case comes up stays unknown when nobody said, never 0; each person's
 * numbers apart. `at` is when it was drawn.
 */
export const drawnOf = (
  raw: RawDrawing,
  brief: Pick<WorkBrief, "tellers">,
  at: string
): DrawnWork => {
  const known = new Set(brief.tellers.map(({ person }) => person));
  const idsOf = (value: readonly string[] | undefined): string[] => [
    ...new Set((value ?? []).filter((id) => known.has(id))),
  ];
  const steps = (raw.steps ?? [])
    .slice(0, 30)
    .flatMap((step): { step: Step; said: string }[] => {
      const said = lineOf(step.text);
      return said === "" ? [] : [{ step, said }];
    });
  const notes = (raw.notes ?? []).slice(0, 40);
  const of = (kind: string): Note[] =>
    notes.filter(
      (note) => lineOf(note.kind, 20) === kind && lineOf(note.text) !== ""
    );
  const [term] = of("term");
  const waits = of("wait").slice(0, 10);
  const differently = of("differently").slice(0, 10);
  const numbers = (raw.numbers ?? []).filter(({ person }) =>
    known.has(lineOf(person, 40))
  );
  const firstOther = steps.findIndex(({ step }) => lineOf(step.other) !== "");
  const otherStep = steps[firstOther]?.step;
  const unit = unitOf(numbers);
  const inUnit = (minutes: number) =>
    unit === "hours" ? Math.round((minutes / 60) * 2) / 2 : Math.round(minutes);
  const monthly = numbers.filter(({ per }) => per === "month").length;
  const told: Record<string, Told> = {};
  for (const { person, example } of brief.tellers) {
    const mine = (value: readonly string[] | undefined) =>
      idsOf(value).includes(person);
    const said = (kind: string) => of(kind).some((note) => mine(note.by));
    const stepsTold = steps.flatMap(({ step }, index) =>
      mine(step.by) || mine(step.other_by) ? [index] : []
    );
    const way =
      otherStep !== undefined &&
      (mine(otherStep.by) || mine(otherStep.other_by))
        ? { step: firstOther, other: mine(otherStep.other_by) }
        : null;
    told[person] = {
      start: mine(raw.starts_by),
      steps: stepsTold,
      end: steps.length > 0 && stepsTold.includes(steps.length - 1),
      way,
      waits: waits.flatMap((wait, index) => (mine(wait.by) ? [index] : [])),
      differently: differently.flatMap((each, index) =>
        mine(each.by) ? [index] : []
      ),
      decides: said("decides"),
      own: said("own"),
      ai: said("ai"),
      ...numbersOf(
        numbers.find((each) => lineOf(each.person, 40) === person),
        inUnit
      ),
      right: said("right"),
      ask: said("ask"),
      next: said("next"),
      example,
      term: term === undefined ? false : mine(term.by),
      out: [],
    };
  }
  const lastStep = Math.max(steps.length - 1, 0);
  const textOf = (kind: string, most?: number) =>
    lineOf(of(kind)[0]?.text, most);
  return {
    at,
    from: brief.tellers.map(({ person }) => person),
    starts: lineOf(raw.starts),
    steps: steps.map(({ step, said }) => ({
      text: said,
      who: lineOf(step.who, 80),
      tool: lineOf(step.tool, 80),
      minutes: timesOf(step.minutes),
      documented: step.documented === true,
    })),
    waits: waits.map((wait) => lineOf(wait.text)),
    differently: differently.map((each) => ({
      when: lineOf(each.text),
      does: lineOf(each.detail),
      outOfTen: countOf(each.out_of_ten, 10),
      after: Math.min(
        Math.max(Math.round(countOf(each.after, 30) ?? 0), 0),
        lastStep
      ),
    })),
    decides: textOf("decides"),
    own: textOf("own"),
    ai: textOf("ai"),
    right: textOf("right"),
    ask: textOf("ask"),
    next: textOf("next", 120),
    term:
      term === undefined
        ? null
        : { word: lineOf(term.text, 40), meaning: lineOf(term.detail) },
    differs:
      otherStep === undefined
        ? null
        : {
            step: firstOther,
            other: lineOf(otherStep.other),
            why: whyOf(otherStep.why),
            because: lineOf(otherStep.because),
          },
    per: monthly > numbers.length / 2 ? "month" : "week",
    unit,
    told,
    open: (raw.open ?? [])
      .map((question) => lineOf(question))
      .filter((question) => question !== "")
      .slice(0, 5),
  };
};

/**
 * Draws a piece of work through the model gateway: the deployment's
 * careful model, by the system, for `onboarding.drawing`. `count` is told
 * what it took, as the onboarding counts it.
 */
export const drawWork = async (
  env: Env,
  brief: WorkBrief,
  count: (took: Took) => void
): Promise<DrawnWork> => {
  const model = modelForRole(gatewaySettings(env), "careful", {
    sensitive: true,
  });
  if (model === undefined) {
    throw new NoDrawingModelError("No model may draw the work.");
  }
  const { output, usage } = await models(env).call({
    model,
    purpose: "onboarding.drawing",
    trigger: { type: "system" },
    work: { onboarding: true },
    effort: "medium",
    system: drawSystem,
    input: promptOf(brief),
    schema: drawSchema,
    maxTokens: 16_000,
  });
  count({
    purpose: "drawing",
    model,
    tokensIn: usage.inputTokens,
    tokensCached: usage.cacheRead,
    tokensOut: usage.outputTokens,
  });
  return drawnOf(output, brief, new Date().toISOString());
};

const triple = z.tuple([z.number(), z.number(), z.number()]);

/** A drawing as the store keeps it, read back. */
export const drawnWorkSchema = z.object({
  at: z.string(),
  from: z.array(z.string()),
  starts: z.string(),
  steps: z.array(
    z.object({
      text: z.string(),
      who: z.string(),
      tool: z.string(),
      minutes: triple.nullable(),
      documented: z.boolean(),
    })
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
  differs: z
    .object({
      step: z.number(),
      other: z.string(),
      why: z.enum(["condition", "place", "conflict"]),
      because: z.string(),
    })
    .nullable(),
  per: z.enum(["week", "month"]),
  unit: z.enum(["minutes", "hours"]),
  told: z.record(
    z.string(),
    z.object({
      start: z.boolean(),
      steps: z.array(z.number()),
      end: z.boolean(),
      way: z.object({ step: z.number(), other: z.boolean() }).nullable(),
      waits: z.array(z.number()),
      differently: z.array(z.number()),
      decides: z.boolean(),
      own: z.boolean(),
      ai: z.boolean(),
      volume: z.tuple([z.number(), z.number()]).nullable(),
      volumeOf: z.enum(["me", "team", "unknown"]).optional(),
      takes: triple.nullable(),
      wrong: z.number().nullable(),
      right: z.boolean(),
      ask: z.boolean(),
      next: z.boolean(),
      example: z.string().nullable(),
      term: z.boolean(),
      out: z.array(z.string()),
    })
  ),
  open: z.array(z.string()),
}) satisfies z.ZodType<DrawnWork>;

/** A number staff see (`DrawnNumber`): how many people, and its value only past the threshold. */
const shownSchema = <Value extends z.ZodType>(value: Value) =>
  z.object({ people: z.number(), value: value.nullable() });

/**
 * A drawing as staff read it (`StaffDrawing`, GRA-1079): which parts each
 * person told, never their numbers nor whether they gave one, and its
 * numbers as medians over at least 5 people. The schema names no field of
 * one person's numbers, so a value that slipped into a drawing is stripped
 * on its way out rather than sent.
 */
const staffDrawingSchema = drawnWorkSchema
  .omit({ told: true, steps: true, differently: true })
  .extend({
    steps: z.array(
      z.object({
        text: z.string(),
        who: z.string(),
        tool: z.string(),
        minutes: shownSchema(z.number()),
        documented: z.boolean(),
      })
    ),
    differently: z.array(
      z.object({
        when: z.string(),
        does: z.string(),
        outOfTen: shownSchema(z.number()),
        after: z.number(),
      })
    ),
    told: z.record(
      z.string(),
      z.object({
        start: z.boolean(),
        steps: z.array(z.number()),
        end: z.boolean(),
        way: z.object({ step: z.number(), other: z.boolean() }).nullable(),
        waits: z.array(z.number()),
        differently: z.array(z.number()),
        decides: z.boolean(),
        own: z.boolean(),
        ai: z.boolean(),
        right: z.boolean(),
        ask: z.boolean(),
        next: z.boolean(),
        example: z.boolean(),
        term: z.boolean(),
        out: z.array(z.string()),
      })
    ),
    totals: z.object({
      volume: shownSchema(z.object({ quiet: z.number(), busy: z.number() })),
      takes: shownSchema(z.number()),
      wrong: shownSchema(z.number()),
    }),
  }) satisfies z.ZodType<StaffDrawing>;

/**
 * Every piece of work as staff read it (`StaffWorks`), checked on its way
 * out: only what the schema names leaves core.
 */
export const staffWorksSchema = z.object({
  works: z.array(
    z.object({
      id: z.string(),
      team: z.string(),
      name: z.string(),
      local: z.string().optional(),
      item: z.tuple([z.string(), z.string()]),
      doers: z.array(z.string()),
      share: z.number(),
      from: z.enum(["lead", "grasp"]),
      drawn: staffDrawingSchema.nullable(),
      stale: z.boolean(),
    })
  ),
  rules: orgRulesSchema,
  counted: z.array(z.string()),
}) satisfies z.ZodType<StaffWorks>;

/**
 * What the people a piece of work was drawn from told of it, in the order
 * they agreed: how many told each step, which ways a step told two ways
 * was told, and how many facts each added and how many of those were new.
 */
const heardOf = (drawn: DrawnWork | null, talked: readonly string[]) => {
  const seen = new Set<string>();
  const described = (drawn?.steps ?? []).map(() => 0);
  const ways = new Set<boolean>();
  const added: { fresh: number; all: number }[] = [];
  for (const person of talked) {
    const telling = drawn?.told[person];
    if (telling === undefined) {
      continue;
    }
    // Core's own count, of everything each said, numbers included.
    const facts = factsSaid(
      {
        ...toldPartsOf(telling),
        out: telling.out,
        numbers: {
          volume: telling.volume,
          takes: telling.takes,
          wrong: telling.wrong,
        },
      },
      null
    );
    added.push({
      fresh: facts.filter((fact) => !seen.has(fact)).length,
      all: facts.length,
    });
    for (const fact of facts) {
      seen.add(fact);
    }
    for (const step of telling.steps) {
      described[step] = (described[step] ?? 0) + 1;
    }
    if (telling.way !== null) {
      ways.add(telling.way.other);
    }
  }
  return { described, ways, added };
};

/**
 * Whether a step is told two ways, and whether why is known, once the
 * admin settled it (`holds`): both ways kept are explained, and one way
 * holding leaves one way.
 */
const settledOf = (
  drawn: DrawnWork | null,
  ways: ReadonlySet<boolean>,
  holds: SettleChoice | null
): { differs: boolean; explained: boolean } => ({
  differs: ways.size === 2 && (holds === null || holds === "both"),
  explained: drawn?.differs?.why !== "conflict" || holds === "both",
});

/**
 * Where a piece of work stands with what Grasp counted as known by hand:
 * that holds, unless people tell a step two ways and nobody can say why.
 */
const withHand = (
  byRules: WorkflowState,
  variants: number,
  counted: boolean
): { state: WorkflowState; byHand: boolean } => {
  const byHand =
    counted &&
    byRules !== "complete" &&
    byRules !== "variants" &&
    byRules !== "blocked";
  if (!byHand) {
    return { state: byRules, byHand };
  }
  return { state: variants > 0 ? "variants" : "complete", byHand };
};

/** How far a piece of work is known, under the organization's rules. */
export interface WorkKnown extends WorkflowEvidence {
  state: WorkflowState;
  /** Everyone who does it has told it: nobody is left to ask. */
  everyone: boolean;
  /** So many interviews without settling that it is better split in two. */
  split: boolean;
  /** Grasp counts it as known by hand, before the rules say so. */
  byHand: boolean;
}

/**
 * How far a piece of work is known from its drawing, under the
 * organization's rules (`STARTING_ORG_RULES` until Grasp tunes them): a
 * step counts once enough of the people who do the work told it, or one
 * fewer and a document; it is complete once the last interviews add less
 * than a share of new facts; a step told two ways that nobody can explain
 * blocks it; and more than the most interviews without settling means two
 * pieces of work in one. `told` is who it was drawn from, in the order
 * they agreed; `doers` who does it, away people left out; `lead` the
 * team's lead, whose overview alone never makes it known; `holds` how the
 * admin settled a difference nobody could explain: both ways kept makes
 * them variants, and one way holding leaves no difference at all.
 * `counted`: Grasp counts it as known by hand, which holds unless people
 * tell a step two ways and nobody can say why.
 */
export const knownOf = (
  drawn: DrawnWork | null,
  {
    id,
    team,
    told,
    doers,
    lead,
    holds = null,
    counted = false,
  }: {
    id: string;
    team: string;
    told: readonly string[];
    doers: readonly string[];
    lead: string | null;
    holds?: SettleChoice | null;
    counted?: boolean;
  },
  rules: OrgRules = STARTING_ORG_RULES
): WorkKnown => {
  const own = rulesFor(rules, doers.length);
  const steps = drawn?.steps ?? [];
  const talked =
    drawn === null ? [] : told.filter((person) => person in drawn.told);
  const { described, ways, added } = heardOf(drawn, talked);
  const recent = added.slice(-own.run);
  const said = recent.reduce((sum, { all }) => sum + all, 0);
  const { differs, explained } = settledOf(drawn, ways, holds);
  const everyone =
    doers.length > 0 &&
    doers.every((person) => talked.includes(person)) &&
    !talked.every((person) => person === lead);
  const needed = everyone ? 1 : own.people;
  const evidence: WorkflowEvidence = {
    id,
    team,
    approved: talked.length,
    lastNew:
      said === 0 ? 1 : recent.reduce((sum, { fresh }) => sum + fresh, 0) / said,
    steps: steps.length,
    evidenced: described.filter(
      (count, step) =>
        count >= needed ||
        (count >= 1 && count >= needed - 1 && steps[step]?.documented === true)
    ).length,
    variants: differs && explained ? 1 : 0,
    unexplained: differs && !explained ? 1 : 0,
  };
  // With nobody left to ask, more interviews can't add facts: it is as known as it gets. Without a step drawn it isn't known at all.
  let byRules: WorkflowState = "mapping";
  if (steps.length > 0) {
    byRules = workflowState(
      everyone ? { ...evidence, lastNew: 0 } : evidence,
      own
    );
  }
  const { state, byHand } = withHand(byRules, evidence.variants, counted);
  return {
    ...evidence,
    state,
    everyone,
    split: !byHand && !everyone && needsSplit(evidence, own),
    byHand,
  };
};
