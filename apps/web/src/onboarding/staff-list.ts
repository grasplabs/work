import {
  onboardingPeopleMax,
  onboardingTeamsMax,
} from "@grasp-os/shared/onboarding";
import type {
  Roster,
  RosterInput,
  RosterPerson,
  RosterTeam,
} from "@grasp-os/shared/onboarding";
import { z } from "zod";

// A company's staff list, as its admin shares it in the onboarding: a CSV
// or Excel file with a row per person. It is read in the browser and only
// names, email addresses, teams and jobs are kept: enough to know who to
// talk to and who leads which team. Its columns are found by their
// headings, in any of the languages Grasp speaks, wherever they are. Pure.
// From the prototype's `lib/staff-list.ts`.

type Column =
  | "name"
  | "first"
  | "last"
  | "email"
  | "team"
  | "title"
  | "lead"
  | "manager";

const columns: readonly Column[] = [
  "name",
  "first",
  "last",
  "email",
  "team",
  "title",
  "lead",
  "manager",
];

/** What a heading says, in the five languages, for each column Grasp reads. Matched as whole words. */
const headings: Record<Column, RegExp> = {
  name: /^(?:full ?name|name|naam|volledige naam|nom complet|nom et prénom|nombre completo|nombre y apellidos|vollständiger name|name, vorname|medewerker|employee|mitarbeiter|employé|empleado)$/iu,
  first:
    /^(?:first ?name|given name|voornaam|roepnaam|vorname|prénom|prenom|nombre)$/iu,
  last: /^(?:last ?name|surname|family name|achternaam|nachname|familienname|nom de famille|nom|apellidos?)$/iu,
  email:
    /^(?:e-?mail(?: ?address)?|work e-?mail|mail|e-?mailadres|werkmail|courriel|adresse e-?mail|correo(?: electrónico)?|e-?mail-adresse)$/iu,
  team: /^(?:team|teams|department|dept\.?|afdeling|teamnaam|abteilung|bereich|service|département|departement|équipe|equipe|departamento|equipo|area|área|unit|business unit|group|groep)$/iu,
  title:
    /^(?:job ?title|title|role|position|function|functie|functienaam|rol|stellenbezeichnung|funktion|rolle|fonction|poste|intitulé du poste|puesto|cargo)$/iu,
  lead: /^(?:lead|team ?lead|is lead|leads team|teamleider|leidinggevende\??|is leidinggevende|manager\??|is manager|führungskraft|teamleiter|responsable|chef d['’]équipe|jefe de equipo|líder)$/iu,
  manager:
    /^(?:manager|reports to|line manager|leidinggevende|manager naam|vorgesetzte[r]?|n\+1|supérieur|responsable directo|jefe|superior)$/iu,
};

/** A job that says its holder leads a team, in any of the five languages. */
const leadsByTitle =
  /\b(?:team ?lead(?:er)?|lead|head of|head|manager|teamleider|teamleidster|leidinggevende|hoofd|afdelingshoofd|teamleiter|abteilungsleiter|leiter|leiterin|chef|responsable|jefe|jefa|director|directeur|coördinator|coordinator|supervisor)\b/iu;
/** A cell that says yes. */
const yes = /^(?:yes|y|ja|j|x|✓|true|1|oui|sí|si)$/iu;
const byteOrderMark = /^﻿/u;
const lineBreak = /\r?\n/u;
const spaces = /\s+/gu;
const accents = /[̀-ͯ]/gu;
const notSlug = /[^a-z0-9]+/gu;
const slugEnds = /^-+|-+$/gu;
const trailingDashes = /-+$/u;

/** The longest name, team and job the onboarding keeps. */
const textMost = 80;
const emailSchema = z.email().max(120);

const quotedText = /"(?:[^"]|"")*"/gu;
/** How many of its first lines a CSV file's separator is told from: a title line above the headings is outweighed by the rows below it. */
const separatorLines = 10;

/** Whichever of comma, semicolon or tab the first lines with words in them use most, outside quotes. */
const separatorOf = (text: string): string => {
  const lines = text
    .split(lineBreak, 200)
    .filter((line) => line.trim() !== "")
    .slice(0, separatorLines)
    .map((line) => line.replaceAll(quotedText, ""));
  return (
    [",", ";", "\t"]
      .map((each) => ({
        each,
        count: lines.reduce(
          (sum, line) => sum + line.split(each).length - 1,
          0
        ),
      }))
      .toSorted((a, b) => b.count - a.count)[0]?.each ?? ","
  );
};

/** The rows in a CSV file: the separator is whichever of comma, semicolon or tab its first lines use most; quotes as CSV writes them. */
export const csvRows = (text: string): string[][] => {
  const lines = text.replace(byteOrderMark, "");
  const separator = separatorOf(lines);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < lines.length; at += 1) {
    const char = lines[at];
    if (quoted) {
      if (char === '"' && lines[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && lines[at + 1] === "\n") {
        at += 1;
      }
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((each) => each.some((value) => value !== ""));
};

/** Which column holds what, by position, from a row of headings; none when it is not the heading row. */
const columnsOf = (row: string[]): Partial<Record<Column, number>> | null => {
  const found: Partial<Record<Column, number>> = {};
  for (const [index, heading] of row.entries()) {
    const said = heading.replaceAll(spaces, " ").trim();
    for (const column of columns) {
      // "Leidinggevende" heads both a yes-or-no column and a name column: a lead column only when the other is there.
      const ambiguous =
        column === "lead" &&
        headings.manager.test(said) &&
        found.manager === undefined;
      if (
        found[column] === undefined &&
        headings[column].test(said) &&
        !ambiguous
      ) {
        found[column] = index;
        break;
      }
    }
  }
  const named = found.name !== undefined || found.first !== undefined;
  return named && (found.team !== undefined || found.email !== undefined)
    ? found
    : null;
};

/** Words as an id: lower case, letters and digits, a dash between. */
const slugOf = (words: string): string =>
  words
    .normalize("NFKD")
    .replaceAll(accents, "")
    .toLowerCase()
    .replaceAll(notSlug, "-")
    .replaceAll(slugEnds, "")
    .slice(0, 36)
    .replace(trailingDashes, "") || "team";

/** A number from words, always the same for the same words: for ids that stay put. */
const hashOf = (words: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < words.length; index += 1) {
    // oxlint-disable-next-line no-bitwise -- FNV-1a
    hash ^= words.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  // oxlint-disable-next-line no-bitwise -- unsigned
  return (hash >>> 0).toString(36);
};

/** A person's id, from their email, or their name and team where there is no email address (or none that is one): the same person keeps it when the list comes in again. */
const personIdOf = (person: {
  email: string;
  name: string;
  team: string;
}): string => {
  const email = person.email.trim().toLowerCase();
  return `p-${hashOf(email === "" ? `${person.name.trim().toLowerCase()}|${person.team}` : email)}`;
};

/** A team's id, from its name: the same name gets the same id when the list comes in again. */
const teamIdOf = (name: string): string => `t-${slugOf(name)}`;

/**
 * The ids of the teams in one list, by name. Names that only differ in
 * case are one team. Names that come to the same id ("Sales / North" and
 * "Sales - North", or two that share their first 36 letters) are two
 * teams: the one that comes first in the list keeps the id, the next gets
 * `-2`, and so on, so a list read again gives every team the id it had.
 */
const teamIds = () => {
  const byName = new Map<string, string>();
  const taken = new Set<string>();
  return (name: string): { id: string; fresh: boolean } => {
    const key = name.toLowerCase();
    const known = byName.get(key);
    if (known !== undefined) {
      return { id: known, fresh: false };
    }
    const base = teamIdOf(name);
    let id = base;
    for (let count = 2; taken.has(id); count += 1) {
      id = `${base}-${count}`;
    }
    byName.set(key, id);
    taken.add(id);
    return { id, fresh: true };
  };
};

/** What a staff list came to: the teams and their people, how many rows were left out, and whether its leads were said or guessed. */
export interface StaffList {
  roster: { teams: RosterTeam[]; people: RosterPerson[] } & RosterInput;
  /** Rows without a name, left out. */
  skipped: number;
  /** How the leads were found: said in a column, by who reports to whom, by job, or not at all. */
  leadsFrom: "column" | "manager" | "title" | "none";
}

/** Why a staff list could not be read: no headings Grasp knows, nobody in it, or more people or teams than an onboarding takes. */
export class StaffListError extends Error {
  readonly reason: "headings" | "empty" | "large";

  constructor(reason: "headings" | "empty" | "large") {
    super(reason);
    this.name = "StaffListError";
    this.reason = reason;
  }
}

interface Said {
  person: RosterPerson;
  lead: boolean;
  manager: string;
}

/** The lead of `team`: the one the list marks, else the one most report to, else the one whose job says so. */
const leadOf = (
  mine: Said[]
): { id: string; from: StaffList["leadsFrom"] } | null => {
  const marked = mine.find((each) => each.lead);
  if (marked !== undefined) {
    return { id: marked.person.id, from: "column" };
  }
  // The one most of the team reports to, when they are in the team themselves.
  const reportsTo = new Map<string, number>();
  for (const each of mine) {
    if (each.manager !== "") {
      reportsTo.set(each.manager, (reportsTo.get(each.manager) ?? 0) + 1);
    }
  }
  const [top] = [...reportsTo.entries()].toSorted((a, b) => b[1] - a[1]);
  const manager =
    top === undefined
      ? undefined
      : mine.find(
          (each) =>
            each.person.name.toLowerCase() === top[0] ||
            each.person.email === top[0]
        );
  if (manager !== undefined) {
    return { id: manager.person.id, from: "manager" };
  }
  const titled = mine.filter((each) => leadsByTitle.test(each.person.title));
  const [only] = titled;
  return titled.length === 1 && only !== undefined
    ? { id: only.person.id, from: "title" }
    : null;
};

const rank = { none: 0, title: 1, manager: 2, column: 3 } as const;

/**
 * The teams and their people in a staff list. People without a team go in
 * one named `noTeam`. A team's lead is the one the list says leads it;
 * else the one most of the team reports to; else the one whose job says
 * they lead. The company's admin checks it on the next screen.
 */
export const staffListOf = (rows: string[][], noTeam: string): StaffList => {
  const at = rows.slice(0, 10).findIndex((row) => columnsOf(row) !== null);
  const found = at === -1 ? null : columnsOf(rows[at] ?? []);
  if (found === null) {
    throw new StaffListError("headings");
  }
  const cell = (row: string[], column: Column): string => {
    const index = found[column];
    return index === undefined
      ? ""
      : (row[index] ?? "").replaceAll(spaces, " ").trim();
  };
  const teams = new Map<string, RosterTeam>();
  const teamIdIn = teamIds();
  const people: RosterPerson[] = [];
  const said: Said[] = [];
  let skipped = 0;
  for (const row of rows.slice(at + 1)) {
    const name = (
      cell(row, "name") ||
      [cell(row, "first"), cell(row, "last")].filter(Boolean).join(" ")
    ).slice(0, textMost);
    if (name === "") {
      skipped += 1;
      continue;
    }
    const teamName = (cell(row, "team") || noTeam).slice(0, textMost);
    const { id: team, fresh } = teamIdIn(teamName);
    if (fresh) {
      if (teams.size >= onboardingTeamsMax) {
        throw new StaffListError("large");
      }
      teams.set(team, {
        id: team,
        name: teamName,
        lead: null,
        does: "",
        off: false,
      });
    }
    // Only an email address is one: "n/a" or "-" in many rows would make them all one person.
    const written = cell(row, "email").toLowerCase();
    const email = emailSchema.safeParse(written).success ? written : "";
    const person: RosterPerson = {
      id: personIdOf({ email, name, team }),
      name,
      email,
      team,
      title: cell(row, "title").slice(0, textMost),
      away: false,
    };
    if (people.some((each) => each.id === person.id)) {
      continue;
    }
    if (people.length >= onboardingPeopleMax) {
      throw new StaffListError("large");
    }
    people.push(person);
    // A "leidinggevende" column holds a name in one company and a yes in the next: a yes means they lead.
    said.push({
      person,
      lead: yes.test(cell(row, "lead")) || yes.test(cell(row, "manager")),
      manager: cell(row, "manager").toLowerCase(),
    });
  }
  if (people.length === 0) {
    throw new StaffListError("empty");
  }
  let leadsFrom: StaffList["leadsFrom"] = "none";
  for (const team of teams.values()) {
    const lead = leadOf(said.filter((each) => each.person.team === team.id));
    if (lead !== null) {
      team.lead = lead.id;
      if (rank[lead.from] > rank[leadsFrom]) {
        leadsFrom = lead.from;
      }
    }
  }
  return { roster: { teams: [...teams.values()], people }, skipped, leadsFrom };
};

/**
 * A staff list read again, with what the admin set on the one before kept
 * for the teams and people in both, by id: a team they switched off stays
 * off, someone marked away stays away, a lead they picked stays the lead
 * while still in that team, and what a team does stays said.
 */
export const withSaved = (
  roster: StaffList["roster"],
  saved: Roster | null
): StaffList["roster"] => {
  if (saved === null) {
    return roster;
  }
  const savedTeams = new Map(saved.teams.map((team) => [team.id, team]));
  const savedPeople = new Map(
    saved.people.map((person) => [person.id, person])
  );
  const teamOf = new Map(
    roster.people.map((person) => [person.id, person.team])
  );
  return {
    teams: roster.teams.map((team) => {
      const before = savedTeams.get(team.id);
      if (before === undefined) {
        return team;
      }
      const lead =
        before.lead !== null && teamOf.get(before.lead) === team.id
          ? before.lead
          : team.lead;
      return {
        ...team,
        lead,
        off: before.off,
        does: team.does === "" ? before.does : team.does,
      };
    }),
    people: roster.people.map((person) => {
      const before = savedPeople.get(person.id);
      return before === undefined ? person : { ...person, away: before.away };
    }),
  };
};

/** An example staff list to fill in, as CSV: the headings Grasp reads, and two rows. */
export const exampleList = [
  "Name,Email,Team,Job title,Team lead",
  "Daan Bakker,daan@example.com,Customer service,Team lead customer service,yes",
  "Lisa Jansen,lisa@example.com,Customer service,Customer service agent,",
].join("\n");
