import type {
  InterviewLocale,
  RosterPerson,
} from "@grasp-os/shared/onboarding";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { organizations } from "../db/core/schema.ts";
import { gatewaySettings, modelForRole, models } from "../models.ts";
import type { Took } from "./store.ts";

// A team's map, drawn from what its lead agreed to (GRA-365): what the team
// takes care of, the recurring pieces of work it does, and who does which.
// Then everyone in the team is asked about one piece of work
// (`assignWork`), so every piece is heard from several people. The
// careful model draws it, because nobody waits for it, and only sorts what
// the lead said. Ported from the prototype (grasplabs/prototype,
// packages/grasp: mapTeam in worker/org-drawing.ts, assignWork in
// src/lib/org-record.ts).

/** The most pieces of work a map holds. */
const worksMax = 8;

/** What the map is drawn from. */
export interface TeamBrief {
  company: string;
  team: string;
  /** The language the team speaks: the names of its work are given in it too. */
  locale: InterviewLocale;
  /** Everyone in the team, the lead marked: their own work is work of the team too. */
  people: { id: string; name: string; title: string; lead: boolean }[];
  /** What the lead agreed to, as the record keeps it. */
  facts: { tag: string; record: string }[];
  /** What Stephen knows from the documents the company shared, for this team. */
  documents: string;
}

/** One piece of work, as the map draws it. */
export interface MappedWork {
  /** In English, lower case, as an activity: "handling new tickets". */
  name: string;
  /** The same in the team's language. */
  local: string;
  /** What one of them is called, and several. */
  one: string;
  many: string;
  /** Who the lead said does it, by id. */
  doers: string[];
  /** Roughly how much of the team's time it takes; the shares add up to 1. */
  share: number;
}

export interface TeamMap {
  does: string;
  works: MappedWork[];
}

const languages: Record<InterviewLocale, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
};

/** The shape the model answers in; `mapOf` holds it to the rules. */
const mapSchema = z.object({
  does: z
    .string()
    .describe("What the team takes care of, in at most 12 words."),
  works: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            'A short name in the lead’s own terms, lower case, as an activity: "handling new tickets".'
          ),
        local: z
          .string()
          .describe(
            'The same name in the language the team speaks, lower case: "nieuwe tickets afhandelen".'
          ),
        one: z.string().describe('What one of them is called: "ticket".'),
        many: z.string().describe('And several: "tickets".'),
        doers: z
          .array(z.string())
          .describe(
            "The ids of the people the lead said do it. Empty when the lead named nobody."
          ),
        share: z
          .number()
          .describe(
            "Roughly how much of the team’s time it takes, 0 to 1, from what the lead said; the shares add up to about 1."
          ),
      })
    )
    .describe(
      "The recurring pieces of work the lead named, the most time first. At most eight."
    ),
});

const mapSystem = `You are Grasp's analyst. Stephen, Grasp's AI interviewer, has interviewed a team lead about the work their team does. From the facts the lead agreed to, write down the team's map: what the team takes care of, the recurring pieces of work it does, and who does which. Only what the lead said: never a piece of work, a person or a number the facts do not give. A piece of work is a whole job that comes back, from what starts one until it is done (a ticket, from when it comes in until it is closed). A step inside another job is part of that job, never a piece of work of its own: passing a claim on while handling a ticket is part of handling the ticket. Names of work are in English, short, in the lead's own terms; local is the same name in the language the team speaks, as they would say it. A person is named by their id from the list given; someone the lead named who is not on the list is left out. The lead is on the list too: recurring work they said they do themselves is a piece of work like any other, with them as who does it.`;

/** What the model is asked, from the brief. */
const promptOf = (brief: TeamBrief): string =>
  [
    `The company: ${brief.company || "(unnamed)"}.`,
    `The team: ${brief.team}. It speaks ${languages[brief.locale]}.`,
    "The people in the team, by id:",
    ...brief.people.map(
      ({ id, name, title, lead }) =>
        `- ${id}: ${name}${title === "" ? "" : `, ${title}`}${lead ? " (the lead, who told all this)" : ""}`
    ),
    "",
    "What the lead agreed to:",
    ...(brief.facts.length > 0
      ? brief.facts.map(({ tag, record }) => `- (${tag}) ${record}`)
      : ["(nothing)"]),
    ...(brief.documents === ""
      ? []
      : ["", "Documents the company shared, as read:", brief.documents]),
  ].join("\n");

/**
 * A string on one line; one longer than `most` is cut at its last whole
 * word, with an ellipsis.
 */
const lineOf = (value: string, most: number): string => {
  const line = value.replaceAll(/\s+/gu, " ").trim();
  if (line.length <= most) {
    return line;
  }
  const cut = line.slice(0, most - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > most / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, "")}…`;
};

/**
 * What the model drew, held to the rules: at most eight pieces of work,
 * each named; only people on the list; shares that add up to 1.
 */
export const mapOf = (
  raw: z.output<typeof mapSchema>,
  people: readonly { id: string }[]
): TeamMap => {
  const known = new Set(people.map(({ id }) => id));
  const works = raw.works.slice(0, worksMax).flatMap((work) => {
    const name = lineOf(work.name, 60).toLowerCase();
    if (name === "") {
      return [];
    }
    return [
      {
        name,
        local: lineOf(work.local, 60).toLowerCase() || name,
        one: lineOf(work.one, 40) || "item",
        many: lineOf(work.many, 40) || "items",
        doers: [...new Set(work.doers.filter((id) => known.has(id)))],
        share:
          Number.isFinite(work.share) && work.share > 0
            ? Math.min(work.share, 1)
            : 0,
      },
    ];
  });
  const total = works.reduce((sum, { share }) => sum + share, 0);
  return {
    does: lineOf(raw.does, 120),
    works: works.map((work) => ({
      ...work,
      share:
        total > 0
          ? Math.round((work.share / total) * 100) / 100
          : Math.round(100 / works.length) / 100,
    })),
  };
};

/**
 * What the company is called: the deployment's one organization, once
 * someone signed in. Read here rather than through organization.ts, which
 * reaches back to the onboarding store.
 */
export const companyName = async (env: Env): Promise<string> => {
  const [row] = await drizzle(env.DB)
    .select({ name: organizations.name })
    .from(organizations)
    .limit(1);
  return row?.name ?? "";
};

/** Thrown when there is no model the deployment allows to draw with. */
export class NoDrawingModelError extends Error {
  override name = "NoDrawingModelError";
}

/**
 * Draws a team's map through the model gateway: the deployment's careful
 * model, by the system, for `onboarding.drawing`. `count` is told what it
 * took, as the onboarding counts it.
 */
export const drawTeamMap = async (
  env: Env,
  brief: TeamBrief,
  count: (took: Took) => void
): Promise<TeamMap> => {
  const model = modelForRole(gatewaySettings(env), "careful", {
    sensitive: true,
  });
  if (model === undefined) {
    throw new NoDrawingModelError("No model may draw the team's map.");
  }
  const { output, usage } = await models(env).call({
    model,
    purpose: "onboarding.drawing",
    trigger: { type: "system" },
    work: { onboarding: true },
    effort: "medium",
    system: mapSystem,
    input: promptOf(brief),
    schema: mapSchema,
    maxTokens: 16_000,
  });
  count({
    purpose: "drawing",
    model,
    tokensIn: usage.inputTokens,
    tokensCached: usage.cacheRead,
    tokensOut: usage.outputTokens,
  });
  return mapOf(output, brief.people);
};

/** A job title as compared: the same job however it's written. */
const titleOf = (title: string): string => title.trim().toLowerCase();

/** A piece of work as the store keeps it, as far as asking about it goes. */
export interface WorkToAsk {
  id: string;
  doers: readonly string[];
  share: number;
}

/**
 * Who in a team is asked about which piece of work: whoever the lead named
 * for a work, then the rest by each work's share, so every piece of work
 * is heard from several people. A person who does more than one is asked
 * about the one fewest others are asked about. Someone the lead did not
 * name is asked about work that people with their job do, when the lead
 * named any of them. Null when the team has no work on its map.
 * `heard` says how many are asked about each piece already, when some are.
 */
export const assignWork = (
  people: readonly Pick<RosterPerson, "id" | "name" | "title">[],
  works: readonly WorkToAsk[],
  everyone: readonly Pick<RosterPerson, "id" | "title">[] = people,
  heard: ReadonlyMap<string, number> = new Map()
): Map<string, string | null> => {
  const asked = new Map(works.map(({ id }) => [id, heard.get(id) ?? 0]));
  const assigned = new Map<string, string | null>();
  const named = (person: string) =>
    works.filter(({ doers }) => doers.includes(person));
  const alike = (person: Pick<RosterPerson, "id" | "title">) => {
    const title = titleOf(person.title);
    const same = new Set(
      everyone
        .filter(
          (other) =>
            other.id !== person.id &&
            title !== "" &&
            titleOf(other.title) === title
        )
        .map(({ id }) => id)
    );
    return works.filter(({ doers }) => doers.some((doer) => same.has(doer)));
  };
  // Whoever does only one piece of work is asked about that one; those who do more fill the gaps.
  const order = people.toSorted(
    (a, b) =>
      named(a.id).length - named(b.id).length || a.name.localeCompare(b.name)
  );
  const heardOf = (work: WorkToAsk) =>
    (asked.get(work.id) ?? 0) / Math.max(work.share, 0.05);
  for (const person of order) {
    const theirs = named(person.id);
    const likely = theirs.length > 0 ? [] : alike(person);
    let pool = works;
    if (theirs.length > 0) {
      pool = theirs;
    } else if (likely.length > 0) {
      pool = likely;
    }
    // The least heard so far, weighed by how much of the team's time it takes.
    const [pick] = pool.toSorted(
      (a, b) => heardOf(a) - heardOf(b) || b.share - a.share
    );
    assigned.set(person.id, pick?.id ?? null);
    if (pick !== undefined) {
      asked.set(pick.id, (asked.get(pick.id) ?? 0) + 1);
    }
  }
  return assigned;
};
