import {
  onboardingPeopleMax,
  onboardingTeamsMax,
  rosterSchema,
} from "@grasp-os/shared/onboarding";
import type { Roster } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import {
  csvRows,
  exampleList,
  StaffListError,
  staffListOf,
  withSaved,
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

  it("tells the separator from the rows, not a title line above the headings", () => {
    expect(
      csvRows(
        'Staff list, October 2026\nNaam;E-mail;Afdeling\n"Bakker, Daan";daan@x.nl;Verkoop\nLisa Jansen;lisa@x.nl;Service\n'
      )
    ).toStrictEqual([
      ["Staff list, October 2026"],
      ["Naam", "E-mail", "Afdeling"],
      ["Bakker, Daan", "daan@x.nl", "Verkoop"],
      ["Lisa Jansen", "lisa@x.nl", "Service"],
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

  it("keeps teams whose names come to the same id apart, with ids that stay put", () => {
    const long = "Customer service and claims handling for the north";
    const rows = [
      ["Name", "Team"],
      ["Ada", "Sales / North"],
      ["Bo", "Sales - North"],
      ["Cas", "sales / north"],
      ["Dee", `${long} region`],
      ["Eli", `${long} and east`],
      ["Fay", "Ops"],
    ];
    const list = staffListOf(rows, "Other");
    expect(list.roster.teams.map((team) => [team.id, team.name])).toStrictEqual(
      [
        ["t-sales-north", "Sales / North"],
        ["t-sales-north-2", "Sales - North"],
        ["t-customer-service-and-claims-handling", `${long} region`],
        ["t-customer-service-and-claims-handling-2", `${long} and east`],
        ["t-ops", "Ops"],
      ]
    );
    // Names that only differ in case are one team.
    expect(
      list.roster.people.find((person) => person.name === "Cas")?.team
    ).toBe("t-sales-north");
    expect(rosterSchema.safeParse(list.roster).success).toBeTruthy();
    // Read again, every team and person has the id it had.
    expect(staffListOf(rows, "Other").roster).toStrictEqual(list.roster);
  });

  it("tells people apart by name and team where their email address is no email address", () => {
    const list = staffListOf(
      [
        ["Name", "Email", "Team"],
        ["Lisa Jansen", "N/A", "Service"],
        ["Tim de Groot", "N/A", "Service"],
        ["Anne Visser", "-", "Service"],
        ["Anne Visser", "", "Sales"],
      ],
      "Other"
    );
    expect(
      list.roster.people.map((person) => [person.name, person.email])
    ).toStrictEqual([
      ["Lisa Jansen", ""],
      ["Tim de Groot", ""],
      ["Anne Visser", ""],
      ["Anne Visser", ""],
    ]);
    expect(rosterSchema.safeParse(list.roster).success).toBeTruthy();
  });

  it("is refused with more people or teams than an onboarding takes", () => {
    const people = Array.from({ length: onboardingPeopleMax + 1 }, (_, at) => [
      `Person ${at}`,
      `p${at}@x.com`,
      "Service",
    ]);
    const teams = Array.from({ length: onboardingTeamsMax + 1 }, (_, at) => [
      `Person ${at}`,
      `p${at}@x.com`,
      `Team ${at}`,
    ]);
    for (const rows of [people, teams]) {
      expect(() =>
        staffListOf([["Name", "Email", "Team"], ...rows], "Other")
      ).toThrow(expect.objectContaining({ reason: "large" }));
    }
    expect(
      staffListOf(
        [["Name", "Email", "Team"], ...people.slice(0, onboardingPeopleMax)],
        "Other"
      ).roster.people
    ).toHaveLength(onboardingPeopleMax);
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

describe("a staff list shared again", () => {
  const rows = [
    ["Name", "Email", "Team", "Team lead"],
    ["Lea Bakker", "lea@x.com", "Sales", "yes"],
    ["Sam Visser", "sam@x.com", "Sales", ""],
    ["Ona Smit", "ona@x.com", "Ops", ""],
    ["Kim Bos", "kim@x.com", "Board", ""],
  ];
  const first = staffListOf(rows, "Other").roster;
  const idOf = (name: string): string =>
    first.people.find((person) => person.name === name)?.id ?? "";
  const teamOf = (name: string): string =>
    first.teams.find((team) => team.name === name)?.id ?? "";
  // As the admin left it: Board switched off, Sam away, and Sam leading Sales.
  const saved: Roster = rosterSchema.parse({
    teams: first.teams.map((team) => ({
      ...team,
      off: team.name === "Board",
      lead: team.name === "Sales" ? idOf("Sam Visser") : team.lead,
      does: team.name === "Ops" ? "Plans the routes" : "",
    })),
    people: first.people.map((person) => ({
      ...person,
      away: person.name === "Sam Visser",
    })),
  });

  it("keeps who takes part, who is away, the leads picked and what a team does", () => {
    const again = withSaved(
      staffListOf([...rows, ["Noor Jansen", "noor@x.com", "Ops", ""]], "Other")
        .roster,
      saved
    );
    expect(
      again.teams.map((team) => [team.name, team.off, team.lead, team.does])
    ).toStrictEqual([
      ["Sales", false, idOf("Sam Visser"), ""],
      ["Ops", false, null, "Plans the routes"],
      ["Board", true, null, ""],
    ]);
    expect(
      again.people.map((person) => [person.name, person.away])
    ).toStrictEqual([
      ["Lea Bakker", false],
      ["Sam Visser", true],
      ["Ona Smit", false],
      ["Kim Bos", false],
      ["Noor Jansen", false],
    ]);
    expect(rosterSchema.safeParse(again).success).toBeTruthy();
  });

  it("takes the list's own lead where the one picked moved to another team", () => {
    const moved = rows.map((row) =>
      row[0] === "Sam Visser" ? ["Sam Visser", "sam@x.com", "Ops", ""] : row
    );
    const again = withSaved(staffListOf(moved, "Other").roster, saved);
    expect(again.teams.find((team) => team.id === teamOf("Sales"))?.lead).toBe(
      idOf("Lea Bakker")
    );
    expect(rosterSchema.safeParse(again).success).toBeTruthy();
  });

  it("is the list itself when nothing was saved before", () => {
    expect(withSaved(first, null)).toStrictEqual(first);
  });
});
