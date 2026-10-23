/**
 * A practice company: an answer key made into the local core's onboarding,
 * the way a real one comes in, through core's own API. Its team lead is
 * played by a model, because the leads talk first; once the team's map is
 * drawn from what the lead agreed to, every employee of the key has a link
 * of their own, and a role card for whoever plays them: a person, or a
 * model. A local core holds one onboarding, so a practice company takes
 * its place, and refuses to replace one that isn't the lab's. Ported from
 * the prototype (grasplabs/prototype, packages/grasp: lab/practice.ts).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { interviewPhases } from "@grasp-os/shared/interview-links";
import { interviewWants } from "@grasp-os/shared/interview-turn";
import { labViaSchema } from "@grasp-os/shared/lab";
import {
  interviewLocaleSchema,
  interviewerSchema,
} from "@grasp-os/shared/onboarding";
import type { InterviewLocale, Roster } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { origin } from "../seed/local.ts";
import { ask, linkOn, linksOf } from "./core.ts";
import type { Core } from "./core.ts";
import { folderOf, keepJson, keepText, keptJson, openFolder } from "./kept.ts";
import { hiddenFolder, isHidden } from "./keys/index.ts";
import { roleName } from "./keys/types.ts";
import type { AnswerKey } from "./keys/types.ts";
import { moves } from "./moves.ts";
import { tempers } from "./people.ts";
import { leadNameFor, leadSystem, modelPlayer } from "./person.ts";
import type { Asker } from "./person.ts";
import { playInterview } from "./play.ts";
import { cardText, roleCardOf } from "./role-card.ts";

/** What the lab kept of an interview a model played. */
const playedSchema = z.object({
  interviewer: interviewerSchema,
  /** The first practice people, who tell all they know; or people as they are, with a temper. */
  people: z.enum(["ideal", "real"]),
  temper: z.enum(tempers).optional(),
  seed: z.int().optional(),
  said: z.array(z.array(z.string())),
  notesAt: z.array(z.int()),
  phaseAt: z.array(z.enum(interviewPhases)),
  readbackFrom: z.int(),
  moves: z.array(z.enum(moves).nullable()),
  untrue: z.array(z.array(z.string())),
  wantsAt: z.array(z.enum(interviewWants)),
  left: z.boolean(),
  minutes: z.number(),
});
export type PlayedRecord = z.output<typeof playedSchema>;

const practicePersonSchema = z.object({
  /** Their id on the roster. */
  id: z.string(),
  /** Their id in the key. */
  employee: z.string(),
  name: z.string(),
  /** The key of the device the lab opened their link on. */
  key: z.string().optional(),
  /** When a model played them: how it went. */
  played: playedSchema.optional(),
});
export type PracticePerson = z.output<typeof practicePersonSchema>;

/** What the lab keeps of a practice company: which key it plays, and everyone on it. */
export const practiceSchema = z.object({
  id: z.string(),
  key: z.string(),
  locale: interviewLocaleSchema,
  made: z.string(),
  /** The team lead the lab added, who talked first, played by a model. */
  lead: z.object({ id: z.string(), name: z.string() }),
  people: z.array(practicePersonSchema),
  /** How the local core reached its models when it was made. */
  via: labViaSchema,
});
export type Practice = z.output<typeof practiceSchema>;

/** Why a practice company can't be made or used. */
export class PracticeError extends Error {
  override name = "PracticeError";
}

/** Every team id of a practice company starts so: the roster is the lab's to replace. */
const teamPrefix = "practice-";

const fileOf = (practice: Pick<Practice, "id" | "key">): string =>
  path.join(folderOf("out", practice.key), practice.id, "practice.json");

/** Keeps what the lab knows of a practice company. */
export const keepPractice = (practice: Practice): string =>
  keepJson(fileOf(practice), practice);

/** The practice companies kept in `folder`, newest first. */
const practicesIn = (folder: string): Practice[] =>
  existsSync(folder)
    ? readdirSync(folder).flatMap(
        (id) =>
          keptJson(path.join(folder, id, "practice.json"), practiceSchema) ?? []
      )
    : [];

/** Every practice company kept, the open ones and, with `LAB_HIDDEN`, the hidden ones; newest first. */
export const practices = (): Practice[] => {
  const hidden =
    process.env.LAB_HIDDEN === undefined
      ? []
      : practicesIn(path.join(hiddenFolder(), "out"));
  return [...practicesIn(openFolder("out")), ...hidden].toSorted((a, b) =>
    b.made.localeCompare(a.made)
  );
};

/** The practice company named, by its id or its end, or the newest. */
export const practiceNamed = (named: string | undefined): Practice => {
  const all = practices();
  const found =
    named === undefined
      ? all[0]
      : all.find((each) => each.id === named || each.id.endsWith(named));
  if (found === undefined) {
    throw new PracticeError(
      all.length === 0
        ? "There is no practice company yet: `vp run lab practice 01`."
        : `There is no practice company ${named ?? ""}. There are: ${all.map((each) => each.id).join(", ")}.`
    );
  }
  return found;
};

/** The team most of the key's people are in: what the practice team is called. */
const teamNameOf = (key: AnswerKey): string => {
  const count = new Map<string, number>();
  for (const employee of key.employees) {
    const team = key.roles[employee.role]?.team ?? "Team";
    count.set(team, (count.get(team) ?? 0) + 1);
  }
  return [...count].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? "Team";
};

/** The roster of a practice company: the lead the lab adds, and everyone in the key. */
const rosterOf = (
  key: AnswerKey,
  id: string,
  lead: string
): { roster: Roster; leadId: string; people: PracticePerson[] } => {
  const team = `${teamPrefix}${id}`;
  const leadId = `${id}-lead`;
  const people = key.employees.map((employee) => ({
    id: `${id}-${employee.id.toLowerCase()}`,
    employee: employee.id,
    name: employee.name,
  }));
  return {
    roster: {
      teams: [
        { id: team, name: teamNameOf(key), lead: leadId, does: "", off: false },
      ],
      people: [
        {
          id: leadId,
          name: lead,
          email: "",
          team,
          title: "Team lead",
          away: false,
        },
        ...key.employees.map((employee, at) => ({
          id: people[at]?.id ?? employee.id,
          name: employee.name,
          email: "",
          team,
          title: roleName(key, employee.role),
          away: false,
        })),
      ],
    },
    leadId,
    people,
  };
};

/** Refuses to replace an onboarding on the local core that isn't the lab's. */
const ownsOnboarding = async (core: Core): Promise<void> => {
  const { roster } = await core.session.api.onboarding.view();
  const theirs = (roster?.teams ?? []).filter(
    (team) => !team.id.startsWith(teamPrefix)
  );
  if (theirs.length > 0) {
    throw new PracticeError(
      "The local core holds an onboarding that isn't the lab's, and a practice company would replace it. Run the lab on a stack of its own: stop `vp run dev`, start it again with DEV_PERSIST_TO=.wrangler/lab, and run the lab with the same DEV_PERSIST_TO."
    );
  }
};

/** How long the lab waits for the team's map, and how often it looks. */
const mapWaitMs = 5 * 60_000;
const mapLookMs = 5000;

/** Waits until every employee's link is out: the team's map is drawn. */
const linksOut = async (core: Core, count: number): Promise<void> => {
  const until = Date.now() + mapWaitMs;
  while (Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- one look at a time
    const { out } = await core.session.api.onboardingStaff.agreements();
    if (out >= count) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- waits before it looks again
    await sleep(mapLookMs);
  }
  throw new PracticeError(
    "The team's map wasn't drawn in five minutes: look at the onboarding's log as staff."
  );
};

/** An asker bound to the local core: what a player or the judge asks a model with. */
export const askerOf =
  (core: Core): Asker =>
  async (call) =>
    await ask(core, call);

/** The role cards of a practice company, as text, each with its link. Never for a hidden key. */
export const keepCards = (
  practice: Practice,
  key: AnswerKey,
  links: ReadonlyMap<string, string>
): string[] => {
  if (isHidden(key.id)) {
    return [];
  }
  return practice.people.flatMap((person) => {
    const employee = key.employees.find((each) => each.id === person.employee);
    if (employee === undefined) {
      return [];
    }
    const card = roleCardOf(key, employee, practice.lead.name);
    const link = links.get(person.id);
    return [
      keepText(
        path.join(
          folderOf("out", key.id),
          practice.id,
          "cards",
          `${person.id}.txt`
        ),
        `${cardText(card, link === undefined ? undefined : new URL(link, origin).href)}\n`
      ),
    ];
  });
};

/** Makes a practice company of `key` on the local core, and lets its lead talk. */
export const makePractice = async (
  core: Core,
  key: AnswerKey,
  locale: InterviewLocale,
  log: (line: string) => void
): Promise<Practice> => {
  await ownsOnboarding(core);
  const id = `${key.id}-${randomBytes(2).toString("hex")}`;
  const lead = leadNameFor(key);
  const { roster, leadId, people } = rosterOf(key, id, lead);
  const { api } = core.session;
  log(
    isHidden(key.id)
      ? `Making a hidden practice company (${id}), in ${locale}`
      : `Making ${key.company.name} (practice ${id}), in ${locale}`
  );
  await api.organization.update({ name: key.company.name.slice(0, 80) });
  await api.onboarding.saveRoster(roster);
  await api.onboarding.savePlan({
    start: new Date().toISOString().slice(0, 10),
    days: 14,
  });
  await api.onboardingStaff.resume();
  await api.onboardingStaff.setAgreements({
    processing: true,
    assessment: true,
    council: "none",
  });
  const practice: Practice = {
    id,
    key: key.id,
    locale,
    made: new Date().toISOString(),
    lead: { id: leadId, name: lead },
    people,
    via: core.via,
  };
  keepPractice(practice);

  log("Its team lead talks first, played by a model");
  const links = await linksOf(core);
  const leadLink = links.get(leadId);
  if (leadLink === undefined) {
    throw new PracticeError("The lead has no link.");
  }
  await playInterview(
    linkOn(leadLink),
    modelPlayer(askerOf(core), lead, leadSystem(key, lead, locale)),
    { locale }
  );

  log("Waiting for the team's map, drawn from what the lead agreed to");
  await linksOut(core, roster.people.length);
  keepCards(practice, key, await linksOf(core));
  return practice;
};

/** Where a practice company's role cards are. */
export const cardsFolder = (practice: Practice): string =>
  path.join(folderOf("out", practice.key), practice.id, "cards");
