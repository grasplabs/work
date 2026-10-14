import { rosterSchema } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import {
  csvRows,
  exampleList,
  StaffListError,
  staffListOf,
} from "./staff-list.ts";

// From the prototype's `lib/staff-list.test.ts`, and that what it reads is
// a roster core takes.

const leadName = (list: ReturnType<typeof staffListOf>): string | undefined =>
  list.roster.people.find((person) => person.id === list.roster.teams[0]?.lead)
    ?.name;

describe("a staff list as rows", () => {
  it("reads commas, semicolons or tabs, whichever the first line uses, with quoted cells", () => {
    expect(
      csvRows(
        'Naam;E-mail;Afdeling\r\n"Bakker, Daan";daan@x.nl;Klantenservice\r\n'
      )
    ).toStrictEqual([
      ["Naam", "E-mail", "Afdeling"],
      ["Bakker, Daan", "daan@x.nl", "Klantenservice"],
    ]);
    expect(csvRows("Name\tTeam\nLisa\tService")).toStrictEqual([
      ["Name", "Team"],
      ["Lisa", "Service"],
    ]);
    expect(
      csvRows('﻿Name,Note\nTim,"said ""hi""\nthen left"\n\n')
    ).toStrictEqual([
      ["Name", "Note"],
      ["Tim", 'said "hi"\nthen left'],
    ]);
  });
});

describe("the teams and people in a staff list", () => {
  it("finds its columns by their headings, in any language and order, under a title row", () => {
    const list = staffListOf(
      [
        ["Medewerkerslijst oktober"],
        ["Afdeling", "Voornaam", "Achternaam", "Functie", "E-mailadres"],
        [
          "Klantenservice",
          "Daan",
          "Bakker",
          "Teamleider klantenservice",
          "Daan@Rivierdal.nl",
        ],
        ["Klantenservice", "Lisa", "Jansen", "Medewerker", "lisa@rivierdal.nl"],
        ["", "Anne", "Visser", "Directeur", "anne@rivierdal.nl"],
        ["Klantenservice", "", "", "", ""],
      ],
      "Overig"
    );
    expect(list.roster.teams.map((team) => team.name)).toStrictEqual([
      "Klantenservice",
      "Overig",
    ]);
    expect(
      list.roster.people.map((person) => [
        person.name,
        person.email,
        person.title,
      ])
    ).toStrictEqual([
      ["Daan Bakker", "daan@rivierdal.nl", "Teamleider klantenservice"],
      ["Lisa Jansen", "lisa@rivierdal.nl", "Medewerker"],
      ["Anne Visser", "anne@rivierdal.nl", "Directeur"],
    ]);
    expect(list.skipped).toBe(1);
    // The lead by their job, when nothing else says it.
    expect(leadName(list)).toBe("Daan Bakker");
    expect(list.leadsFrom).toBe("title");
  });

  it("takes the lead the list names, before anything else", () => {
    const list = staffListOf(
      [
        ["Name", "Email", "Team", "Job title", "Team lead"],
        ["Lisa Jansen", "lisa@x.com", "Service", "Manager of nothing", ""],
        ["Daan Bakker", "daan@x.com", "Service", "Agent", "yes"],
      ],
      "Other"
    );
    expect(leadName(list)).toBe("Daan Bakker");
    expect(list.leadsFrom).toBe("column");
  });

  it("takes the one most of a team reports to, by name or email", () => {
    const list = staffListOf(
      [
        ["Name", "Department", "Reports to"],
        ["Mark de Vries", "Mortgage advice", "anne visser"],
        ["Emma Smit", "Mortgage advice", "Mark de Vries"],
        ["Noor Bos", "Mortgage advice", "mark de vries"],
      ],
      "Other"
    );
    expect(leadName(list)).toBe("Mark de Vries");
    expect(list.leadsFrom).toBe("manager");
  });

  it('reads a "leidinggevende" column as a name, or as a yes', () => {
    const named = staffListOf(
      [
        ["Naam", "Team", "Leidinggevende"],
        ["Mark de Vries", "Hypotheken", ""],
        ["Emma Smit", "Hypotheken", "Mark de Vries"],
      ],
      "Overig"
    );
    expect(leadName(named)).toBe("Mark de Vries");
    const marked = staffListOf(
      [
        ["Naam", "Team", "Leidinggevende"],
        ["Mark de Vries", "Hypotheken", "ja"],
        ["Emma Smit", "Hypotheken", "nee"],
      ],
      "Overig"
    );
    expect(leadName(marked)).toBe("Mark de Vries");
  });

  it("leaves a lead open where the list does not say, and keeps everyone once", () => {
    const list = staffListOf(
      [
        ["Name", "Email", "Team"],
        ["Lisa Jansen", "lisa@x.com", "Service"],
        ["Lisa Jansen", "LISA@x.com", "Service"],
        ["Tim de Groot", "not an email", "Service"],
      ],
      "Other"
    );
    expect(list.roster.people).toHaveLength(2);
    expect(list.roster.people[1]?.email).toBe("");
    expect(list.roster.teams[0]?.lead).toBeNull();
    expect(list.leadsFrom).toBe("none");
  });

  it("is refused without headings it knows, or without anyone in it", () => {
    expect(() =>
      staffListOf(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        "Other"
      )
    ).toThrow(StaffListError);
    expect(() => staffListOf([["Name", "Team"]], "Other")).toThrow(
      StaffListError
    );
  });

  it("reads its own example, as a roster core takes", () => {
    const list = staffListOf(csvRows(exampleList), "Other");
    expect(list.roster.people).toHaveLength(2);
    expect(list.leadsFrom).toBe("column");
    expect(rosterSchema.safeParse(list.roster).success).toBeTruthy();
  });
});
