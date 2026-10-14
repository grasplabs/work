import type {
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

/** The rows in a CSV file: the separator is whichever of comma, semicolon or tab the first line uses most; quotes as CSV writes them. */
export const csvRows = (text: string): string[][] => {
  const lines = text.replace(byteOrderMark, "");
  const [head = ""] = lines.split(lineBreak, 1);
  const separator =
    [",", ";", "\t"]
      .map((each) => ({ each, count: head.split(each).length }))
      .toSorted((a, b) => b.count - a.count)[0]?.each ?? ",";
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

/** A person's id, from their email, or their name and team where there is no email: the same person keeps it when the list comes in again. */
const personIdOf = (person: {
  email: string;
  name: string;
  team: string;
}): string => {
  const email = person.email.trim().toLowerCase();
  return `p-${hashOf(email === "" ? `${person.name.trim().toLowerCase()}|${person.team}` : email)}`;
};

/** A team's id, from its name. */
const teamIdOf = (name: string): string => `t-${slugOf(name)}`;

/** What a staff list came to: the teams and their people, how many rows were left out, and whether its leads were said or guessed. */
export interface StaffList {
  roster: { teams: RosterTeam[]; people: RosterPerson[] } & RosterInput;
  /** Rows without a name, left out. */
  skipped: number;
  /** How the leads were found: said in a column, by who reports to whom, by job, or not at all. */
  leadsFrom: "column" | "manager" | "title" | "none";
}

/** Why a staff list could not be read: no headings Grasp knows, or nobody in it. */
export class StaffListError extends Error {
  readonly reason: "headings" | "empty";

  constructor(reason: "headings" | "empty") {
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
    const team = teamIdOf(teamName);
    if (!teams.has(team)) {
      teams.set(team, {
        id: team,
        name: teamName,
        lead: null,
        does: "",
        off: false,
      });
    }
    const email = cell(row, "email").toLowerCase();
    const person: RosterPerson = {
      id: personIdOf({ email, name, team }),
      name,
      email: emailSchema.safeParse(email).success ? email : "",
      team,
      title: cell(row, "title").slice(0, textMost),
      away: false,
    };
    if (people.some((each) => each.id === person.id)) {
      continue;
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

/** An example staff list to fill in, as CSV: the headings Grasp reads, and two rows. */
export const exampleList = [
  "Name,Email,Team,Job title,Team lead",
  "Daan Bakker,daan@example.com,Customer service,Team lead customer service,yes",
  "Lisa Jansen,lisa@example.com,Customer service,Customer service agent,",
].join("\n");
